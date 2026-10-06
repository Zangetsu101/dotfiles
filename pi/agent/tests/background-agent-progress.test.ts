import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { beforeEach, afterEach } from "node:test"
import backgroundAgent from "../extensions/background-agent.ts"
import backgroundMonitor from "../extensions/background-monitor.ts"
import { notifyRunningTask } from "../extensions/lib/background-task-check-in.ts"
import { BackgroundTasks, writeTaskCompletion } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"
import { installBackgroundTaskEnvironmentHooks } from "./support/background-task-environment.ts"

installBackgroundTaskEnvironmentHooks()
let agentEnvironment: NodeJS.ProcessEnv
beforeEach(() => {
  agentEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("PI_BACKGROUND_AGENT_")))
  for (const key of Object.keys(agentEnvironment)) delete process.env[key]
})
afterEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_AGENT_")) delete process.env[key]
  Object.assign(process.env, agentEnvironment)
})

test("reported activity and blockers remain inspectable without consuming history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-progress-"))
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux, { metadataDirectory: directory })
  const parent = new FakePiRuntime()
  const child = new FakePiRuntime()
  try {
    await backgroundAgent(parent.pi, { tasks, tmux })
    await backgroundMonitor(parent.pi, { tasks, tmux })
    const spawned = await parent.execute("background_agent", { task: "Fix tests", expectedCompletionMinutes: 1 })
    process.env.PI_BACKGROUND_AGENT_STATUS_FILE = spawned.details.statusFile
    process.env.PI_BACKGROUND_AGENT_DEPTH = "3"
    await backgroundAgent(child.pi, { tmux, now: () => 1000 })
    await child.execute("background_agent_report", { activity: "Tracing the failing test" })
    await child.execute("background_agent_report", { activity: "Waiting for credentials", state: "blocked", help: "Please supply a test token" })
    const first = await parent.execute("background_task", { action: "inspect", id: spawned.details.id })
    const second = await parent.execute("background_task", { action: "inspect", id: spawned.details.id })
    assert.deepEqual(first.details.progress, second.details.progress)
    assert.equal(first.details.progress.latest.activity, "Waiting for credentials")
    assert.equal(first.details.progress.latest.help, "Please supply a test token")
    assert.deepEqual(first.details.progress.history.map((item: any) => item.activity), ["Tracing the failing test", "Waiting for credentials"])
    assert.match(first.content[0].text, /Waiting for credentials/)
    assert.equal(parent.messages.length, 0, "routine reports must not interrupt the parent")
    const task = (await tasks.list({ subtreeRootId: "root:conversation" })).find((task) => task.id === spawned.details.id)!
    assert.equal(await notifyRunningTask(parent.pi, tasks, task, () => true), true)
    assert.match(parent.messages[0].content, /Reported progress: blocked: Waiting for credentials/)
    assert.doesNotMatch(parent.messages[0].content, /Recent output:/)
    assert.equal(parent.messages[0].details.progress.history.length, 2)
    await child.execute("background_agent_report", { activity: "Need credentials", state: "blocked", help: "Supply a token", attention: true })
    for (let attempt = 0; attempt < 50 && parent.messages.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(parent.messages.length, 2, "blocker should request parent attention")
    assert.match(parent.messages[1].content, /Supply a token/)
    await parent.emit("session_tree")
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(parent.messages.length, 2, "attention must not be repeated on reload")
    await writeTaskCompletion(spawned.details.statusFile, { kind: "settled", stopReason: "error", output: "Provider failed" })
    const failed = await parent.execute("background_task", { action: "inspect", id: spawned.details.id })
    assert.equal(failed.details.status, "failed", "inspection must agree with model-error notifications")
    for (let attempt = 0; attempt < 50 && parent.messages.length < 3; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(parent.messages[2].details.status, "failed")
    assert.equal(parent.messages[2].details.output, "Provider failed")
  } finally {
    await child.emit("session_shutdown")
    await parent.emit("session_shutdown", { reason: "reload" })
    await rm(directory, { recursive: true, force: true })
  }
})
