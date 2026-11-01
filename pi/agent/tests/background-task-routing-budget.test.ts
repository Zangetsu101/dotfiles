import assert from "node:assert/strict"
import { test } from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { BackgroundTaskWatcher } from "../extensions/lib/background-task-watcher.ts"

const exec = promisify(execFile)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_BACKGROUND_")))
const settle = () => new Promise(resolve => setTimeout(resolve, 200))

test("two real monitors have a bounded generic-hook fallback cost across families", async t => {
  try { await exec("tmux", ["-V"], { env }) } catch { return t.skip("tmux unavailable") }
  t.mock.timers.enable({ apis: ["setInterval"] })
  const directory = await mkdtemp(join(tmpdir(), "task-routing-budget-"))
  const socket = `routing-budget-${process.pid}-${Date.now()}`
  const counts = { creator: 0, same: 0, unrelated: 0 }
  const run = async (args: string[]) => (await exec("tmux", ["-L", socket, ...args], { env })).stdout.trim()
  const adapter = (name: keyof typeof counts) => ({ run: (args: string[]) => { counts[name]++; return run(args) } })
  const owner = new BackgroundTasks(adapter("creator"), { metadataDirectory: directory })
  const same = new BackgroundTaskWatcher(adapter("same"), { metadataDirectory: directory })
  const unrelated = new BackgroundTaskWatcher(adapter("unrelated"), { metadataDirectory: directory })
  const stops: Array<() => void> = []
  let visible = 0
  let unrelatedVisible = 0
  await run(["new-session", "-d", "-s", "bootstrap"])
  try {
    stops.push(await same.watch({ subtreeRootId: "root", routingFamilyId: "family" }, tasks => { visible = tasks.length }))
    stops.push(await unrelated.watch({ subtreeRootId: "other-root", routingFamilyId: "other" }, tasks => { unrelatedVisible = tasks.length }))
    await settle()
    counts.creator = counts.same = counts.unrelated = 0
    for (let i = 0; i < 2; i++) {
      await owner.create({ kind: "monitor", label: `monitor-${i}`, familyId: "family", rootId: "root", parentId: "root", cwd: "/tmp", command: "sleep", args: ["60"], remainOnExit: true })
      await settle()
    }
    assert.equal(visible, 2)
    assert.equal(unrelatedVisible, 0)
    t.diagnostic(`creation-triggered calls: ${JSON.stringify(counts)}; safety sweep calls: 0 (interval clock held)`)
    assert.ok(counts.creator <= 100, "creator call budget")
    // Hooks intentionally remain generic, including after-set-option. This is
    // not a zero-call isolation claim for real tmux creation.
    assert.ok(counts.same <= 180, "same-family hook fallback budget")
    assert.ok(counts.unrelated <= 180, "unrelated-family hook fallback budget")
    const before = { ...counts }
    await settle()
    assert.deepEqual(counts, before, "idle before the safety sweep costs no tmux calls")
  } finally {
    for (const stop of stops) stop()
    await settle()
    await run(["kill-server"]).catch(() => undefined)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    t.mock.timers.reset()
  }
})
