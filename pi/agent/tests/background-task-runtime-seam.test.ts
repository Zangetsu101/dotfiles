import assert from "node:assert/strict"
import test from "node:test"
import { rm, writeFile } from "node:fs/promises"
import backgroundAgentExtension from "../extensions/background-agent.ts"
import backgroundMonitorExtension from "../extensions/background-monitor.ts"
import { formatRunningTasks } from "../extensions/background-task-status.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { createTaskCheckInScheduler } from "../extensions/lib/task-check-in.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"

const family = { familyId: "family-one", familyName: "dotfiles", rootId: "root-one", rootPane: "%root", cwd: "/repo", command: "/bin/sh", args: ["-c", "true"] }
const waitFor = async (condition: () => boolean) => { for (let attempt = 0; attempt < 100 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(condition(), "timed out waiting for background notification") }

async function withTmuxEnvironment(run: () => Promise<void>) {
  const previous = { pane: process.env.TMUX_PANE, tmux: process.env.TMUX, family: process.env.PI_BACKGROUND_TASK_FAMILY_ID, task: process.env.PI_BACKGROUND_TASK_ID, root: process.env.PI_BACKGROUND_TASK_ROOT_ID, rootPane: process.env.PI_BACKGROUND_TASK_ROOT_PANE }
  process.env.TMUX = "fake"; process.env.TMUX_PANE = "%root"
  delete process.env.PI_BACKGROUND_TASK_FAMILY_ID; delete process.env.PI_BACKGROUND_TASK_ID; delete process.env.PI_BACKGROUND_TASK_ROOT_ID; delete process.env.PI_BACKGROUND_TASK_ROOT_PANE
  try { await run() } finally {
    for (const [key, value] of Object.entries({ TMUX_PANE: previous.pane, TMUX: previous.tmux, PI_BACKGROUND_TASK_FAMILY_ID: previous.family, PI_BACKGROUND_TASK_ID: previous.task, PI_BACKGROUND_TASK_ROOT_ID: previous.root, PI_BACKGROUND_TASK_ROOT_PANE: previous.rootPane })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
}

async function withSteerableChild(run: (parent: FakePiRuntime, child: FakePiRuntime, id: string, target: string) => Promise<void>) {
  await withTmuxEnvironment(async () => {
    const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
    const parent = new FakePiRuntime({ sessionId: "steering" })
    await backgroundAgentExtension(parent.pi, { tasks, tmux, pollMs: 5 })
    await parent.emit("session_start", { reason: "startup" })
    const agent = await parent.execute("background_agent", { task: "review", expectedCompletionMinutes: 1 })
    const child = new FakePiRuntime({ sessionId: "child" })
    const previous = process.env.PI_BACKGROUND_AGENT_STATUS_FILE
    process.env.PI_BACKGROUND_AGENT_STATUS_FILE = agent.details.statusFile
    try { await backgroundAgentExtension(child.pi, { tasks, tmux, pollMs: 5 }) } finally {
      if (previous === undefined) delete process.env.PI_BACKGROUND_AGENT_STATUS_FILE
      else process.env.PI_BACKGROUND_AGENT_STATUS_FILE = previous
    }
    await child.emit("session_start", { reason: "startup" })
    try { await run(parent, child, agent.details.id, agent.details.target) } finally {
      await child.emit("session_shutdown")
      await parent.emit("session_shutdown")
    }
  })
}

test("a running child receives a steer in its Pi conversation and acknowledges delivery", async () => withSteerableChild(async (parent, child, id, target) => {
  await child.emit("agent_start")
  const result = await parent.execute("background_agent_message", { id, message: "Check the edge case" })
  assert.equal(result.details.status, "delivered")
  assert.equal(result.details.id, id)
  assert.equal(result.details.label, "review")
  assert.equal(result.details.target, target)
  assert.equal(result.details.attach, `/task attach ${id}`)
  assert.deepEqual(child.userMessages, [{ text: "Check the edge case", options: { deliverAs: "steer" } }])
}))

test("an idle child accepts a message without steering an active turn", async () => withSteerableChild(async (parent, child, id) => {
  const result = await parent.execute("background_agent_message", { id, message: "Use the account currency" })
  assert.equal(result.details.status, "delivered")
  assert.deepEqual(child.userMessages, [{ text: "Use the account currency", options: undefined }])
}))

test("messages cannot address other task families or settled agents", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const parent = new FakePiRuntime({ sessionId: "steer-boundary" })
  await backgroundAgentExtension(parent.pi, { tasks, tmux, pollMs: 5 }); await parent.emit("session_start", { reason: "startup" })
  const agent = await parent.execute("background_agent", { task: "review", expectedCompletionMinutes: 1 })
  assert.match(agent.content[0].text, new RegExp(`Agent ID: ${agent.details.id}`))
  const foreign = await tasks.create({ ...family, kind: "agent", label: "foreign", parentId: family.rootId })
  const missing = await parent.execute("background_agent_message", { id: foreign.id, message: "no" })
  assert.equal(missing.details.status, "not_found")
  assert.match(missing.content[0].text, /not found in this task subtree/)
  assert.equal((await parent.execute("background_agent_message", { id: "mun?", message: "no" })).details.status, "not_found")
  const empty = await parent.execute("background_agent_message", { id: agent.details.id, message: "  " })
  assert.equal(empty.details.status, "error")
  await tmux.complete(agent.details.target, "completed", "done")
  const settled = await parent.execute("background_agent_message", { id: agent.details.id, message: "too late" })
  assert.equal(settled.details.status, "not_running")
  for (const result of [empty, settled]) {
    assert.equal(result.details.id, agent.details.id)
    assert.equal(result.details.label, agent.details.label)
    assert.equal(result.details.target, agent.details.target)
    assert.equal(result.details.attach, `/task attach ${agent.details.id}`)
  }
  await parent.emit("session_shutdown")
}))

test("the parent can inspect, reschedule, and terminate its monitor by ID", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const runtime = new FakePiRuntime({ sessionId: "control" })
  backgroundMonitorExtension(runtime.pi, { tasks, pollMs: 5 }); await runtime.emit("session_start", { reason: "startup" })
  try {
    const monitor = await runtime.execute("background_monitor", { command: "build", expectedRunningMinutes: 1 })
    const id = monitor.details.id
    const list = await runtime.execute("background_task", { action: "list" })
    assert.match(list.content[0].text, new RegExp(id))
    const inspect = await runtime.execute("background_task", { action: "inspect", id })
    assert.match(inspect.content[0].text, /running/)
    const recheck = await runtime.execute("background_task", { action: "check-in", id, afterMinutes: 2 })
    assert.equal(recheck.details.status, "scheduled")
    const unknown = await runtime.execute("background_task", { action: "inspect", id: "mun?" })
    assert.equal(unknown.details.status, "not_found")
    const foreign = await tasks.create({ ...family, familyId: "family:control", rootId: "root:control", kind: "monitor", label: "sibling", parentId: "other-node" })
    assert.equal((await runtime.execute("background_task", { action: "inspect", id: foreign.id })).details.status, "out_of_scope")
    const terminate = await runtime.execute("background_task", { action: "terminate", id })
    assert.equal(terminate.details.status, "terminated")
    for (const result of [inspect, recheck, terminate]) {
      assert.equal(result.details.id, id)
      assert.equal(result.details.label, monitor.details.label)
      assert.equal(result.details.target, monitor.details.target)
      assert.equal(result.details.attach, `/task attach ${id}`)
    }
  } finally { await runtime.emit("session_shutdown", { reason: "reload" }) }
}))

async function withInspectableTasks(sessionId: string, run: (runtime: FakePiRuntime, tasks: BackgroundTasks, tmux: FakeTmuxProcessAdapter) => Promise<void>) {
  await withTmuxEnvironment(async () => {
    const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
    const runtime = new FakePiRuntime({ sessionId })
    backgroundMonitorExtension(runtime.pi, { tasks })
    await backgroundAgentExtension(runtime.pi, { tasks, tmux, pollMs: 5 })
    await runtime.emit("session_start", { reason: "startup" })
    try { await run(runtime, tasks, tmux) } finally { await runtime.emit("session_shutdown", { reason: "reload" }) }
  })
}

test("inspect returns a settled agent's saved final answer instead of terminal redraws", async () => withInspectableTasks("inspect-settled", async (runtime, tasks, tmux) => {
    const agent = await runtime.execute("background_agent", { task: "review", expectedCompletionMinutes: 1 })
    const task = (await tasks.resolve(agent.details.id, { familyId: "family:inspect-settled" }))!
    const answer = `Review findings:\n${"Complete answer. ".repeat(300)}Done.`
    await tmux.complete(agent.details.target, "completed", answer)
    await writeFile(task.outputFile!, "\u001b[2KWorking... terminal redraw")
    const inspected = await runtime.execute("background_task", { action: "inspect", id: agent.details.id })
    assert.equal(inspected.details.status, "succeeded")
    assert.equal(inspected.details.output, answer)
    assert.equal(inspected.content[0].text, `agent ${agent.details.id} (review): succeeded\nFinal output:\n${answer}`)
    assert.equal(inspected.details.attach, `/task attach ${agent.details.id}`)
    await tmux.complete(agent.details.target, "completed")
    await rm(task.outputFile!)
    const empty = await runtime.execute("background_task", { action: "inspect", id: agent.details.id })
    assert.equal(empty.details.output, "(no final output)")
    assert.match(empty.content[0].text, /Final output:\n\(no final output\)$/)
}))

test("inspect keeps terminal tails for running agents, exited agents, and completed monitors", async () => withInspectableTasks("inspect-terminal", async (runtime, tasks, tmux) => {
    const agent = await runtime.execute("background_agent", { task: "review", expectedCompletionMinutes: 1 })
    const task = (await tasks.resolve(agent.details.id, { familyId: "family:inspect-terminal" }))!
    await writeFile(task.outputFile!, "Working on review")
    const running = await runtime.execute("background_task", { action: "inspect", id: agent.details.id })
    assert.equal(running.details.status, "running")
    assert.equal(running.details.output, "Working on review")
    assert.match(running.content[0].text, /Recent output:/)
    await tmux.complete(agent.details.target, "failed", "Agent exited unexpectedly")
    const exited = await runtime.execute("background_task", { action: "inspect", id: agent.details.id })
    assert.equal(exited.details.status, "failed")
    assert.equal(exited.details.output, "Agent exited unexpectedly")
    assert.match(exited.content[0].text, /Recent output:/)
    const monitor = await runtime.execute("background_monitor", { command: "build", expectedRunningMinutes: 1 })
    await tmux.complete(monitor.details.target, "completed", "Build succeeded")
    const completed = await runtime.execute("background_task", { action: "inspect", id: monitor.details.id })
    assert.equal(completed.details.status, "completed")
    assert.equal(completed.details.output, "Build succeeded")
    assert.match(completed.content[0].text, /Recent output:/)
}))

function controlledCheckIns() {
  let time = 1_000
  const timers = new Map<object, { deadline: number; callback: () => void }>()
  const now = () => time
  const checkIns = createTaskCheckInScheduler({
    now,
    setTimer(callback, delay) {
      const token = {} as ReturnType<typeof setTimeout>
      timers.set(token, { deadline: time + delay, callback })
      return token
    },
    clearTimer(token) { timers.delete(token) },
  })
  return {
    options: { checkIns, now, millisecondsPerMinute: 100 },
    async ready(count = 1) { await waitFor(() => timers.size >= count) },
    async advance(to: number) {
      assert.ok(to >= time)
      time = to
      for (const [token, timer] of [...timers]) {
        if (timer.deadline <= time) { timers.delete(token); timer.callback() }
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    },
  }
}

test("monitor check-ins respect both public tool durations at their boundaries", async () => withTmuxEnvironment(async () => {
  const clock = controlledCheckIns(); const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const runtime = new FakePiRuntime({ sessionId: "check-in" })
  backgroundMonitorExtension(runtime.pi, { tasks, pollMs: 5, ...clock.options })
  await runtime.emit("session_start", { reason: "startup" })
  try {
    const monitor = await runtime.execute("background_monitor", { command: "sleep 10", expectedRunningMinutes: 2 })
    const later = await runtime.execute("background_monitor", { command: "sleep 20", expectedRunningMinutes: 3 })
    await clock.ready(2)
    await clock.advance(1_199); assert.equal(runtime.messages.length, 0)
    await clock.advance(1_200); await waitFor(() => runtime.messages.length === 1)
    assert.match(runtime.messages[0]!.content, new RegExp(monitor.details.id))
    assert.match(runtime.messages[0]!.content, /status: running; elapsed: \d+ minutes/)
    await clock.advance(1_201); assert.equal(runtime.messages.length, 1)
    const result = await runtime.execute("background_task", { action: "check-in", id: monitor.details.id, afterMinutes: 3 })
    assert.equal(result.details.status, "scheduled")
    await clock.advance(1_299); assert.equal(runtime.messages.length, 1)
    await clock.advance(1_300); await waitFor(() => runtime.messages.length === 2)
    assert.match(runtime.messages[1]!.content, new RegExp(later.details.id))
    await clock.advance(1_301); assert.equal(runtime.messages.length, 2)
    await clock.advance(1_500); assert.equal(runtime.messages.length, 2)
    await clock.advance(1_501); await waitFor(() => runtime.messages.length === 3)
    assert.match(runtime.messages[2]!.content, new RegExp(monitor.details.id))
    await clock.advance(1_502); assert.equal(runtime.messages.length, 3)
    assert.equal((await runtime.execute("background_task", { action: "check-in", id: later.details.id, afterMinutes: 2 })).details.status, "scheduled")
    await clock.advance(1_701); assert.equal(runtime.messages.length, 3)
    await clock.advance(1_702); await waitFor(() => runtime.messages.length === 4)
    assert.match(runtime.messages[3]!.content, new RegExp(later.details.id))
    await clock.advance(1_703); assert.equal(runtime.messages.length, 4)
  } finally { await runtime.emit("session_shutdown", { reason: "reload" }) }
}))

test("a monitor check-in survives a parent session reload", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const first = new FakePiRuntime({ sessionId: "check-in-resume" })
  const clock = controlledCheckIns()
  backgroundMonitorExtension(first.pi, { tasks, pollMs: 5, ...clock.options }); await first.emit("session_start", { reason: "startup" })
  const monitor = await first.execute("background_monitor", { command: "sleep 10", expectedRunningMinutes: 2 })
  const persisted = [...first.entries]
  await first.emit("session_shutdown", { reason: "reload" })
  await tmux.run(["set-option", "-p", "-t", monitor.details.target, "@pi_task_started_at", String(Date.now() - 150_000)])
  const resumed = new FakePiRuntime({ sessionId: "check-in-resume", entries: persisted })
  backgroundMonitorExtension(resumed.pi, { tasks: new BackgroundTasks(tmux), pollMs: 5, ...clock.options })
  try {
    await resumed.emit("session_start", { reason: "resume" })
    await clock.ready()
    await clock.advance(1_199); assert.equal(resumed.messages.length, 0)
    await clock.advance(1_200)
    await waitFor(() => resumed.messages.some((message) => message.customType === "background-monitor-check-in"))
    assert.match(resumed.messages[0]!.content, new RegExp(monitor.details.id))
    assert.match(resumed.messages[0]!.content, /status: running; elapsed: 2 minutes/)
  } finally { await resumed.emit("session_shutdown", { reason: "reload" }) }
}))

test("a suppressed running check-in reaches the parent after reload", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const clock = controlledCheckIns()
  const first = new FakePiRuntime({ sessionId: "suppressed-check-in" })
  backgroundMonitorExtension(first.pi, { tasks, pollMs: 10_000, ...clock.options })
  await first.emit("session_start", { reason: "startup" })
  const monitor = await first.execute("background_monitor", { command: "sleep 10", expectedRunningMinutes: 2 })
  const completion = tasks.completion.bind(tasks)
  let suppressOnce = true
  tasks.completion = async (task) => {
    if (task.statusFile === monitor.details.statusFile && suppressOnce) {
      suppressOnce = false
      return { status: "completed" }
    }
    return completion(task)
  }
  await clock.ready()
  await clock.advance(1_200)
  assert.equal(first.messages.length, 0)
  assert.equal(suppressOnce, false)
  const persisted = [...first.entries]
  await first.emit("session_shutdown", { reason: "reload" })
  const resumed = new FakePiRuntime({ sessionId: "suppressed-check-in", entries: persisted })
  backgroundMonitorExtension(resumed.pi, { tasks: new BackgroundTasks(tmux), pollMs: 10_000, ...clock.options })
  try {
    await resumed.emit("session_start", { reason: "resume" })
    await clock.ready()
    await clock.advance(1_201)
    await waitFor(() => resumed.messages.some((message) => message.customType === "background-monitor-check-in"))
    assert.match(resumed.messages[0]!.content, new RegExp(monitor.details.id))
  } finally { await resumed.emit("session_shutdown", { reason: "reload" }) }
}))

test("an agent check-in wakes its parent and can be rearmed through the task tool", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const runtime = new FakePiRuntime({ sessionId: "agent-check-in" })
  const clock = controlledCheckIns()
  backgroundMonitorExtension(runtime.pi, { tasks, pollMs: 5, ...clock.options })
  await backgroundAgentExtension(runtime.pi, { tasks, tmux, pollMs: 5, ...clock.options })
  await runtime.emit("session_start", { reason: "startup" })
  try {
    const agent = await runtime.execute("background_agent", { task: "review", expectedCompletionMinutes: 2 })
    const later = await runtime.execute("background_agent", { task: "audit", expectedCompletionMinutes: 3 })
    await clock.ready(2)
    await clock.advance(1_199); assert.equal(runtime.messages.length, 0)
    await clock.advance(1_200); await waitFor(() => runtime.messages.length === 1)
    assert.match(runtime.messages[0]!.content, new RegExp(agent.details.id))
    await clock.advance(1_201); assert.equal(runtime.messages.length, 1)
    assert.equal((await runtime.execute("background_task", { action: "check-in", id: agent.details.id, afterMinutes: 3 })).details.status, "scheduled")
    await clock.advance(1_299); assert.equal(runtime.messages.length, 1)
    await clock.advance(1_300); await waitFor(() => runtime.messages.length === 2)
    assert.match(runtime.messages[1]!.content, new RegExp(later.details.id))
    await clock.advance(1_301); assert.equal(runtime.messages.length, 2)
    await clock.advance(1_500); assert.equal(runtime.messages.length, 2)
    await clock.advance(1_501); await waitFor(() => runtime.messages.length === 3)
    assert.match(runtime.messages[2]!.content, new RegExp(agent.details.id))
    await clock.advance(1_502); assert.equal(runtime.messages.length, 3)
  } finally { await runtime.emit("session_shutdown", { reason: "reload" }) }
}))

test("background_task inspect bounds output and preserves a UTF-8 suffix", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const runtime = new FakePiRuntime({ sessionId: "inspect-output" })
  backgroundMonitorExtension(runtime.pi, { tasks, pollMs: 5 })
  await runtime.emit("session_start", { reason: "startup" })
  try {
    const monitor = await runtime.execute("background_monitor", { command: "build", expectedRunningMinutes: 1 })
    const outputFile = (await tasks.resolve(monitor.details.id, { familyId: "family:inspect-output" }))!.outputFile!
    const suffix = "known suffix"
    const boundaryOutput = "x".repeat(16_000) + "€" + "y".repeat(3998 - suffix.length) + suffix
    for (const output of ["short output", boundaryOutput]) {
      await writeFile(outputFile, output)
      const inspected = await runtime.execute("background_task", { action: "inspect", id: monitor.details.id })
      assert.equal(inspected.details.status, "running")
      assert.ok(inspected.content[0].text.endsWith(output === "short output" ? output : suffix))
      if (output.length > 10_000) {
        assert.ok(inspected.content[0].text.length < output.length, "large output is bounded")
        assert.ok(!inspected.content[0].text.includes("�"), "UTF-8 remains valid at the tail boundary")
      }
    }
  } finally { await runtime.emit("session_shutdown", { reason: "reload" }) }
}))

test("nested and current-node work shares one family session while discovery stays in the node subtree", async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const first = await tasks.create({ ...family, kind: "agent", label: "research", parentId: "root-one", parentLabel: "root", parentTarget: "%root" })
  const nested = await tasks.create({ ...family, kind: "monitor", label: "tests", parentId: first.id, parentLabel: first.label, parentTarget: first.target })
  const sibling = await tasks.create({ ...family, kind: "agent", label: "docs", parentId: "root-one", parentLabel: "root", parentTarget: "%root" })

  assert.equal(tmux.familySessions().length, 1)
  assert.deepEqual(new Set((await tasks.list({ familyId: "family-one" })).map((task) => task.id)), new Set([first.id, nested.id, sibling.id]))
  assert.deepEqual((await tasks.list({ subtreeRootId: first.id })).map((task) => task.id), [first.id, nested.id])
  assert.deepEqual((await tasks.list({ subtreeRootId: sibling.id })).map((task) => task.id), [sibling.id])
  assert.match(nested.displayName!, /← research$/)
})

test("task list does not count an agent's inherited pane metadata twice", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter(); const originalRun = tmux.run.bind(tmux)
  tmux.run = async (args) => {
    const result = await originalRun(args)
    if (args[0] !== "list-panes") return result
    const format = args[args.indexOf("-F") + 1]!
    const windows = await originalRun(["list-windows", "-a", "-F", format.replace("#{pane_id}", "#{window_id}")])
    const inherited = windows.split("\n").filter((line) => line.includes("\tagent\t")).map((line) => line.replace(/^@\d+/, "%inherited"))
    return [result, ...inherited].filter(Boolean).join("\n")
  }
  const tasks = new BackgroundTasks(tmux); const runtime = new FakePiRuntime({ sessionId: "one" })
  backgroundMonitorExtension(runtime.pi, { tasks }); await backgroundAgentExtension(runtime.pi, { tasks, tmux }); await runtime.emit("session_start", { reason: "startup" })
  const agent = await runtime.execute("background_agent", { task: "review", label: "review", expectedCompletionMinutes: 1 })
  await runtime.commands.get("task").handler("list", runtime.context)
  assert.equal((runtime.notifications.at(-1)?.match(new RegExp(agent.details.id, "g")) ?? []).length, 1)
  await runtime.emit("session_shutdown", { reason: "reload" })
}))

test("a monitor inherited by its pool window counts once in the status line", async () => {
  const tmux = new FakeTmuxProcessAdapter()
  const originalRun = tmux.run.bind(tmux)
  tmux.run = async (args) => {
    const result = await originalRun(args)
    if (args[0] !== "list-windows") return result
    const format = args[args.indexOf("-F") + 1]!
    const panes = await originalRun(["list-panes", "-a", "-F", format.replace("#{window_id}", "#{pane_id}")])
    const inherited = panes.split("\n").filter((line) => line.includes("\tmonitor\t"))
      .map((line) => line.replace(/^%\d+/, "@pool"))
    return [result, ...inherited].filter(Boolean).join("\n")
  }
  const tasks = new BackgroundTasks(tmux)
  await tasks.create({ ...family, kind: "monitor", label: "build", parentId: "root-one" })
  assert.equal(formatRunningTasks(await tasks.list({ subtreeRootId: "root-one" }, true), "root-one"), "tasks: 1 monitor")
})

test("resuming in a new root pane updates direct children's parent navigation", async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const beforeStart = Date.now()
  const child = await tasks.create({ ...family, kind: "agent", label: "research", parentId: "root-one", parentTarget: "%root" })

  await tasks.reconcileFamily({ familyId: family.familyId, familyName: family.familyName, rootId: family.rootId, rootPane: "%resumed" })

  assert.equal((await tasks.resolve(child.id, { familyId: family.familyId }))?.parentTarget, "%resumed")
  assert.ok(child.startedAt !== undefined && child.startedAt >= beforeStart && child.startedAt <= Date.now())
  assert.equal((await new BackgroundTasks(tmux).resolve(child.id, { familyId: family.familyId }))?.startedAt, child.startedAt)
})

test("a child returns to the root's current pane after resume", async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const child = await tasks.create({ ...family, kind: "agent", label: "research", parentId: "root-one", parentTarget: "%root" })
  await tasks.reconcileFamily({ familyId: family.familyId, familyName: family.familyName, rootId: family.rootId, rootPane: "%resumed" })

  await tasks.navigateReturn(child)

  assert.equal(tmux.attachedTarget, "%resumed")
})

test("a vanished family session is recreated for new work in the same process", async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  await tasks.create({ ...family, kind: "agent", label: "first", parentId: "root-one" })
  const oldSession = tmux.familySessions()[0]!.id
  await tmux.run(["kill-session", "-t", oldSession])

  const next = await tasks.create({ ...family, kind: "agent", label: "second", parentId: "root-one" })

  assert.equal(tmux.familySessions().length, 1)
  assert.notEqual(tmux.familySessions()[0]!.id, oldSession)
  assert.equal((await tasks.resolve(next.id, { familyId: family.familyId }))?.id, next.id)
})

test("agent windows and pooled monitor panes complete, remain discoverable, and attach by stable IDs", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux); const runtime = new FakePiRuntime({ sessionId: "one" })
  backgroundMonitorExtension(runtime.pi, { tasks, pollMs: 5 }); await backgroundAgentExtension(runtime.pi, { tasks, tmux, millisecondsPerMinute: 10_000 }); await runtime.emit("session_start", { reason: "startup" })
  const monitor = await runtime.execute("background_monitor", { command: "build", label: "build", expectedRunningMinutes: 1 })
  const agent = await runtime.execute("background_agent", { task: "review", label: "review", expectedCompletionMinutes: 1 })

  assert.match(monitor.details.target, /^%\d+$/); assert.match(agent.details.target, /^@\d+$/)
  assert.equal(tmux.tasks().find((task) => task.target === monitor.details.target)?.retained, true)
  await runtime.commands.get("task").handler(`attach ${agent.details.id}`, runtime.context)
  assert.equal(tmux.attachedTarget, agent.details.target)

  await Promise.all([tmux.complete(monitor.details.target, "completed", "build output"), tmux.complete(agent.details.target, "completed", "review output")])
  await waitFor(() => runtime.messages.length === 2)
  assert.match(runtime.messages.find((message) => message.customType === "background-monitor")?.content ?? "", /build output/)
  assert.match(runtime.messages.find((message) => message.customType === "background-agent")?.content ?? "", /review output/)
  assert.deepEqual((await tasks.list({ familyId: "family:one" })).map((task) => task.status).sort(), ["succeeded", "succeeded"])
  await runtime.commands.get("task").handler("clean", runtime.context)
  assert.deepEqual(await tasks.list({ familyId: "family:one" }), [])
  await runtime.emit("session_shutdown", { reason: "reload" })
}))

test("clean stops watching a settled agent", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux); const runtime = new FakePiRuntime({ sessionId: "clean-watch" })
  backgroundMonitorExtension(runtime.pi, { tasks }); await backgroundAgentExtension(runtime.pi, { tasks, tmux, pollMs: 5, settledPollMs: 5 }); await runtime.emit("session_start", { reason: "startup" })
  const agent = await runtime.execute("background_agent", { task: "review", label: "review", expectedCompletionMinutes: 1 })
  await tmux.complete(agent.details.target)
  await waitFor(() => runtime.messages.length === 1)
  const [task] = await tasks.list({ familyId: "family:clean-watch" })
  await runtime.commands.get("task").handler(`clean ${agent.details.id}`, runtime.context)
  const entryCount = runtime.entries.length
  await rm(task!.statusFile)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(runtime.entries.length, entryCount)
  assert.deepEqual(await tasks.list({ familyId: "family:clean-watch" }), [])
  await runtime.emit("session_shutdown", { reason: "reload" })
}))

test("vanished monitor and agent targets report termination", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux); const runtime = new FakePiRuntime({ sessionId: "vanished" })
  backgroundMonitorExtension(runtime.pi, { tasks, pollMs: 5 }); await backgroundAgentExtension(runtime.pi, { tasks, tmux, pollMs: 5 }); await runtime.emit("session_start", { reason: "startup" })
  const monitor = await runtime.execute("background_monitor", { command: "build", label: "build", expectedRunningMinutes: 1 })
  const agent = await runtime.execute("background_agent", { task: "review", label: "review", expectedCompletionMinutes: 1 })

  await tmux.run(["kill-pane", "-t", monitor.details.target])
  await tmux.run(["kill-window", "-t", agent.details.target])
  await waitFor(() => runtime.messages.length === 2)

  assert.match(runtime.messages.find((message) => message.customType === "background-monitor")?.content ?? "", /was cancelled: task target disappeared/)
  assert.match(runtime.messages.find((message) => message.customType === "background-agent")?.content ?? "", /was terminated: task target disappeared/)
  await runtime.emit("session_shutdown", { reason: "reload" })
}))

test("terminate and clean cascade through descendants, preserve siblings, and remove an empty family session", async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const parent = await tasks.create({ ...family, kind: "agent", label: "parent", parentId: "root-one" })
  const child = await tasks.create({ ...family, kind: "monitor", label: "child", parentId: parent.id, parentLabel: parent.label, parentTarget: parent.target })
  const sibling = await tasks.create({ ...family, kind: "agent", label: "sibling", parentId: "root-one" })

  assert.equal(await tasks.cleanup([parent]), 0)
  await tasks.terminate(parent)
  assert.deepEqual(new Set(tmux.signalledTargets), new Set([parent.target, child.target]))
  assert.equal((await tasks.resolve(sibling.id, { familyId: "family-one" }))?.status, "running")
  assert.equal(await tasks.cleanup([parent]), 2)
  assert.deepEqual((await tasks.list({ familyId: "family-one" })).map((task) => task.id), [sibling.id])

  await tasks.terminate(sibling); assert.equal(await tasks.cleanup([sibling]), 1)
  assert.equal(tmux.familySessions().length, 0)
})

test("a resumed extension reclaims the family and reconnects agent and monitor completion watchers", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const first = new FakePiRuntime({ sessionId: "resume-me" })
  backgroundMonitorExtension(first.pi, { tasks, pollMs: 5 }); await backgroundAgentExtension(first.pi, { tasks, tmux, millisecondsPerMinute: 10_000 }); await first.emit("session_start", { reason: "startup" })
  const monitor = await first.execute("background_monitor", { command: "build", label: "build", expectedRunningMinutes: 1 })
  const agent = await first.execute("background_agent", { task: "review", label: "review", expectedCompletionMinutes: 1 })
  const persisted = [...first.entries]
  await first.emit("session_shutdown", { reason: "reload" })

  const resumed = new FakePiRuntime({ sessionId: "resume-me", entries: persisted })
  backgroundMonitorExtension(resumed.pi, { tasks: new BackgroundTasks(tmux), pollMs: 5 }); await backgroundAgentExtension(resumed.pi, { tasks: new BackgroundTasks(tmux), tmux, millisecondsPerMinute: 10_000 })
  await resumed.emit("session_start", { reason: "resume" })
  await Promise.all([tmux.complete(monitor.details.target, "completed", "resumed monitor"), tmux.complete(agent.details.target, "completed", "resumed agent")])
  await waitFor(() => resumed.messages.length === 2)
  assert.deepEqual(new Set(resumed.messages.map((message) => message.customType)), new Set(["background-monitor", "background-agent"]))
  assert.equal(tmux.familySessions().length, 1)
  await resumed.emit("session_shutdown", { reason: "reload" })
}))

test("switching conversation trees stops notifications from the old family's agents", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const runtime = new FakePiRuntime({ sessionId: "old-tree" })
  await backgroundAgentExtension(runtime.pi, { tasks, tmux, pollMs: 5 })
  await runtime.emit("session_start", { reason: "startup" })
  const agent = await runtime.execute("background_agent", { task: "review", label: "review", expectedCompletionMinutes: 1 })
  runtime.context.sessionManager.getSessionId = () => "new-tree"
  runtime.entries.length = 0
  await runtime.emit("session_tree")

  await tmux.complete(agent.details.target, "completed", "old tree result")
  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.equal(runtime.messages.length, 0)
  await runtime.emit("session_shutdown", { reason: "reload" })
}))

test("terminated subtree status is persisted before resume", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const runtime = new FakePiRuntime({ sessionId: "terminated" })
  backgroundMonitorExtension(runtime.pi, { tasks, pollMs: 5 }); await backgroundAgentExtension(runtime.pi, { tasks, tmux, pollMs: 5 }); await runtime.emit("session_start", { reason: "startup" })
  const agent = await runtime.execute("background_agent", { task: "review", label: "review", expectedCompletionMinutes: 1 })
  const parent = (await tasks.resolve(agent.details.id, { familyId: "family:terminated" }))!
  const child = await tasks.create({ ...family, familyId: "family:terminated", rootId: "root:terminated", kind: "monitor", label: "tests", parentId: parent.id, parentLabel: parent.label, parentTarget: parent.target })
  runtime.pi.events.emit("pi:background-task-created", child)

  await runtime.commands.get("task").handler(`terminate ${agent.details.id}`, runtime.context)

  for (const id of [parent.id, child.id]) {
    const records = runtime.entries.filter((entry) => entry.type === "custom" && entry.customType === "background-task-record" && entry.data?.id === id)
    assert.equal(records.at(-1)?.data.status, "terminated")
  }
  await runtime.emit("session_shutdown", { reason: "reload" })
}))

test("cleaned tasks stay removed after the conversation resumes", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const first = new FakePiRuntime({ sessionId: "cleaned" })
  backgroundMonitorExtension(first.pi, { tasks, pollMs: 5 }); await backgroundAgentExtension(first.pi, { tasks, tmux, pollMs: 5 }); await first.emit("session_start", { reason: "startup" })
  const agent = await first.execute("background_agent", { task: "review", label: "review", expectedCompletionMinutes: 1 })
  await first.commands.get("task").handler(`terminate ${agent.details.id}`, first.context)
  await first.commands.get("task").handler(`clean ${agent.details.id}`, first.context)
  const persisted = [...first.entries]
  await first.emit("session_shutdown", { reason: "reload" })

  const resumed = new FakePiRuntime({ sessionId: "cleaned", entries: persisted })
  backgroundMonitorExtension(resumed.pi, { tasks: new BackgroundTasks(tmux), pollMs: 5 })
  await resumed.emit("session_start", { reason: "resume" })
  await resumed.commands.get("task").handler("list", resumed.context)

  assert.equal(resumed.notifications.at(-1), "No background tasks found.")
  await resumed.emit("session_shutdown", { reason: "reload" })
}))

test("resume marks persisted running tasks interrupted when the family session disappeared", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter()
  const first = new FakePiRuntime({ sessionId: "interrupted" })
  backgroundMonitorExtension(first.pi, { tasks: new BackgroundTasks(tmux), pollMs: 5 })
  await first.emit("session_start", { reason: "startup" })
  await first.execute("background_monitor", { command: "build", label: "build", expectedRunningMinutes: 1 })
  const persisted = [...first.entries]
  await first.emit("session_shutdown", { reason: "reload" })
  await tmux.run(["kill-session", "-t", tmux.familySessions()[0]!.id])

  const resumed = new FakePiRuntime({ sessionId: "interrupted", entries: persisted })
  backgroundMonitorExtension(resumed.pi, { tasks: new BackgroundTasks(tmux), pollMs: 5 })
  await resumed.emit("session_start", { reason: "resume" })
  await resumed.commands.get("task").handler("list", resumed.context)

  assert.match(resumed.notifications.at(-1) ?? "", /build  monitor  interrupted/)
  await resumed.emit("session_shutdown", { reason: "reload" })
}))

test("family rename and setup failure use current session metadata without leaving an empty family", async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const task = await tasks.create({ ...family, kind: "agent", label: "work", parentId: "root-one" })
  await tasks.renameFamily("family-one", "renamed.project")
  assert.equal(tmux.familySessions()[0]?.name, "renamed-project")
  await tasks.terminate(task); await tasks.cleanup([task])

  tmux.failSetupFor = "@pi_task_label"
  await assert.rejects(tasks.create({ ...family, familyId: "family-two", kind: "agent", label: "broken", parentId: "root-two" }), /injected setup failure/)
  assert.equal(tmux.familySessions().length, 0)
})
