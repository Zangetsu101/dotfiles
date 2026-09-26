import assert from "node:assert/strict"
import test from "node:test"
import backgroundAgentExtension from "../extensions/background-agent.ts"
import backgroundMonitorExtension from "../extensions/background-monitor.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
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

test("resuming in a new root pane updates direct children's parent navigation", async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux)
  const child = await tasks.create({ ...family, kind: "agent", label: "research", parentId: "root-one", parentTarget: "%root" })

  await tasks.reconcileFamily({ familyId: family.familyId, familyName: family.familyName, rootId: family.rootId, rootPane: "%resumed" })

  assert.equal((await tasks.resolve(child.id, { familyId: family.familyId }))?.parentTarget, "%resumed")
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
  const monitor = await runtime.execute("background_monitor", { command: "build", label: "build" })
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
  await runtime.emit("session_shutdown", { reason: "reload" })
}))

test("vanished monitor and agent targets report termination", async () => withTmuxEnvironment(async () => {
  const tmux = new FakeTmuxProcessAdapter(); const tasks = new BackgroundTasks(tmux); const runtime = new FakePiRuntime({ sessionId: "vanished" })
  backgroundMonitorExtension(runtime.pi, { tasks, pollMs: 5 }); await backgroundAgentExtension(runtime.pi, { tasks, tmux, pollMs: 5 }); await runtime.emit("session_start", { reason: "startup" })
  const monitor = await runtime.execute("background_monitor", { command: "build", label: "build" })
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
  const monitor = await first.execute("background_monitor", { command: "build", label: "build" })
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
  await first.execute("background_monitor", { command: "build", label: "build" })
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
