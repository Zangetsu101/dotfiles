import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"

test("a failed metadata write does not retain a rolled-back creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-metadata-test-"))
  try {
    const file = join(directory, "not-a-directory")
    await writeFile(file, "occupied")
    const tasks = new BackgroundTasks(new FakeTmuxProcessAdapter(), { metadataDirectory: file })
    await assert.rejects(tasks.create(input))
    assert.deepEqual(await tasks.list(), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const command of ["list-windows", "list-panes"]) {
  test(`live discovery rejects unexpected ${command} failures while ordinary discovery remains tolerant`, async () => {
    const failure = Object.assign(new Error("tmux listing failed"), { stderr: "error connecting to /tmp/tmux-1000/default (Permission denied)\n" })
    const tmux = new FakeTmuxProcessAdapter()
    const tasks = new BackgroundTasks({
      run: async (args) => {
        if (args[0] === command) throw failure
        return tmux.run(args)
      },
    })
    await assert.rejects(tasks.list(undefined, true), error => error === failure)
    assert.deepEqual(await tasks.list(), [])
  })
}

for (const stderr of [
  "no server running on /tmp/tmux-1000/default\n",
  "no sessions\n",
  "error connecting to /tmp/tmux-1000/default (No such file or directory)\n",
]) {
  test(`live discovery treats ${stderr.trim()} as an empty snapshot`, async () => {
    const tasks = new BackgroundTasks({
      run: async () => { throw Object.assign(new Error("tmux listing failed"), { stderr }) },
    })
    assert.deepEqual(await tasks.list(undefined, true), [])
  })
}

for (const failure of [new Error("tmux unavailable"), Object.assign(new Error("tmux listing failed"), { stderr: "no sessions\nunexpected failure\n" })]) {
  test(`live discovery rejects ${failure.message} without a legitimate empty-server diagnostic`, async () => {
    const tasks = new BackgroundTasks({ run: async () => { throw failure } })
    await assert.rejects(tasks.list(undefined, true), error => error === failure)
  })
}

const input = { familyId: "metadata-family", rootId: "metadata-root", rootPane: "%root", parentId: "metadata-root", kind: "agent" as const, label: "work", cwd: "/repo", command: "/bin/sh", args: ["-c", "true"] }

test("discovery excludes remembered missing tasks while live tasks remain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-metadata-test-"))
  try {
    const tmux = new FakeTmuxProcessAdapter()
    const tasks = new BackgroundTasks(tmux, { metadataDirectory: directory })
    const missing = await tasks.create(input)
    const live = await tasks.create(input)
    await tmux.run(["kill-window", "-t", missing.target])
    assert.deepEqual((await tasks.list()).map(task => task.id), [live.id])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("task updates and cleanup are visible to another task service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-metadata-test-"))
  try {
    const tmux = new FakeTmuxProcessAdapter()
    const creator = new BackgroundTasks(tmux, { metadataDirectory: directory })
    const observer = new BackgroundTasks(tmux, { metadataDirectory: directory })
    const task = await creator.create(input)
    assert.equal((await observer.list(undefined, true))[0]?.status, "running")
    await creator.renameNode(task.id, "renamed")
    await creator.setStatus(task, "succeeded")
    const [updated] = await observer.list(undefined, true)
    assert.equal(updated?.label, "renamed")
    assert.equal(updated?.status, "succeeded")
    assert.equal(await creator.cleanup([task]), 1)
    assert.deepEqual(await observer.list(undefined, true), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
