import assert from "node:assert/strict"
import test from "node:test"
import { BackgroundTasks, type TmuxProcessAdapter } from "../extensions/lib/background-task.ts"

class RecordingTmux implements TmuxProcessAdapter {
  calls: string[][] = []
  session = ""
  windows = new Map<string, string>()
  panes: Array<{ id: string; window: string }> = []
  sessionMetadata = new Map<string, string>()
  nextWindow = 1
  nextPane = 1

  async run(args: string[]): Promise<string> {
    this.calls.push(args)
    if (args[0] === "-V") return "tmux fake"
    if (args[0] === "list-sessions") {
      if (!this.session) return ""
      const format = args[args.indexOf("-F") + 1] ?? "#{session_name}"
      return format.replace("#{session_id}", this.session).replace("#{session_name}", "dotfiles").replace(/#\{(@[^}]+)\}/g, (_match, key) => this.sessionMetadata.get(key) ?? "")
    }
    if (args[0] === "new-session") {
      this.session = `$${this.nextWindow++}`
      return this.session
    }
    if (args[0] === "new-window") {
      const id = `@${this.nextWindow++}`
      this.windows.set(id, args[args.indexOf("-n") + 1]!)
      return id
    }
    if (args[0] === "split-window") {
      const id = `%${this.nextPane++}`
      const window = args[args.indexOf("-t") + 1]!
      this.panes.push({ id, window })
      return id
    }
    if (args[0] === "set-option" && !args.includes("-w") && !args.includes("-p")) {
      const target = args.indexOf("-t")
      this.sessionMetadata.set(args[target + 2]!, args[target + 3] ?? "")
      return ""
    }
    if (args[0] === "show-options") return this.sessionMetadata.get(args.at(-1)!) ?? ""
    if (args[0] === "list-windows") return ""
    if (args[0] === "list-panes") return ""
    return ""
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
  assert.equal(parent.status, "terminated")
  assert.equal(child.status, "terminated")
})
