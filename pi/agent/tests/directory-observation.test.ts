import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sharedDirectoryObservation } from "../extensions/lib/directory-observation.ts"

const realSetTimeout = globalThis.setTimeout

async function waitForRealIO(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  do {
    await new Promise(resolve => realSetTimeout(resolve, 10))
    if (predicate()) return
  } while (Date.now() < deadline)
  assert.ok(predicate(), "filesystem operation did not settle before the real-time deadline")
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(predicate())
}

test("subscribers attach before initial delivery and survive another subscriber leaving", async () => {
  const directory = await mkdtemp(join(tmpdir(), "directory-observation-"))
  let first = 0, second = 0
  const stopFirst = await sharedDirectoryObservation.watch(directory, () => {
    if (++first === 1) void writeFile(join(directory, "initial"), "committed")
  })
  const stopSecond = await sharedDirectoryObservation.watch(join(directory, "."), () => { second++ })
  try {
    assert.ok(first >= 1)
    assert.ok(second >= 1)
    await waitFor(() => first > 1)
    stopFirst()
    const before = second
    const stopped = first
    await writeFile(join(directory, "next"), "committed")
    await waitFor(() => second > before)
    assert.equal(first, stopped)
  } finally { stopFirst(); stopSecond(); await rm(directory, { recursive: true, force: true }) }
})

test("directories share one watcher and one safety sweep, and release both when idle", async t => {
  const directory = await mkdtemp(join(tmpdir(), "directory-resources-"))
  const other = join(directory, "other")
  const originalWatch = fs.watch
  let opened = 0, closed = 0
  t.mock.method(fs, "watch", (...args: Parameters<typeof fs.watch>) => {
    opened++
    const watcher = originalWatch(...args)
    const close = watcher.close.bind(watcher)
    watcher.close = () => { closed++; return close() }
    return watcher
  })
  syncBuiltinESMExports()
  t.mock.timers.enable({ apis: ["setInterval"] })
  const intervals = t.mock.method(globalThis, "setInterval")
  const clears = t.mock.method(globalThis, "clearInterval")
  let first = 0, second = 0
  const [one, two] = await Promise.all([
    sharedDirectoryObservation.watch(directory, () => { first++ }),
    sharedDirectoryObservation.watch(join(directory, "."), () => {}),
  ])
  const three = await sharedDirectoryObservation.watch(other, () => { second++ })
  let later = 0
  const four = await sharedDirectoryObservation.watch(directory, () => { later++ })
  try {
    assert.equal(later, 1, "a later same-directory subscription receives its initial invalidation before resolving")
    four()
    assert.equal(opened, 2)
    assert.equal(intervals.mock.calls.length, 1)
    const before = [first, second]
    t.mock.timers.tick(29_999)
    assert.deepEqual([first, second], before)
    t.mock.timers.tick(1)
    assert.deepEqual([first, second], [before[0] + 1, before[1] + 1])
    one(); two()
    assert.equal(closed, 1)
    assert.equal(clears.mock.calls.length, 0, "the other directory still needs the sweep")
    const remaining = [first, second]
    t.mock.timers.tick(30_000)
    assert.deepEqual([first, second], [remaining[0], remaining[1] + 1])
    assert.equal(intervals.mock.calls.length, 1, "the remaining directory uses the original sweep")
    three()
    assert.equal(closed, 2)
    assert.equal(clears.mock.calls.length, 1, "the last unsubscribe cancels the recurring timer")
    assert.equal(clears.mock.calls[0].arguments[0], intervals.mock.calls[0].result)
    const stopped = [first, second]
    t.mock.timers.tick(60_000)
    assert.deepEqual([first, second], stopped)
    const restart = await sharedDirectoryObservation.watch(directory, () => { first++ })
    restart()
    assert.equal(opened, 3)
    assert.equal(closed, 3)
    assert.equal(intervals.mock.calls.length, 2)
    assert.equal(clears.mock.calls.length, 2)
    assert.equal(clears.mock.calls[1].arguments[0], intervals.mock.calls[1].result)
  } finally {
    one(); two(); three(); four()
    t.mock.restoreAll()
    syncBuiltinESMExports()
    t.mock.timers.reset()
    await rm(directory, { recursive: true, force: true })
  }
})

test("directory recreation reconnects events without waiting for the safety sweep", async () => {
  const directory = await mkdtemp(join(tmpdir(), "directory-recreated-"))
  let calls = 0
  const stop = await sharedDirectoryObservation.watch(directory, () => { calls++ })
  try {
    const before = calls
    await rm(directory, { recursive: true, force: true })
    await mkdir(directory, { recursive: true })
    await waitFor(() => calls > before)
    // Allow the reattachment following the directory rename event to settle.
    await new Promise(resolve => setTimeout(resolve, 50))
    const attached = calls
    await writeFile(join(directory, "after-recreation"), "committed")
    await waitFor(() => calls > attached)
  } finally { stop(); await rm(directory, { recursive: true, force: true }) }
})

test("failed watchers retry with a bounded budget and stop callbacks on disposal", async t => {
  const directory = await mkdtemp(join(tmpdir(), "directory-retries-"))
  const originalWatch = fs.watch
  let opened = 0
  let underlying: fs.FSWatcher | undefined
  t.mock.method(fs, "watch", (...args: Parameters<typeof fs.watch>) => {
    opened++
    if (opened > 1) throw new Error("watch unavailable")
    underlying = originalWatch(...args)
    return underlying
  })
  t.mock.method(console, "error", () => {})
  syncBuiltinESMExports()
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  const retries = t.mock.method(globalThis, "setTimeout")
  let calls = 0
  const stop = await sharedDirectoryObservation.watch(directory, () => { calls++ })
  try {
    underlying!.emit("error", new Error("watch failed"))
    for (const delay of [100, 500, 2_000]) {
      const expected = opened + 1
      t.mock.timers.tick(delay)
      await waitForRealIO(() => opened === expected)
    }
    assert.equal(opened, 4)
    assert.equal(retries.mock.calls.length, 3, "failed attempts exhaust the retry timers")
    t.mock.timers.tick(10_000)
    assert.equal(opened, 4, "retries must stop until the safety sweep")
    t.mock.timers.tick(17_400)
    await waitForRealIO(() => opened === 5)
    assert.equal(opened, 5, "safety sweep starts a fresh recovery budget")
    stop()
    const stopped = calls
    t.mock.timers.tick(60_000)
    underlying!.emit("error", new Error("stale failure"))
    assert.equal(calls, stopped)
    assert.equal(opened, 5)
  } finally {
    stop()
    t.mock.restoreAll()
    syncBuiltinESMExports()
    t.mock.timers.reset()
    await rm(directory, { recursive: true, force: true })
  }
})

test("repeated asynchronous watcher failures cannot create an endless retry loop", async t => {
  const directory = await mkdtemp(join(tmpdir(), "directory-flapping-"))
  const originalWatch = fs.watch
  const watchers: fs.FSWatcher[] = []
  t.mock.method(fs, "watch", (...args: Parameters<typeof fs.watch>) => {
    const watcher = originalWatch(...args)
    watchers.push(watcher)
    return watcher
  })
  syncBuiltinESMExports()
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  const retries = t.mock.method(globalThis, "setTimeout")
  const stop = await sharedDirectoryObservation.watch(directory, () => {})
  try {
    for (const delay of [100, 500, 2_000]) {
      const expected = watchers.length + 1
      watchers.at(-1)!.emit("error", new Error("flapping watcher"))
      t.mock.timers.tick(delay)
      await waitForRealIO(() => watchers.length === expected)
    }
    watchers.at(-1)!.emit("error", new Error("flapping watcher"))
    assert.equal(retries.mock.calls.length, 3, "flapping watchers exhaust the retry timers")
    t.mock.timers.tick(10_000)
    assert.equal(watchers.length, 4)
  } finally {
    stop()
    t.mock.restoreAll()
    syncBuiltinESMExports()
    t.mock.timers.reset()
    await rm(directory, { recursive: true, force: true })
  }
})

test("ignored files do not notify their subscriber, but other files and the initial delivery still do", async () => {
  const directory = await mkdtemp(join(tmpdir(), "directory-ignore-"))
  let ignoring = 0, watching = 0
  const stopIgnoring = await sharedDirectoryObservation.watch(directory, () => { ignoring++ }, { ignore: ["output.log"] })
  const stopWatching = await sharedDirectoryObservation.watch(directory, () => { watching++ })
  try {
    await writeFile(join(directory, "output.log"), "")
    await waitForRealIO(() => watching > 1)
    const [ignoredBefore, watchedBefore] = [ignoring, watching]
    for (let write = 0; write < 5; write++) await writeFile(join(directory, "output.log"), `frame ${write}`, { flag: "a" })
    await waitForRealIO(() => watching > watchedBefore)
    await new Promise(resolve => realSetTimeout(resolve, 50))
    assert.equal(ignoring, ignoredBefore, "output writes reached the subscriber that ignores them")
    await writeFile(join(directory, "completion.json"), "{}")
    await waitForRealIO(() => ignoring > ignoredBefore)
    let initial = 0
    const stopInitial = await sharedDirectoryObservation.watch(directory, () => { initial++ }, { ignore: ["output.log", "completion.json"] })
    stopInitial()
    assert.equal(initial, 1, "a subscriber must receive its initial delivery whatever it ignores")
  } finally {
    stopIgnoring(); stopWatching()
    await rm(directory, { recursive: true, force: true })
  }
})
