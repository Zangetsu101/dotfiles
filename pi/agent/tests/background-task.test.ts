import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { BackgroundTasks, safeTaskLabel, writeTaskCompletion, type BackgroundTask, type TmuxProcessAdapter } from "../extensions/lib/background-task.ts"

class NoopTmux implements TmuxProcessAdapter {
  calls: string[][] = []
  async run(args: string[]): Promise<string> { this.calls.push(args); return args[0] === "-V" ? "tmux fake" : "" }
}

function task(statusFile: string): BackgroundTask {
  return {
    id: "one",
    familyId: "family-one",
    rootId: "root-one",
    kind: "monitor",
    label: "one",
    status: "running",
    target: "%1",
    parent: "root-one",
    parentId: "root-one",
    rootPane: "%root",
    cwd: "/repo",
    statusFile,
    storageMode: "family",
  }
}

test("task labels are safe when used as tmux-compatible fallbacks", () => {
  assert.equal(safeTaskLabel(" Run checks! "), "run-checks")
  assert.equal(safeTaskLabel("***"), "task")
  assert.equal(safeTaskLabel("abcdefghijklmnopqrstuvwxyz"), "abcdefghijklmnopqrstuvwx")
})

test("completion records are atomically replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-task-completion-"))
  const statusFile = join(directory, "completion.json")

  await writeTaskCompletion(statusFile, { status: "completed", exitCode: 0 })

  assert.deepEqual(JSON.parse(await readFile(statusFile, "utf8")), { status: "completed", exitCode: 0 })
})

test("completion notification can be claimed only once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-task-claim-"))
  const statusFile = join(directory, "completion.json")
  await writeFile(statusFile, JSON.stringify({ status: "completed", exitCode: 0 }))
  const tasks = new BackgroundTasks(new NoopTmux())

  assert.equal((await tasks.claimCompletion(task(statusFile)))?.status, "completed")
  assert.equal(await tasks.claimCompletion(task(statusFile)), undefined)
})

test("cleanup leaves a running subtree inspectable", async () => {
  const tmux = new NoopTmux()
  const tasks = new BackgroundTasks(tmux)
  const removed = await tasks.cleanup([task("/tmp/status")])

  assert.equal(removed, 0)
  assert.ok(!tmux.calls.some((args) => args[0] === "kill-window" || args[0] === "kill-pane" || args[0] === "kill-session"))
})
