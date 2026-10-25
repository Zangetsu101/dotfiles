import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { afterEach, beforeEach, test } from "node:test"
import agentExtension from "../extensions/background-agent.ts"
import monitorExtension from "../extensions/background-monitor.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"

let environment: NodeJS.ProcessEnv
beforeEach(() => {
  environment = { ...process.env }
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_")) delete process.env[key]
  process.env.TMUX = "fake"
  process.env.TMUX_PANE = "%root"
})
afterEach(() => { process.env = environment })

async function start(entries: any[] = [], tmux = new FakeTmuxProcessAdapter()) {
  const runtime = new FakePiRuntime({ sessionId: "availability", entries })
  const tasks = new BackgroundTasks(tmux)
  monitorExtension(runtime.pi, { tasks, pollMs: 5 })
  await agentExtension(runtime.pi, { tasks, tmux, pollMs: 5, settledPollMs: 5 })
  await runtime.emit("session_start", { reason: "resume" })
  return { runtime, tasks, tmux }
}
async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(condition(), "tool availability did not update")
}
const active = (runtime: FakePiRuntime) => [...runtime.activeTools].sort()

test("monitor creation enables task operations until completed tasks are cleaned", async () => {
  const { runtime, tmux } = await start()
  try {
    runtime.pi.setActiveTools(runtime.activeTools.filter((name: string) => name !== "bash"))
    const monitor = await runtime.execute("background_monitor", { command: "build", expectedRunningMinutes: 1 })
    assert.ok(runtime.activeTools.includes("background_task"))
    assert.ok(!runtime.activeTools.includes("background_agent_message"))
    await tmux.complete(monitor.details.target)
    await waitFor(() => runtime.messages.length > 0)
    assert.ok(runtime.activeTools.includes("background_task"))
    await runtime.commands.get("task").handler("clean", runtime.context)
    await waitFor(() => !runtime.activeTools.includes("background_task"))
    assert.deepEqual(active(runtime), ["background_agent", "background_monitor", "read"])
  } finally { await runtime.emit("session_shutdown", { reason: "reload" }) }
})

test("live agents remain messageable after completion but not after runtime exit", async () => {
  const { runtime, tmux } = await start()
  try {
    const agent = await runtime.execute("background_agent", { task: "review", expectedCompletionMinutes: 1 })
    assert.ok(runtime.activeTools.includes("background_agent_message"))
    assert.ok(runtime.activeTools.includes("background_task"))
    await tmux.complete(agent.details.target, "completed", "done")
    await waitFor(() => runtime.messages.length > 0)
    assert.ok(runtime.activeTools.includes("background_agent_message"))
    await tmux.complete(agent.details.target, "failed", "exited")
    await waitFor(() => !runtime.activeTools.includes("background_agent_message"))
    assert.ok(runtime.activeTools.includes("background_task"))
  } finally { await runtime.emit("session_shutdown", { reason: "reload" }) }
})

for (const maxDepth of [1, 3]) for (const depth of [maxDepth - 1, maxDepth, maxDepth + 1]) test(`child tools at depth ${depth} with limit ${maxDepth}`, async () => {
  process.env.PI_BACKGROUND_AGENT_STATUS_FILE = `/tmp/availability-child-${process.pid}`
  process.env.PI_BACKGROUND_AGENT_DEPTH = String(depth)
  process.env.PI_BACKGROUND_AGENT_MAX_DEPTH = String(maxDepth)
  process.env.PI_BACKGROUND_TASK_FAMILY_ID = "child-family"
  process.env.PI_BACKGROUND_TASK_ID = "child-node"
  process.env.PI_BACKGROUND_TASK_ROOT_ID = "child-root"
  const { runtime } = await start()
  try {
    const expected = ["background_agent_report", "background_monitor", "bash", "read"]
    if (depth < maxDepth) expected.push("background_agent")
    assert.deepEqual(active(runtime), expected.sort())
  } finally { await runtime.emit("session_shutdown", { reason: "reload" }) }
})

test("restoration recovers availability for completed tasks and clears it on a new tree", async () => {
  const first = await start()
  const agent = await first.runtime.execute("background_agent", { task: "review", expectedCompletionMinutes: 1 })
  await first.tmux.complete(agent.details.target)
  await waitFor(() => first.runtime.messages.length > 0)
  await first.runtime.emit("session_shutdown", { reason: "reload" })
  const { runtime } = await start(first.runtime.entries, first.tmux)
  try {
    assert.deepEqual(active(runtime), ["background_agent", "background_agent_message", "background_monitor", "background_task", "bash", "read"])
    runtime.entries.length = 0
    runtime.context.sessionManager.getSessionId = () => "other-tree"
    await runtime.emit("session_tree")
    assert.deepEqual(active(runtime), ["background_agent", "background_monitor", "bash", "read"])
  } finally { await runtime.emit("session_shutdown", { reason: "reload" }) }
})

test("persisted tasks keep task operations available after the tmux family disappears", async () => {
  const first = await start()
  const monitor = await first.runtime.execute("background_monitor", { command: "build", expectedRunningMinutes: 1 })
  await first.runtime.emit("session_shutdown", { reason: "reload" })
  await first.tmux.run(["kill-session", "-t", first.tmux.familySessions()[0]!.id])
  await first.tasks.create({ familyId: "foreign", rootId: "foreign-root", rootPane: "%foreign", familyName: "foreign", kind: "monitor", label: "foreign", parentId: "foreign-root", cwd: "/repo", command: "build", args: [] })
  const { runtime } = await start(first.runtime.entries, first.tmux)
  try {
    assert.match((await runtime.execute("background_task", { action: "list" })).content[0].text, new RegExp(monitor.details.id))
    assert.equal((await runtime.execute("background_task", { action: "inspect", id: monitor.details.id })).details.status, "interrupted")
    assert.ok(runtime.activeTools.includes("background_task"))
    assert.ok(!runtime.activeTools.includes("background_agent_message"))
    await runtime.commands.get("task").handler(`clean ${monitor.details.id}`, runtime.context)
    assert.ok(!runtime.activeTools.includes("background_task"))
    assert.equal(first.tmux.tasks().length, 1)
  } finally { await runtime.emit("session_shutdown", { reason: "reload" }) }
})

for (const status of ["terminated", "interrupted"] as const) test(`a present agent marked ${status} without a completion cannot receive messages`, async () => {
  const { runtime, tasks } = await start()
  try {
    const spawned = await runtime.execute("background_agent", { task: "review", expectedCompletionMinutes: 1 })
    const agent = (await tasks.list()).find((task) => task.id === spawned.details.id)!
    await tasks.setStatus(agent, status)
    await waitFor(() => !runtime.activeTools.includes("background_agent_message"))
    const result = await runtime.execute("background_agent_message", { id: agent.id, message: "follow up" })
    assert.equal(result.details.status, "not_running")
  } finally { await runtime.emit("session_shutdown", { reason: "reload" }) }
})

test("a depth-limited child discovers external descendants without exposing itself or siblings", async () => {
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux)
  const family = { familyId: "nested-family", rootId: "nested-root", rootPane: "%root", familyName: "nested", cwd: "/repo", command: "pi", args: [] }
  const self = await tasks.create({ ...family, kind: "agent", label: "self", parentId: family.rootId })
  const sibling = await tasks.create({ ...family, kind: "agent", label: "sibling", parentId: family.rootId })
  process.env.PI_BACKGROUND_AGENT_STATUS_FILE = self.statusFile
  process.env.PI_BACKGROUND_AGENT_DEPTH = "1"
  process.env.PI_BACKGROUND_AGENT_MAX_DEPTH = "1"
  process.env.PI_BACKGROUND_TASK_FAMILY_ID = family.familyId
  process.env.PI_BACKGROUND_TASK_ROOT_ID = family.rootId
  process.env.PI_BACKGROUND_TASK_ID = self.id
  const { runtime } = await start([], tmux)
  try {
    assert.deepEqual(active(runtime), ["background_agent_report", "background_monitor", "bash", "read"])
    const child = await tasks.create({ ...family, kind: "agent", label: "descendant", parentId: self.id })
    await waitFor(() => runtime.activeTools.includes("background_agent_message") && runtime.activeTools.includes("background_task"))
    assert.ok(!runtime.activeTools.includes("background_agent"))
    assert.equal((await runtime.execute("background_agent_message", { id: sibling.id, message: "no" })).details.status, "not_found")
    await tasks.terminate(child)
    await waitFor(() => !runtime.activeTools.includes("background_agent_message"))
    assert.ok(runtime.activeTools.includes("background_task"))
    await runtime.commands.get("task").handler(`clean ${child.id}`, runtime.context)
    await waitFor(() => !runtime.activeTools.includes("background_task"))
  } finally { await runtime.emit("session_shutdown", { reason: "reload" }) }
})

test("descendant runtime exit disables messaging even when metadata status stays failed", async () => {
  const { runtime, tasks } = await start()
  const family = { familyId: "family:availability", rootId: "root:availability", rootPane: "%root", familyName: "availability", cwd: "/repo", command: "pi", args: [] }
  try {
    const parent = await tasks.create({ ...family, kind: "agent", label: "parent", parentId: family.rootId })
    await writeFile(parent.statusFile, JSON.stringify({ kind: "exit", exitCode: 1 }))
    await tasks.setStatus(parent, "failed")
    const child = await tasks.create({ ...family, kind: "agent", label: "child", parentId: parent.id })
    await writeFile(child.statusFile, JSON.stringify({ kind: "reported", outcome: "failed", output: "blocked" }))
    await tasks.setStatus(child, "failed")
    await waitFor(() => runtime.activeTools.includes("background_agent_message"))
    await writeFile(child.statusFile, JSON.stringify({ kind: "exit", exitCode: 1 }))
    await waitFor(() => !runtime.activeTools.includes("background_agent_message"))
  } finally { await runtime.emit("session_shutdown", { reason: "reload" }) }
})

test("an older empty refresh cannot hide messaging after a newer agent creation", async () => {
  const { runtime, tmux, tasks } = await start()
  await tasks.create({ familyId: "foreign", rootId: "foreign-root", rootPane: "%foreign", familyName: "foreign", kind: "agent", label: "foreign", parentId: "foreign-root", cwd: "/repo", command: "pi", args: [] })
  const run = tmux.run.bind(tmux)
  let delay = true
  let release!: () => void
  let captured!: () => void
  const pending = new Promise<void>((resolve) => { captured = resolve })
  tmux.run = async (args) => {
    const result = await run(args)
    if (delay && args[0] === "list-windows") {
      delay = false
      captured()
      await new Promise<void>((resolve) => { release = resolve })
    }
    return result
  }
  try {
    runtime.events.emit("pi:background-task-status-changed", { id: "old", status: "succeeded" })
    await pending
    await runtime.execute("background_agent", { task: "review", expectedCompletionMinutes: 1 })
    assert.ok(runtime.activeTools.includes("background_agent_message"))
    await new Promise((resolve) => setTimeout(resolve, 40))
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.ok(runtime.activeTools.includes("background_agent_message"))
  } finally { release?.(); await runtime.emit("session_shutdown", { reason: "reload" }) }
})

test("a descendant exit during discovery cannot occur before completion observation starts", async () => {
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux)
  const child = await tasks.create({ familyId: "family:availability", rootId: "root:availability", rootPane: "%root", familyName: "availability", kind: "agent", label: "child", parentId: "elsewhere", cwd: "/repo", command: "pi", args: [] })
  await writeFile(child.statusFile, JSON.stringify({ kind: "reported", outcome: "failed" }))
  await tasks.setStatus(child, "failed")
  const { runtime } = await start([], tmux)
  const run = tmux.run.bind(tmux)
  let exited!: () => void
  const exit = new Promise<void>((resolve) => { exited = resolve })
  let injectExit = true
  tmux.run = async (args) => {
    const output = await run(args)
    if (injectExit && args[0] === "list-windows" && args.at(-1) === "#{@pi_task_id}") {
      injectExit = false
      await writeFile(child.statusFile, JSON.stringify({ kind: "exit", exitCode: 1 }))
      exited()
    }
    return output
  }
  try {
    await tmux.run(["set-option", "-w", "-t", child.target, "@pi_task_parent_id", "root:availability"])
    await tasks.setStatus(child, "failed")
    await exit
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.ok(!runtime.activeTools.includes("background_agent_message"))
  } finally { await runtime.emit("session_shutdown", { reason: "reload" }) }
})

test("Root Pi starts with spawn and monitor tools without empty-subtree operations", async () => {
  const { runtime } = await start()
  try {
    assert.deepEqual(active(runtime), ["background_agent", "background_monitor", "bash", "read"])
  } finally { await runtime.emit("session_shutdown", { reason: "reload" }) }
})
