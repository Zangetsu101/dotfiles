import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import backgroundAgent from "../extensions/background-agent.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(predicate(), "expected assignment notification")
}

for (const transientError of [false, true]) test(`rapid follow-up completion is notified while the previous outcome is delivered${transientError ? " after a transient progress read error" : ""}`, async () => {
  const inherited = { ...process.env }
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_")) delete process.env[key]
  const directory = await mkdtemp(join(tmpdir(), "pi-follow-up-race-"))
  const tmux = new FakeTmuxProcessAdapter()
  const run = tmux.run.bind(tmux)
  let release: (() => void) | undefined
  let blocked = false
  let delayStatus = false
  tmux.run = async (args) => {
    if (delayStatus && args.includes("@pi_agent_status") && args.includes("settled")) {
      delayStatus = false
      blocked = true
      await new Promise<void>((resolve) => { release = resolve })
    }
    return run(args)
  }
  const tasks = new BackgroundTasks(tmux, { metadataDirectory: directory })
  const parent = new FakePiRuntime()
  const child = new FakePiRuntime()
  try {
    await backgroundAgent(parent.pi, { tasks, tmux, pollMs: 10, settledPollMs: 10 })
    const spawned = await parent.execute("background_agent", { task: "First task", expectedCompletionMinutes: 1 })
    process.env.PI_BACKGROUND_AGENT_STATUS_FILE = spawned.details.statusFile
    process.env.PI_BACKGROUND_AGENT_DEPTH = "3"
    await backgroundAgent(child.pi, { tmux, pollMs: 5 })
    await child.emit("session_start")
    if (transientError) {
      await writeFile(`${spawned.details.statusFile}.progress`, "{")
      await new Promise((resolve) => setTimeout(resolve, 40))
      await rm(`${spawned.details.statusFile}.progress`)
    }
    delayStatus = true
    await child.execute("background_agent_report", { state: "completed", activity: "First result" })
    await waitFor(() => blocked)
    assert.equal((await parent.execute("background_agent_message", { id: spawned.details.id, message: "Second task" })).details.status, "delivered")
    await child.execute("background_agent_report", { state: "completed", activity: "Second result" })
    release!()
    await waitFor(() => parent.messages.length === 2)
    assert.deepEqual(parent.messages.map((message) => message.details.output), ["First result", "Second result"])
    await parent.emit("session_tree")
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(parent.messages.length, 2, "reload must not duplicate either outcome")
  } finally {
    release?.()
    await child.emit("session_shutdown")
    await parent.emit("session_shutdown")
    await rm(directory, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_")) delete process.env[key]
    Object.assign(process.env, inherited)
  }
})
