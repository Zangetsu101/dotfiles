import assert from "node:assert/strict"
import test from "node:test"
import backgroundAgentExtension from "../extensions/background-agent.ts"
import backgroundMonitorExtension from "../extensions/background-monitor.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"

test("real background extensions create, discover, complete, retain, attach, and clean tasks through the tmux seam", async () => {
  const previousPane = process.env.TMUX_PANE
  const previousTmux = process.env.TMUX
  const previousAgentStatus = process.env.PI_BACKGROUND_AGENT_STATUS_FILE
  process.env.TMUX_PANE = "%owner"
  process.env.TMUX = "fake"
  delete process.env.PI_BACKGROUND_AGENT_STATUS_FILE
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux)
  const runtime = new FakePiRuntime()
  try {
    backgroundMonitorExtension(runtime.pi, { tasks, pollMs: 5, owner: "%owner" })
    await backgroundAgentExtension(runtime.pi, { tasks, tmux })

    const monitorResult = await runtime.execute("background_monitor", { command: "build", label: "build" })
    const agentResult = await runtime.execute("background_agent", { task: "review", label: "review" })
    assert.deepEqual(new Set(runtime.tools.keys()), new Set(["background_monitor", "background_agent"]))
    assert.deepEqual((await tasks.list("%owner")).map((task) => task.kind).sort(), ["agent", "monitor"])
    assert.equal(tmux.tasks().find((task) => task.target === monitorResult.details.target)?.retained, true)
    assert.equal(tmux.tasks().find((task) => task.target === agentResult.details.target)?.interactiveAfterCompletion, true)

    await tasks.attach((await tasks.list("%owner"))[1]!)
    assert.equal(tmux.attachedTarget, agentResult.details.target)
    await Promise.all([
      tmux.complete(monitorResult.details.target, "completed", "monitor stdout\nmonitor stderr"),
      tmux.complete(agentResult.details.target, "completed", "agent final output"),
    ])
    for (let attempt = 0; attempt < 50 && runtime.messages.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(runtime.messages.length, 2)
    assert.match(runtime.messages.find((message) => message.customType === "background-monitor")?.content ?? "", /monitor stdout\nmonitor stderr/)
    assert.match(runtime.messages.find((message) => message.customType === "background-agent")?.content ?? "", /agent final output/)
    assert.equal(tmux.tasks().find((task) => task.target === monitorResult.details.target)?.dead, true)
    assert.equal(tmux.tasks().find((task) => task.target === agentResult.details.target)?.dead, false)
    assert.deepEqual((await tasks.list("%owner")).map((task) => task.status).sort(), ["completed", "completed"])

    assert.equal(runtime.messages.filter((message) => message.customType === "background-monitor").length, 1)
    assert.equal(runtime.messages.filter((message) => message.customType === "background-agent").length, 1)
  } finally {
    await runtime.emit("session_shutdown", { reason: "reload" })
    if (previousPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = previousPane
    if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux
    if (previousAgentStatus === undefined) delete process.env.PI_BACKGROUND_AGENT_STATUS_FILE; else process.env.PI_BACKGROUND_AGENT_STATUS_FILE = previousAgentStatus
  }
})

test("agent completion racing extension replacement produces one durable follow-up", async () => {
  const previousPane = process.env.TMUX_PANE
  const previousAgentStatus = process.env.PI_BACKGROUND_AGENT_STATUS_FILE
  process.env.TMUX_PANE = "%owner"
  delete process.env.PI_BACKGROUND_AGENT_STATUS_FILE
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux)
  const outgoing = new FakePiRuntime()
  const replacement = new FakePiRuntime()
  try {
    await backgroundAgentExtension(outgoing.pi, { tasks, tmux })
    const result = await outgoing.execute("background_agent", { task: "review", label: "review" })
    await backgroundAgentExtension(replacement.pi, { tasks, tmux })

    await tmux.complete(result.details.target, "completed", "durable result")
    for (let attempt = 0; attempt < 50 && outgoing.messages.length + replacement.messages.length < 1; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))

    assert.equal(outgoing.messages.length + replacement.messages.length, 1)
    assert.match((outgoing.messages[0] ?? replacement.messages[0]).content, /durable result/)
    assert.equal(tmux.hubs().length, 1)
  } finally {
    await outgoing.emit("session_shutdown", { reason: "reload" })
    await replacement.emit("session_shutdown", { reason: "reload" })
    if (previousPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = previousPane
    if (previousAgentStatus === undefined) delete process.env.PI_BACKGROUND_AGENT_STATUS_FILE; else process.env.PI_BACKGROUND_AGENT_STATUS_FILE = previousAgentStatus
  }
})

test("concurrent launches share an owner hub while different owners remain isolated", async () => {
  const tmux = new FakeTmuxProcessAdapter()
  const ownerTasks = new BackgroundTasks(tmux)
  const otherTasks = new BackgroundTasks(tmux)
  const ownerRuntime = new FakePiRuntime()
  const otherRuntime = new FakePiRuntime()
  backgroundMonitorExtension(ownerRuntime.pi, { tasks: ownerTasks, owner: "%owner" })
  backgroundMonitorExtension(otherRuntime.pi, { tasks: otherTasks, owner: "%other" })

  const [first, second, other] = await Promise.all([
    ownerRuntime.execute("background_monitor", { command: "printf '%s' 'one; two'", label: "same label" }),
    ownerRuntime.execute("background_monitor", { command: "printf '%s' 'three'", label: "same label" }),
    otherRuntime.execute("background_monitor", { command: "printf '%s' 'other'", label: "same label" }),
  ])

  assert.equal(tmux.hubs().length, 2)
  assert.equal(tmux.hubs().find((hub) => hub.owner === "%owner")?.tasks.length, 2)
  assert.equal(tmux.hubs().find((hub) => hub.owner === "%other")?.tasks.length, 1)
  assert.notEqual(first.details.target, second.details.target)
  assert.equal(new Set([first.details.target, second.details.target]).size, 2)
  assert.equal((await ownerTasks.list("%owner")).length, 2)
  assert.deepEqual((await otherTasks.list("%other")).map((task) => task.target), [other.details.target])
  await ownerRuntime.emit("session_shutdown", { reason: "reload" })
  await otherRuntime.emit("session_shutdown", { reason: "reload" })
})

test("discovery refreshes exact indexed targets and task commands navigate the selected duplicate", async () => {
  const previousPane = process.env.TMUX_PANE
  const previousTmux = process.env.TMUX
  process.env.TMUX_PANE = "%owner"
  process.env.TMUX = "fake"
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux)
  const runtime = new FakePiRuntime()
  try {
    backgroundMonitorExtension(runtime.pi, { tasks, owner: "%owner" })
    const first = await runtime.execute("background_monitor", { command: "one", label: "duplicate" })
    await runtime.execute("background_monitor", { command: "two", label: "duplicate" })

    const discovered = await tasks.list("%owner")
    assert.match(discovered[0]!.target, /:\d+$/)
    assert.deepEqual(await tasks.resolveReference("duplicate", "%owner"), { kind: "ambiguous" })
    assert.equal((await tasks.resolveReference(first.details.id, "%owner")).kind, "found")
    assert.equal((await tasks.resolveReference(discovered[0]!.target, "%owner")).kind, "found")

    const completions = runtime.commands.get("task").getArgumentCompletions("attach duplicate")
    assert.equal(completions.length, 2)
    assert.ok(completions.every((item: any) => item.description.includes(item.value.endsWith(first.details.id) ? discovered[0]!.target : discovered[1]!.target)))

    await runtime.commands.get("task").handler(`attach ${first.details.id}`, runtime.context)
    assert.equal(tmux.attachedTarget, discovered[0]!.target)
    await runtime.commands.get("task").handler("attach duplicate", runtime.context)
    assert.match(runtime.notifications.at(-1) ?? "", /Ambiguous/)
  } finally {
    await runtime.emit("session_shutdown", { reason: "reload" })
    if (previousPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = previousPane
    if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux
  }
})

test("termination and cleanup refresh selected windows without disturbing siblings or retaining an empty hub", async () => {
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux)
  const runtime = new FakePiRuntime()
  backgroundMonitorExtension(runtime.pi, { tasks, owner: "%owner" })

  const finished = await runtime.execute("background_monitor", { command: "finished", label: "finished" })
  const cancelled = await runtime.execute("background_monitor", { command: "cancelled", label: "cancelled" })
  const sibling = await runtime.execute("background_monitor", { command: "sibling", label: "sibling" })
  const stale = await tasks.list("%owner")

  await tmux.complete(finished.details.target, "completed")
  assert.equal(await tasks.cleanup(stale), 1)
  assert.deepEqual((await tasks.list("%owner")).map((task) => task.id), [cancelled.details.id, sibling.details.id])

  await tasks.terminate(stale.find((task) => task.id === cancelled.details.id)!)
  assert.equal(tmux.signalledTargets.at(-1), (await tasks.resolve(cancelled.details.id, "%owner"))?.target)
  assert.equal((await tasks.resolve(sibling.details.id, "%owner"))?.status, "running")
  assert.equal(tmux.hubs().length, 1)

  await tasks.cleanup(await tasks.list("%owner"))
  assert.equal((await tasks.list("%owner")).length, 1)
  await tmux.complete((await tasks.resolve(sibling.details.id, "%owner"))!.target, "completed")
  assert.equal(await tasks.cleanup(await tasks.list("%owner")), 1)
  assert.equal(tmux.hubs().length, 0)
  assert.deepEqual(tmux.tasks(), [])
  await runtime.emit("session_shutdown", { reason: "reload" })
})

test("legacy session tasks are visible cleanup-only and never managed as active work", async () => {
  const previousTmux = process.env.TMUX
  process.env.TMUX = "fake"
  const tmux = new FakeTmuxProcessAdapter()
  await tmux.run(["new-session", "-d", "-s", "pi-monitor-legacy", "-n", "legacy"])
  for (const [key, value] of Object.entries({ kind: "monitor", id: "old-one", label: "old build", status: "running", owner: "%owner", parent: "parent", cwd: "/repo", status_file: "/tmp/legacy-status" })) {
    await tmux.run(["set-option", "-t", "pi-monitor-legacy", `@pi_task_${key}`, value])
  }
  const tasks = new BackgroundTasks(tmux)
  const runtime = new FakePiRuntime()
  try {
    backgroundMonitorExtension(runtime.pi, { tasks, owner: "%owner", pollMs: 5 })
    const current = await runtime.execute("background_monitor", { command: "current", label: "current" })
    await runtime.emit("session_start")

    const listed = await tasks.list("%owner")
    assert.deepEqual(listed.map((task) => [task.id, task.storageMode]), [[current.details.id, "hub"], ["old-one", "legacy"]])
    await runtime.commands.get("task").handler("list", runtime.context)
    assert.match(runtime.notifications.at(-1) ?? "", /old-one  monitor  cleanup-only  old build/)
    assert.equal(runtime.messages.length, 0)

    await runtime.commands.get("task").handler("attach old-one", runtime.context)
    assert.match(runtime.notifications.at(-1) ?? "", /cleanup-only.*cannot be attached/i)
    assert.equal(tmux.attachedTarget, undefined)
    await runtime.commands.get("task").handler("terminate old-one", runtime.context)
    assert.match(runtime.notifications.at(-1) ?? "", /cleanup-only.*cannot be terminated/i)
    assert.deepEqual(tmux.signalledTargets, [])

    await runtime.commands.get("task").handler("clean old-one", runtime.context)
    assert.equal(tmux.sessions.has("pi-monitor-legacy"), false)
    assert.equal(tmux.sessions.has(current.details.target.split(":")[0]), true)
  } finally {
    await runtime.emit("session_shutdown", { reason: "reload" })
    if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux
  }
})

test("setup failures are reported and leave no advertised task or empty new hub", async () => {
  const tmux = new FakeTmuxProcessAdapter()
  tmux.failSetupFor = "@pi_task_label"
  const runtime = new FakePiRuntime()
  backgroundMonitorExtension(runtime.pi, { tasks: new BackgroundTasks(tmux), owner: "%owner" })

  await assert.rejects(runtime.execute("background_monitor", { command: "build" }), /failed to start tmux task/)
  assert.deepEqual(tmux.tasks(), [])
})
