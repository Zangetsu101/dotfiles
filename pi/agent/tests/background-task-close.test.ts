import assert from "node:assert/strict"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import backgroundAgent from "../extensions/background-agent.ts"
import backgroundMonitor from "../extensions/background-monitor.ts"
import { BackgroundTasks, writeTaskCompletion } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"
import { installBackgroundTaskEnvironmentHooks } from "./support/background-task-environment.ts"

installBackgroundTaskEnvironmentHooks()
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await pause(5)
  assert.ok(predicate(), "expected completion notification")
}

for (const action of ["clean", "clean-all", "terminate"] as const) test(`${action} completed agents does not announce runtime failure`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-task-close-"))
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux, { metadataDirectory: directory })
  const parent = new FakePiRuntime()
  const run = tmux.run.bind(tmux)
  let observeClosure: (() => Promise<void>) | undefined
  tmux.run = async (args) => {
    // Hold cleanup open after the window disappears, before REMOVED is emitted.
    const result = await run(args)
    if (args[0] === "kill-window") await observeClosure?.()
    return result
  }
  try {
    await backgroundAgent(parent.pi, { tasks, tmux, pollMs: 5, settledPollMs: 5 })
    backgroundMonitor(parent.pi, { tasks })
    await parent.emit("session_start", { reason: "startup" })
    const spawned = await parent.execute("background_agent", { task: "Already finished", expectedCompletionMinutes: 1 })
    const completion = { kind: "settled" as const, output: "Work is complete", exitCode: 0 }
    await writeTaskCompletion(spawned.details.statusFile, completion)
    await waitFor(() => parent.messages.length === 1)
    assert.equal(parent.messages[0].details.status, "completed")
    if (action === "clean-all") {
      for (let i = 0; i < 4; i++) {
        const extra = await parent.execute("background_agent", { task: `Finished ${i}`, expectedCompletionMinutes: 1 })
        await writeTaskCompletion(extra.details.statusFile, completion)
      }
      await waitFor(() => parent.messages.length === 5)
    }
    const initialMessages = parent.messages.length
    observeClosure = async () => { await pause(100) }
    await parent.commands.get("task").handler(action === "clean-all" ? "clean" : `${action} ${spawned.details.id}`, parent.context)
    if (action === "terminate") {
      // A graceful session close removes the tmux window later.
      await run(["kill-window", "-t", spawned.details.target])
    }
    await pause(100)
    assert.equal(parent.messages.filter((message) => message.details.status === "failed").length, 0,
      JSON.stringify(parent.messages.map((message) => message.details)))
    if (action !== "terminate") {
      assert.match(parent.notifications.at(-1)!, new RegExp(`Cleaned ${initialMessages} background task`))
      assert.equal(parent.messages.length, initialMessages, "cleanup must not start another agent turn")
      assert.deepEqual(await tasks.completion({ statusFile: spawned.details.statusFile }), completion,
        "closing a session must preserve its assignment result")
    }
  } finally {
    await parent.emit("session_shutdown", { reason: "reload" })
    await rm(directory, { recursive: true, force: true })
  }
})

test("failed cleanup removes its intent marker and leaves the completed task inspectable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cleanup-failure-"))
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux, { metadataDirectory: directory })
  try {
    const task = await tasks.create({ kind: "agent", label: "Completed", cwd: directory,
      command: "unused", args: [], familyId: "family:test", rootId: "root:test", parentId: "root:test" })
    const completion = { kind: "settled" as const, output: "Done" }
    await writeTaskCompletion(task.statusFile, completion)
    await tasks.setStatus(task, "succeeded")
    const run = tmux.run.bind(tmux)
    tmux.run = async (args) => {
      if (args[0] === "kill-window") throw new Error("injected deletion failure")
      return run(args)
    }
    assert.equal(await tasks.cleanup([task]), 0)
    await assert.rejects(access(`${task.statusFile}.cleanup`), { code: "ENOENT" })
    assert.equal(await tasks.isPresent(task), true)
    assert.deepEqual(await tasks.completion(task), completion)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
