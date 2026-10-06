import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import backgroundAgent from "../extensions/background-agent.ts"
import backgroundMonitor from "../extensions/background-monitor.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await pause(10)
  assert.ok(predicate(), "expected notification or delivery")
}

for (const runtimeFailure of ["exit", "disappeared"] as const) test(`reported completion stops check-ins, dedupes settling, resets follow-up and observes runtime ${runtimeFailure}`, async () => {
  const inherited = { ...process.env }
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_")) delete process.env[key]
  const directory = await mkdtemp(join(tmpdir(), "pi-outcome-"))
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux, { metadataDirectory: directory })
  const parent = new FakePiRuntime()
  const child = new FakePiRuntime()
  try {
    await backgroundAgent(parent.pi, { tasks, tmux, pollMs: 10, settledPollMs: 20 })
    await backgroundMonitor(parent.pi, { tasks, tmux })
    const spawned = await parent.execute("background_agent", { task: "Fix tests", expectedCompletionMinutes: 1 })
    process.env.PI_BACKGROUND_AGENT_STATUS_FILE = spawned.details.statusFile
    process.env.PI_BACKGROUND_AGENT_DEPTH = "3"
    await backgroundAgent(child.pi, { tmux, pollMs: 10 })
    await child.emit("session_start")
    await child.execute("background_agent_report", { state: "completed", activity: "Fixed tests; manual UI check remains" })
    await waitFor(() => parent.messages.length === 1)
    assert.match(parent.messages[0].content, /agent.reported|reported.*completed/i)
    assert.match(parent.messages[0].content, /manual UI check remains/)
    await child.emit("agent_settled")
    await pause(50)
    assert.equal(parent.messages.length, 1)
    const inspect = await parent.execute("background_task", { action: "inspect", id: spawned.details.id })
    assert.equal(inspect.details.progress.latest.state, "completed")
    const oldAssignment = inspect.details.progress.assignment
    const delivery = await parent.execute("background_agent_message", { id: spawned.details.id, message: "Now check the UI" })
    assert.equal(delivery.details.status, "delivered")
    await child.emit("agent_start")
    await child.execute("background_agent_report", { activity: "Checking the UI" })
    const next = await parent.execute("background_task", { action: "inspect", id: spawned.details.id })
    assert.notEqual(next.details.progress.assignment, oldAssignment)
    assert.deepEqual(next.details.progress.history.map((report: any) => report.activity), ["Checking the UI"])
    await child.execute("background_agent_report", { state: "failed", activity: "Cannot check UI without a terminal" })
    await waitFor(() => parent.messages.length === 2)
    assert.equal(parent.messages[1].details.status, "failed")
    if (runtimeFailure === "exit") await writeFile(spawned.details.statusFile, JSON.stringify({ kind: "exit", exitCode: 2 }))
    else await tmux.run(["kill-window", "-t", spawned.details.target])
    await waitFor(() => parent.messages.length === 3)
    assert.match(parent.messages[2].content, runtimeFailure === "exit" ? /exit code 2/ : /disappeared/)
    const stopped = await parent.execute("background_task", { action: "check-in", id: spawned.details.id, afterMinutes: 1 })
    assert.equal(stopped.details.status, "not_running")
  } finally {
    await child.emit("session_shutdown")
    await parent.emit("session_shutdown", { reason: "reload" })
    await rm(directory, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_")) delete process.env[key]
    Object.assign(process.env, inherited)
  }
})
