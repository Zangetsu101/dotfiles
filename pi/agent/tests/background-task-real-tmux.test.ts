import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import test from "node:test"
import { promisify } from "node:util"
import { BackgroundTasks, type TmuxProcessAdapter } from "../extensions/lib/background-task.ts"

const execFileAsync = promisify(execFile)
const tmux = async (socket: string, args: string[]): Promise<string> =>
  (await execFileAsync("tmux", ["-L", socket, ...args], { encoding: "utf8" })).stdout.trim()

async function tmuxAvailable(): Promise<boolean> {
  try { await execFileAsync("tmux", ["-V"]); return true } catch { return false }
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read()
    if (accept(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("condition was not reached")
}

test("real tmux gives a task family agent windows and pooled monitor panes with stable targets", async (t) => {
  if (!(await tmuxAvailable())) return t.skip("tmux is not installed")

  // A private socket prevents the test from inspecting or mutating the user's tmux server.
  const socket = `pi-task-test-${process.pid}-${Date.now()}`
  const adapter: TmuxProcessAdapter = { run: (args) => tmux(socket, args) }
  const tasks = new BackgroundTasks(adapter)
  const family = {
    familyId: "family-real",
    familyName: "real family",
    rootId: "root-real",
    rootPane: "%root",
    parentId: "root-real",
    parentLabel: "root",
    cwd: process.cwd(),
  }
  t.after(() => tmux(socket, ["kill-server"]).catch(() => undefined))

  const agent = await tasks.create({ ...family, kind: "agent", label: "research", command: "/bin/sh", args: ["-c", "printf agent-finished"], remainOnExit: true })
  const first = await tasks.create({ ...family, kind: "monitor", label: "first", command: "/bin/sh", args: ["-c", "printf first-finished"], remainOnExit: true })
  const second = await tasks.create({ ...family, kind: "monitor", label: "second", command: "/bin/sh", args: ["-c", "printf second-finished"], remainOnExit: true })

  assert.match(agent.target, /^@\d+$/)
  assert.match(first.target, /^%\d+$/)
  assert.match(second.target, /^%\d+$/)
  assert.notEqual(first.target, second.target)
  const sessions = await Promise.all([agent, first, second].map((task) => tmux(socket, ["display-message", "-p", "-t", task.target, "#{session_id}"])))
  assert.equal(new Set(sessions).size, 1)
  assert.equal(await tmux(socket, ["display-message", "-p", "-t", first.target, "#{window_name}"]), "monitors")
  assert.equal((await tmux(socket, ["list-panes", "-t", first.target, "-F", "#{pane_id}"])).split("\n").length, 2)

  const discovered = await tasks.list({ familyId: family.familyId })
  assert.deepEqual(new Set(discovered.map((task) => task.id)), new Set([agent.id, first.id, second.id]))

  for (const monitor of [first, second]) {
    const state = await waitFor(
      () => tmux(socket, ["display-message", "-p", "-t", monitor.target, "#{pane_dead}\t#{pane_dead_status}"]),
      (value) => value === "1\t0",
    )
    assert.equal(state, "1\t0")
    assert.match(await tmux(socket, ["capture-pane", "-p", "-t", monitor.target, "-S", "-"]), new RegExp(`${monitor.label}-finished`))
  }
})
