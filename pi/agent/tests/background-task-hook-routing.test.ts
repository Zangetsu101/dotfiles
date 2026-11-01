import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BackgroundTasks, type BackgroundTask } from "../extensions/lib/background-task.ts"
import { BackgroundTaskWatcher } from "../extensions/lib/background-task-watcher.ts"

const exec = promisify(execFile)
const settle = () => new Promise(resolve => setTimeout(resolve, 200))
const waitFor = async (ready: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (ready()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(ready(), "snapshot eventually updates")
}

async function fixture(t: TestContext) {
  try { await exec("tmux", ["-V"]) } catch { t.skip("tmux unavailable"); return }
  t.mock.timers.enable({ apis: ["setInterval"] })
  const directory = await mkdtemp(join(tmpdir(), "task hook's routing-"))
  const socket = `hook-routing-${process.pid}-${Date.now()}`
  const run = async (args: string[]) => (await exec("tmux", ["-L", socket, "-f", "/dev/null", ...args])).stdout.trim()
  const owner = new BackgroundTasks({ run }, { metadataDirectory: directory })
  const create = (familyId: string, label = "before", command = "sleep", args = ["60"]) => owner.create({ kind: "monitor", label, familyId, rootId: `${familyId}-root`, cwd: "/tmp", command, args, remainOnExit: true })
  const snapshots: { same: BackgroundTask[]; other: BackgroundTask[] } = { same: [], other: [] }
  const counts = { same: 0, other: 0 }
  const stops: Array<() => void> = []
  t.after(async () => {
    for (const stop of stops) stop()
    await settle()
    await run(["kill-server"]).catch(() => undefined)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    t.mock.timers.reset()
  })
  const task = await create("family")
  const otherTask = await create("other")
  for (const [name, family] of [["same", "family"], ["other", "other"]] as const) {
    const watcher = new BackgroundTaskWatcher({ run: args => { counts[name]++; return run(args) } }, { metadataDirectory: directory })
    stops.push(await watcher.watch({ subtreeRootId: `${family}-root`, routingFamilyId: family }, tasks => { snapshots[name] = tasks }))
  }
  await settle()
  counts.same = counts.other = 0
  return { run, owner, create, task, otherTask, snapshots, counts, directory, stops }
}

test("known-family external option hooks update their family without scanning another family", async t => {
  const f = await fixture(t)
  if (!f) return
  await f.run(["set-option", "-p", "-t", f.task.target, "@pi_task_label", "external"])
  await waitFor(() => f.snapshots.same[0]?.label === "external")
  await settle()
  assert.equal(f.counts.other, 0, "a known-family option mutation does not scan an unrelated family")
})

test("split, new-window and rename hooks in an established family do not scan another family", async t => {
  const f = await fixture(t)
  if (!f) return
  const session = await f.run(["display-message", "-p", "-t", f.task.target, "#{session_id}"])
  assert.ok(f.task.poolWindow)
  for (const args of [
    ["split-window", "-d", "-t", f.task.target, "sleep 60"],
    ["new-window", "-d", "-t", session, "sleep 60"],
    ["rename-session", "-t", session, "renamed-family"],
    ["rename-window", "-t", f.task.poolWindow, "renamed-pool"],
  ]) {
    f.counts.same = f.counts.other = 0
    await f.run(args)
    await waitFor(() => f.counts.same > 0)
    await settle()
    assert.equal(f.counts.other, 0, `${args[0]} routes only to its family`)
  }
})

test("rename hooks without explicit targets still route their resolved family", async t => {
  const f = await fixture(t)
  if (!f) return
  const family = await f.run(["display-message", "-p", "#{@pi_task_family_id}"])
  assert.ok(family === "family" || family === "other")
  const interested = family === "family" ? "same" : "other"
  const unrelated = interested === "same" ? "other" : "same"
  await f.run(["rename-window", "untargeted-rename"])
  await waitFor(() => f.counts[interested] > 0)
  await settle()
  assert.equal(f.counts[unrelated], 0)
})

test("global, server, untargeted and identity option edits keep the generic fallback", async t => {
  const f = await fixture(t)
  if (!f) return
  for (const args of [
    ["set-option", "-g", "-t", f.task.target, "status", "off"],
    ["set-option", "-s", "-t", f.task.target, "escape-time", "20"],
    ["set-option", "status", "on"],
    ["set-option", "-p", "-t", f.task.target, "@pi_task_family_id", "family"],
  ]) {
    f.counts.other = 0
    await f.run(args)
    await waitFor(() => f.counts.other > 0)
    await settle()
  }
})

test("missing and malformed routing tokens fall back without executing their contents", async t => {
  const f = await fixture(t)
  if (!f) return
  const marker = join(f.directory, "injected")
  for (const token of ["", `family-${"a".repeat(64)}; touch '${marker}'`, `family-${"a".repeat(63)}`, `family-${"a".repeat(64)}\n`]) {
    await f.run(["set-option", "-t", f.task.target, "@pi_task_invalidation", token])
    await settle()
    f.counts.other = 0
    await f.run(["set-option", "-p", "-t", f.task.target, "@pi_task_label", "changed"])
    await waitFor(() => f.counts.other > 0)
    await settle()
    await assert.rejects(access(marker))
  }
})

test("external family reassignment keeps subsequent option mutations observable", async t => {
  const f = await fixture(t)
  if (!f) return
  let moved: BackgroundTask[] = []
  const destination = new BackgroundTaskWatcher({ run: f.run }, { metadataDirectory: f.directory })
  f.stops.push(await destination.watch({ familyId: "other" }, tasks => { moved = tasks }))
  await f.run(["set-option", "-p", "-t", f.task.target, "@pi_task_family_id", "other"])
  await waitFor(() => moved.some(task => task.id === f.task.id))
  await settle()
  await f.run(["set-option", "-p", "-t", f.task.target, "@pi_task_label", "moved"])
  await waitFor(() => moved.find(task => task.id === f.task.id)?.label === "moved")
})

test("family restoration stays conservative between identity and token writes", async t => {
  const f = await fixture(t)
  if (!f) return
  const session = await f.run(["display-message", "-p", "-t", f.task.target, "#{session_id}"])
  await f.run(["set-option", "-t", session, "@pi_task_family_id", "moved"])
  await f.run(["set-option", "-p", "-t", f.task.target, "@pi_task_family_id", "moved"])
  let moved: BackgroundTask[] = []
  const destination = new BackgroundTaskWatcher({ run: f.run }, { metadataDirectory: f.directory })
  f.stops.push(await destination.watch({ familyId: "moved" }, tasks => { moved = tasks }))
  let release!: () => void
  let paused!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const identityWritten = new Promise<void>(resolve => { paused = resolve })
  const owner = new BackgroundTasks({ run: async args => {
    const result = await f.run(args)
    if (args[0] === "set-option" && args.includes("@pi_task_invalidation_family")) {
      paused()
      await gate
    }
    return result
  } }, { metadataDirectory: f.directory })
  const restoring = owner.reconcileFamily({ familyId: "moved", familyName: "moved", rootId: "family-root", rootPane: "%root" })
  try {
    await identityWritten
    await settle()
    await f.run(["set-option", "-p", "-t", f.task.target, "@pi_task_label", "during-restore"])
    await waitFor(() => moved.find(task => task.id === f.task.id)?.label === "during-restore")
  } finally {
    release()
    await restoring
  }
})

test("restoring an existing family backfills routing for its external hooks", async t => {
  const f = await fixture(t)
  if (!f) return
  await f.run(["set-option", "-u", "-t", f.task.target, "@pi_task_invalidation"])
  await f.owner.reconcileFamily({ familyId: "family", familyName: "family", rootId: "family-root", rootPane: "%root" })
  await settle()
  f.counts.other = 0
  await f.run(["set-option", "-p", "-t", f.task.target, "@pi_task_label", "restored"])
  await waitFor(() => f.snapshots.same[0]?.label === "restored")
  await settle()
  assert.equal(f.counts.other, 0)
})

test("pane exit, pane deletion and session closure retain cross-family recovery", async t => {
  const f = await fixture(t)
  if (!f) return
  const short = await f.create("family", "short")
  await waitFor(() => f.snapshots.same.length === 2)
  await settle()
  f.counts.other = 0
  await f.run(["respawn-pane", "-k", "-t", short.target, "sh -c 'sleep .3'"])
  await waitFor(() => f.counts.other > 0)
  await f.run(["kill-pane", "-t", short.target])
  await waitFor(() => !f.snapshots.same.some(task => task.id === short.id))
  // Closing the final session pane makes tmux expose the surviving other
  // family's context. Routing by those options would strand this snapshot.
  await f.run(["kill-pane", "-t", f.task.target])
  await waitFor(() => f.snapshots.same.length === 0)
  assert.equal(f.snapshots.other[0]?.id, f.otherTask.id)
})
