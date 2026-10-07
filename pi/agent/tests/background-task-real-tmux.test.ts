import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import test from "node:test"
import { promisify } from "node:util"
import { BackgroundTasks, writeTaskCompletion, type TmuxProcessAdapter } from "../extensions/lib/background-task.ts"

const execFileAsync = promisify(execFile)
const tmux = async (socket: string, args: string[]): Promise<string> =>
  (await execFileAsync("tmux", ["-L", socket, ...args], { encoding: "utf8" })).stdout.trim()

function sizedTmux(socket: string, width: number, height: number): TmuxProcessAdapter {
  return { run: (args) => tmux(socket, args[0] === "new-session" ? [args[0], "-x", String(width), "-y", String(height), ...args.slice(1)] : args) }
}

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

test("short wide real tmux windows use available horizontal space before creating another pool", async (t) => {
  if (!(await tmuxAvailable())) return t.skip("tmux is not installed")
  const socket = `pi-wide-pool-${process.pid}-${Date.now()}`
  t.after(() => tmux(socket, ["kill-server"]).catch(() => undefined))
  const tasks = new BackgroundTasks(sizedTmux(socket, 80, 2))
  const input = { familyId: "wide-family", rootId: "wide-root", parentId: "wide-root", kind: "monitor" as const, label: "wide", cwd: process.cwd(), command: "/bin/sh", args: ["-c", "sleep 60"], remainOnExit: true }
  const first = await tasks.create(input)
  const second = await tasks.create(input)
  assert.equal(second.poolWindow, first.poolWindow)
  assert.equal((await tasks.list({ familyId: input.familyId })).length, 2)
})

test("tiny real tmux pools preserve finished output and running work when another split cannot fit", async (t) => {
  if (!(await tmuxAvailable())) return t.skip("tmux is not installed")
  const socket = `pi-small-pool-${process.pid}-${Date.now()}`
  t.after(() => tmux(socket, ["kill-server"]).catch(() => undefined))
  const adapter = sizedTmux(socket, 2, 2)
  const tasks = new BackgroundTasks(adapter)
  const input = { familyId: "tiny-family", rootId: "tiny-root", parentId: "tiny-root", kind: "monitor" as const, label: "tiny", cwd: process.cwd(), command: "/bin/sh", args: ["-c", "printf saved"], remainOnExit: true }
  const first = await tasks.create(input)
  await waitFor(() => tasks.completion(first), Boolean)
  const second = await tasks.create({ ...input, args: ["-c", "printf active; sleep 60"] })
  const third = await tasks.create(input)
  assert.notEqual(first.poolWindow, second.poolWindow)
  assert.notEqual(second.poolWindow, third.poolWindow)
  assert.match((await tmux(socket, ["capture-pane", "-p", "-t", first.target, "-S", "-"])).replaceAll(/\s/g, ""), /saved/)
  assert.equal(await tmux(socket, ["display-message", "-p", "-t", second.target, "#{pane_dead}"]), "0")
  const resumed = new BackgroundTasks(adapter)
  assert.equal((await resumed.list({ familyId: input.familyId })).length, 3)
  await resumed.setStatus(first, "succeeded")
  assert.equal(await resumed.cleanup([first]), 1)
  assert.deepEqual(new Set((await resumed.list({ familyId: input.familyId })).map((task) => task.id)), new Set([second.id, third.id]))
})

test("intentional cancellation survives the agent process exiting without a second failure notice", async (t) => {
  if (!(await tmuxAvailable())) return t.skip("tmux is not installed")
  const socket = `pi-cancel-test-${process.pid}-${Date.now()}`
  const tasks = new BackgroundTasks({ run: (args) => tmux(socket, args) })
  t.after(() => tmux(socket, ["kill-server"]).catch(() => undefined))
  const agent = await tasks.create({ familyId: "cancel-family", rootId: "cancel-root", parentId: "cancel-root", kind: "agent", label: "cancel", cwd: process.cwd(), command: "/bin/sh", args: ["-c", "sleep 0.3; exit 1"], remainOnExit: true })
  await writeTaskCompletion(agent.statusFile, { status: "cancelled", reason: "Stopped by parent" })
  assert.equal((await tasks.claimCompletionRecord(agent) as { status: string }).status, "cancelled")
  await waitFor(() => tmux(socket, ["display-message", "-p", "-t", agent.target, "#{pane_dead}"]), (value) => value === "1")
  assert.equal((await tasks.completion(agent) as { status: string }).status, "cancelled")
  assert.equal(await tasks.claimCompletionRecord(agent), undefined)
})

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
