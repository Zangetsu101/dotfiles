import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const exec = promisify(execFile)
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_BACKGROUND_")))
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { BackgroundTaskWatcher } from "../extensions/lib/background-task-watcher.ts"
import { FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(predicate())
}

test("watch resolves only after its initial snapshot is delivered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-watcher-ready-"))
  const watcher = new BackgroundTaskWatcher(new FakeTmuxProcessAdapter(), { metadataDirectory: directory })
  let delivered = false
  const dispose = await watcher.watch({ familyId: "family" }, () => { delivered = true })
  try { assert.equal(delivered, true) }
  finally { dispose(); await rm(directory, { recursive: true, force: true }) }
})

test("a later subscriber receives its snapshot before watch resolves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-watcher-shared-"))
  const watcher = new BackgroundTaskWatcher(new FakeTmuxProcessAdapter(), { metadataDirectory: directory })
  const first = await watcher.watch({ familyId: "first" }, () => {})
  let delivered = false
  const second = await watcher.watch({ familyId: "second" }, () => { delivered = true })
  try { assert.equal(delivered, true) }
  finally { first(); second(); await rm(directory, { recursive: true, force: true }) }
})

test("watch rejects an initial scan error and can be retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-watcher-error-"))
  const tmux = new FakeTmuxProcessAdapter()
  const failure = new Error("unexpected tmux failure")
  let fail = true
  const watcher = new BackgroundTaskWatcher({ run: async args => {
    if (fail && args[0] === "list-windows") throw failure
    return tmux.run(args)
  } }, { metadataDirectory: directory })
  let dispose: (() => void) | undefined
  try {
    await assert.rejects(watcher.watch({ familyId: "family" }, () => {}).then(value => { dispose = value }), failure)
    fail = false
    let delivered = false
    dispose = await watcher.watch({ familyId: "family" }, () => { delivered = true })
    assert.equal(delivered, true)
  } finally { dispose?.(); await rm(directory, { recursive: true, force: true }) }
})

test("a failed rescan preserves the snapshot and the next event recovers", async t => {
  const directory = await mkdtemp(join(tmpdir(), "task-watcher-rescan-"))
  const tmux = new FakeTmuxProcessAdapter()
  const owner = new BackgroundTasks(tmux, { metadataDirectory: directory })
  const task = await owner.create({ kind: "agent", label: "before", familyId: "family", rootId: "root", cwd: "/tmp", command: "true", args: [] })
  let fail = false
  const watcher = new BackgroundTaskWatcher({ run: async args => {
    if (fail && args[0] === "list-windows") throw new Error("unexpected tmux failure")
    return tmux.run(args)
  } }, { metadataDirectory: directory })
  const errors = t.mock.method(console, "error", () => {})
  let latest: import("../extensions/lib/background-task.ts").BackgroundTask[] = []
  const dispose = await watcher.watch({ familyId: "family" }, tasks => { latest = tasks })
  const before = latest
  try {
    fail = true
    await owner.renameNode(task.id, "after")
    await waitFor(() => errors.mock.calls.length > 0)
    assert.equal(latest, before)
    fail = false
    await writeFile(join(directory, "retry"), "changed")
    await waitFor(() => latest[0]?.label === "after")
  } finally { dispose(); await rm(directory, { recursive: true, force: true }) }
})

test("rapid restart waits for old hook removal without removing new hooks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-watcher-generation-"))
  const tmux = new FakeTmuxProcessAdapter()
  const activeHooks = new Set<string>()
  let release!: () => void
  let removing!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const removalStarted = new Promise<void>(resolve => { removing = resolve })
  let block = true
  const watcher = new BackgroundTaskWatcher({ run: async args => {
    if (args[0] === "set-hook") {
      if (args[1] === "-g") activeHooks.add(args[2])
      if (args[1] === "-gu") {
        if (block) { block = false; removing(); await gate }
        activeHooks.delete(args[2])
      }
    }
    return tmux.run(args)
  } }, { metadataDirectory: directory })
  const first = await watcher.watch({ familyId: "family" }, () => {})
  const hookCount = activeHooks.size
  first()
  await removalStarted
  let delivered = false
  const next = watcher.watch({ familyId: "family" }, () => { delivered = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(delivered, false)
  release()
  const second = await next
  try {
    assert.equal(delivered, true)
    assert.equal(activeHooks.size, hookCount)
  } finally {
    second()
    await waitFor(() => activeHooks.size === 0)
    await rm(directory, { recursive: true, force: true })
  }
})

test("family and nested subtree subscriptions exclude siblings and other families", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-watcher-scopes-"))
  const tmux = new FakeTmuxProcessAdapter()
  const owner = new BackgroundTasks(tmux, { metadataDirectory: directory })
  const input = { kind: "agent" as const, familyId: "family", rootId: "root", cwd: "/tmp", command: "true", args: [] }
  const parent = await owner.create({ ...input, label: "parent", parentId: "root" })
  const child = await owner.create({ ...input, label: "child", parentId: parent.id })
  const grandchild = await owner.create({ ...input, label: "grandchild", parentId: child.id })
  const sibling = await owner.create({ ...input, label: "sibling", parentId: "root" })
  await owner.create({ ...input, label: "outsider", familyId: "other", rootId: "other-root" })
  const watcher = new BackgroundTaskWatcher(tmux, { metadataDirectory: directory })
  let family: string[] = [], subtree: string[] = []
  const first = await watcher.watch({ familyId: "family" }, tasks => { family = tasks.map(task => task.id) })
  const second = await watcher.watch({ subtreeRootId: child.id }, tasks => { subtree = tasks.map(task => task.id) })
  try {
    assert.deepEqual(family.sort(), [parent.id, child.id, grandchild.id, sibling.id].sort())
    assert.deepEqual(subtree.sort(), [child.id, grandchild.id].sort())
    await owner.setStatus(grandchild, "succeeded")
    await owner.cleanup([grandchild])
    await waitFor(() => subtree.length === 1)
    assert.deepEqual(subtree, [child.id])
  } finally { first(); second(); await rm(directory, { recursive: true, force: true }) }
})

test("continuous metadata events do not starve watch readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-watcher-busy-"))
  const tmux = new FakeTmuxProcessAdapter()
  let churn = true
  const watcher = new BackgroundTaskWatcher({ run: async args => {
    if (churn && args[0] === "list-windows") {
      await writeFile(join(directory, "other-owner"), "changed")
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return tmux.run(args)
  } }, { metadataDirectory: directory })
  const ready = watcher.watch({ familyId: "family" }, () => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    assert.equal(await Promise.race([ready.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 100) })]), true)
  } finally {
    clearTimeout(timer)
    churn = false
    const dispose = await ready
    dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test("real tmux external option mutations invalidate subscribed snapshots", async t => {
  try { await exec("tmux", ["-V"], { env: cleanEnv }) } catch { return t.skip("tmux unavailable") }
  const socket = `watcher-test-${process.pid}-${Date.now()}`
  const invalidHooks: string[] = []
  let scans = 0
  const run = async (args: string[]) => {
    if (args[0] === "list-windows") scans++
    try { return (await exec("tmux", ["-L", socket, ...args], { env: cleanEnv })).stdout.trim() }
    catch (error) {
      if (args[0] === "set-hook" && args[1] === "-g") invalidHooks.push(args[2])
      throw error
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "task-watcher-real-"))
  await run(["new-session", "-d", "-s", "bootstrap"])
  const owner = new BackgroundTasks({ run }, { metadataDirectory: directory })
  const watcher = new BackgroundTaskWatcher({ run }, { metadataDirectory: directory })
  let latest: import("../extensions/lib/background-task.ts").BackgroundTask[] = []
  const dispose = await watcher.watch({ familyId: "external" }, tasks => { latest = tasks })
  try {
    assert.deepEqual(invalidHooks, [], "all installed hook names are supported by tmux")
    const idleScans = scans
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(scans, idleScans, "reconciliation must not feed back into its own hooks")
    const task = await owner.create({ kind: "agent", label: "original", familyId: "external", rootId: "root", cwd: "/tmp", command: "sleep", args: ["30"], remainOnExit: true })
    await waitFor(() => latest.length === 1)
    await run(["set-option", "-w", "-t", task.target, "@pi_task_label", "external rename"])
    await waitFor(() => latest[0]?.label === "external rename")
    await run(["kill-window", "-t", task.target])
    await waitFor(() => latest.length === 0)
  } finally {
    dispose()
    await run(["kill-server"]).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test("hooks recover when a server appears and when it is recreated", async t => {
  try { await exec("tmux", ["-V"], { env: cleanEnv }) } catch { return t.skip("tmux unavailable") }
  const socket = `watcher-restart-${process.pid}-${Date.now()}`
  const run = async (args: string[]) => (await exec("tmux", ["-L", socket, ...args], { env: cleanEnv })).stdout.trim()
  const directory = await mkdtemp(join(tmpdir(), "task-watcher-restart-"))
  const owner = new BackgroundTasks({ run }, { metadataDirectory: directory })
  const watcher = new BackgroundTaskWatcher({ run }, { metadataDirectory: directory })
  let latest: import("../extensions/lib/background-task.ts").BackgroundTask[] = []
  const dispose = await watcher.watch({ familyId: "restart" }, tasks => { latest = tasks })
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      await run(["new-session", "-d", "-s", `bootstrap-${cycle}`])
      const task = await owner.create({ kind: "agent", label: `original-${cycle}`, familyId: "restart", rootId: "root", cwd: "/tmp", command: "sleep", args: ["30"], remainOnExit: true })
      await waitFor(() => latest.some(item => item.id === task.id))
      await run(["set-option", "-w", "-t", task.target, "@pi_task_label", `external-${cycle}`])
      await waitFor(() => latest.some(item => item.label === `external-${cycle}`))
      await run(["kill-server"])
      // Deliberately recreate immediately, without waiting for the old server's invalidation.
    }
  } finally {
    dispose()
    await run(["kill-server"]).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test("subscribers observe another owner's creation, rename, status and removal without completion files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-watcher-test-"))
  const tmux = new FakeTmuxProcessAdapter()
  const owner = new BackgroundTasks(tmux, { metadataDirectory: directory })
  const watcher = new BackgroundTaskWatcher(tmux, { metadataDirectory: directory })
  let latest: import("../extensions/lib/background-task.ts").BackgroundTask[] = []
  const dispose = await watcher.watch({ familyId: "family" }, tasks => { latest = tasks })
  try {
    const task = await owner.create({ kind: "agent", label: "first", familyId: "family", rootId: "root", cwd: "/tmp", command: "true", args: [] })
    await waitFor(() => latest.length === 1)
    await owner.renameNode(task.id, "renamed")
    await waitFor(() => latest[0]?.label === "renamed")
    await owner.setStatus(task, "succeeded")
    await waitFor(() => latest[0]?.status === "succeeded")
    await owner.cleanup([task])
    await waitFor(() => latest.length === 0)
  } finally { dispose(); dispose(); await rm(directory, { recursive: true, force: true }) }
})
