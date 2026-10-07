import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"

const monitor = { familyId: "allocation-family", rootId: "allocation-root", parentId: "allocation-root", kind: "monitor" as const, label: "build", cwd: "/repo", command: "/bin/sh", args: ["-c", "true"], remainOnExit: true }

test("a geometrically full pool preserves retained output and starts another monitor in a new pool", async () => {
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux)
  const first = await tasks.create(monitor)
  await tmux.complete(first.target, "completed", "retained result")
  const run = tmux.run.bind(tmux)
  tmux.run = async (args) => {
    if (args[0] === "split-window") throw new Error("no space for new pane")
    return run(args)
  }
  const second = await tasks.create(monitor)
  assert.notEqual(second.poolWindow, first.poolWindow)
  const listed = await tasks.list({ familyId: monitor.familyId })
  assert.deepEqual(listed.map((task) => task.id).sort(), [first.id, second.id].sort())
  assert.equal((await tasks.completion(first) as { status: string }).status, "completed")
  assert.equal(await readFile(first.outputFile!, "utf8"), "retained result")
  assert.equal(await tasks.cleanup([first]), 1)
  assert.deepEqual((await tasks.list({ familyId: monitor.familyId })).map((task) => task.id), [second.id])
})

test("separate task runtimes share pool capacity and enforce the eight-pane maximum", async () => {
  const tmux = new FakeTmuxProcessAdapter()
  const created = []
  for (let index = 0; index < 9; index++) created.push(await new BackgroundTasks(tmux).create(monitor))
  assert.equal(new Set(created.slice(0, 8).map((task) => task.poolWindow)).size, 1)
  assert.notEqual(created[8].poolWindow, created[0].poolWindow)
  assert.equal((await new BackgroundTasks(tmux).list({ familyId: monitor.familyId })).length, 9)
})

test("genuine split startup errors are reported instead of allocating another pool", async () => {
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux)
  const first = await tasks.create(monitor)
  const run = tmux.run.bind(tmux)
  const failure = Object.assign(new Error("tmux command failed"), { stderr: "error creating pane: invalid working directory\n" })
  tmux.run = async (args) => {
    if (args[0] === "split-window") throw failure
    return run(args)
  }
  await assert.rejects(tasks.create(monitor), (error) => error === failure)
  assert.deepEqual((await tasks.list({ familyId: monitor.familyId })).map((task) => task.id), [first.id])
  tmux.run = run
  const second = await tasks.create(monitor)
  assert.equal(second.poolWindow, first.poolWindow)
})

test("a failed fresh pool setup preserves old work and leaves no orphaned allocation", async () => {
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux)
  const first = await tasks.create(monitor)
  const run = tmux.run.bind(tmux)
  tmux.run = async (args) => {
    if (args[0] === "split-window") throw Object.assign(new Error("tmux command failed"), { stderr: "no space for new pane\n" })
    return run(args)
  }
  tmux.failSetupFor = "@pi_task_label"
  await assert.rejects(tasks.create(monitor), /injected setup failure/)
  tmux.failSetupFor = undefined
  const second = await tasks.create(monitor)
  assert.notEqual(second.poolWindow, first.poolWindow)
  assert.equal(tmux.familySessions()[0]!.windows.size, 2)
  assert.deepEqual((await tasks.list({ familyId: monitor.familyId })).map((task) => task.id).sort(), [first.id, second.id].sort())
})

test("failed first monitor startup permits a clean retry in the same runtime", async () => {
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux)
  tmux.failSetupFor = "@pi_task_label"
  await assert.rejects(tasks.create(monitor), /injected setup failure/)
  assert.equal(tmux.familySessions().length, 0)
  assert.deepEqual(await tasks.list({ familyId: monitor.familyId }), [])
  tmux.failSetupFor = undefined
  const next = await tasks.create(monitor)
  assert.deepEqual((await tasks.list({ familyId: monitor.familyId })).map((task) => task.id), [next.id])
})

test("layout space shortages do not discard a successfully allocated monitor", async () => {
  const tmux = new FakeTmuxProcessAdapter()
  const run = tmux.run.bind(tmux)
  tmux.run = async (args) => {
    if (args[0] === "select-layout") throw Object.assign(new Error("tmux command failed"), { stderr: "can't set layout\n" })
    return run(args)
  }
  const tasks = new BackgroundTasks(tmux)
  const first = await tasks.create(monitor)
  const second = await tasks.create(monitor)
  assert.equal(second.poolWindow, first.poolWindow)
  assert.equal((await tasks.list({ familyId: monitor.familyId })).length, 2)
})

test("layout command failures do not reject an allocated monitor", async () => {
  const tmux = new FakeTmuxProcessAdapter()
  const run = tmux.run.bind(tmux)
  tmux.run = async (args) => {
    if (args[0] === "select-layout") throw new Error("layout selection unavailable")
    return run(args)
  }
  const tasks = new BackgroundTasks(tmux)
  const first = await tasks.create(monitor)
  const second = await tasks.create(monitor)
  assert.equal(second.poolWindow, first.poolWindow)
  assert.deepEqual((await tasks.list({ familyId: monitor.familyId })).map((task) => task.id).sort(), [first.id, second.id].sort())
})

test("failed monitor setup restores capacity without removing existing monitors", async () => {
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux)
  const first = await tasks.create(monitor)
  tmux.failSetupFor = "@pi_task_label"
  for (let attempt = 0; attempt < 8; attempt++) await assert.rejects(tasks.create(monitor), /injected setup failure/)
  tmux.failSetupFor = undefined
  const second = await tasks.create(monitor)
  assert.equal(second.poolWindow, first.poolWindow)
  assert.deepEqual((await tasks.list({ familyId: monitor.familyId })).map((task) => task.id).sort(), [first.id, second.id].sort())
})
