import assert from "node:assert/strict"
import test from "node:test"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"

class RecordingTmux extends FakeTmuxProcessAdapter {
  calls: string[][] = []
  get windows() { return new Map([...this.sessions.values()].flatMap((session) => [...session.windows.values()].map((window) => [window.id, window.name] as const))) }
  get panes() { return [...this.sessions.values()].flatMap((session) => [...session.windows.values()].flatMap((window) => [...window.panes.values()].map((pane) => ({ id: pane.id, window: window.id })))) }
  async run(args: string[]): Promise<string> {
    this.calls.push(args)
    return super.run(args)
  }
}

const base = {
  familyId: "family-one",
  familyName: "dotfiles",
  rootId: "root-one",
  rootPane: "%root",
  parentId: "root-one",
  parentLabel: "root",
  cwd: "/repo",
  command: "/bin/sh",
  args: ["-c", "true"],
}

test("a task family gives agents windows and monitors panes in a shared pool", async () => {
  const tmux = new RecordingTmux()
  const tasks = new BackgroundTasks(tmux)

  const agent = await tasks.create({ ...base, kind: "agent", label: "research" })
  const monitor = await tasks.create({ ...base, kind: "monitor", label: "build" })

  assert.match(agent.target, /^@\d+$/)
  assert.match(monitor.target, /^%\d+$/)
  assert.equal(tmux.calls.filter((call) => call[0] === "new-session").length, 1)
  const sessionCreation = tmux.calls.find((call) => call[0] === "new-session")!
  assert.equal(sessionCreation[sessionCreation.indexOf("-s") + 1], "dotfiles")
  assert.ok([...tmux.windows.values()].includes("research"))
  assert.ok([...tmux.windows.values()].includes("monitors"))
  assert.ok(tmux.calls.some((call) => call[0] === "select-pane" && call.includes(monitor.target) && call.at(-1) === "build"))
})

test("nested display names show only the immediate parent and duplicate names get stable suffixes", async () => {
  const tmux = new RecordingTmux()
  const tasks = new BackgroundTasks(tmux)

  await tasks.create({ ...base, kind: "agent", label: "tests" })
  await tasks.create({ ...base, kind: "agent", label: "tests" })
  await tasks.create({ ...base, kind: "agent", label: "verify", parentId: "parent-task", parentLabel: "research" })
  await tasks.create({ ...base, kind: "agent", label: "verify", parentId: "parent-task", parentLabel: "research" })

  assert.deepEqual([...tmux.windows.values()].filter((name) => name !== "bootstrap"), ["tests", "tests (2)", "verify ← research", "verify (2) ← research"])
})

test("duplicate suffixes remain monotonic after a sibling is cleaned", async () => {
  const tmux = new RecordingTmux()
  const tasks = new BackgroundTasks(tmux)

  const first = await tasks.create({ ...base, kind: "agent", label: "tests" })
  const second = await tasks.create({ ...base, kind: "agent", label: "tests" })
  const third = await tasks.create({ ...base, kind: "agent", label: "tests" })
  await Promise.all([first, second, third].map((task) => tasks.setStatus(task, "succeeded")))
  await tasks.cleanup([second, third])

  const resumedTasks = new BackgroundTasks(tmux)
  const fourth = await resumedTasks.create({ ...base, kind: "agent", label: "tests" })

  assert.equal(fourth.displayName, "tests (4)")
})

test("monitor pools hold at most eight panes before allocating the next FIFO pool", async () => {
  const tmux = new RecordingTmux()
  const tasks = new BackgroundTasks(tmux)

  for (let index = 0; index < 9; index++) await tasks.create({ ...base, kind: "monitor", label: `monitor ${index}` })

  assert.ok([...tmux.windows.values()].includes("monitors"))
  assert.ok([...tmux.windows.values()].includes("monitors (2)"))
  assert.equal(new Set(tmux.panes.slice(0, 8).map((pane) => pane.window)).size, 1)
  assert.notEqual(tmux.panes[8]?.window, tmux.panes[0]?.window)
})

test("renaming an agent updates its window and the parent suffix of direct children", async () => {
  const tmux = new RecordingTmux()
  const tasks = new BackgroundTasks(tmux)
  const parent = await tasks.create({ ...base, kind: "agent", label: "research" })
  const child = await tasks.create({ ...base, kind: "agent", label: "verify", parentId: parent.id, parentLabel: parent.label, parentTarget: parent.target })

  await tasks.renameNode(parent.id, "investigate")

  assert.ok(tmux.calls.some((call) => call[0] === "rename-window" && call.includes(parent.target) && call.at(-1) === "investigate"))
  assert.ok(tmux.calls.some((call) => call[0] === "rename-window" && call.includes(child.target) && call.at(-1) === "verify ← investigate"))
})

test("subtree termination cascades and cleanup refuses while any descendant runs", async () => {
  const tmux = new RecordingTmux()
  const tasks = new BackgroundTasks(tmux)
  const parent = await tasks.create({ ...base, kind: "agent", label: "research" })
  const child = await tasks.create({ ...base, kind: "monitor", label: "tests", parentId: parent.id, parentLabel: parent.label, parentTarget: parent.target })

  assert.equal(await tasks.cleanup([parent]), 0)
  await tasks.setStatus(parent, "succeeded")
  await tasks.terminate(parent)

  const signals = tmux.calls.filter((call) => call[0] === "send-keys").map((call) => call[call.indexOf("-t") + 1])
  assert.deepEqual(new Set(signals), new Set([parent.target, child.target]))
  assert.equal((await tasks.resolve(parent.id, { familyId: base.familyId }))?.status, "terminated")
  assert.equal((await tasks.resolve(child.id, { familyId: base.familyId }))?.status, "terminated")
})
