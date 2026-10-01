import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createTaskCheckInScheduler } from "../extensions/lib/task-check-in.ts"

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "task-check-in-"))
  const statusFile = join(directory, "status")
  let now = 100
  const pending = new Map<number, () => void>()
  let next = 0
  const options = {
    now: () => now,
    setTimer: (callback: () => void, _delay: number) => {
      const id = ++next
      pending.set(id, callback)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => { pending.delete(timer as unknown as number) },
  }
  const tick = async (time: number) => {
    now = time
    const callbacks = [...pending.values()]
    pending.clear()
    for (const callback of callbacks) callback()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return { statusFile, options, tick }
}

test("restores a deadline after reload and claims it only once", async () => {
  const { statusFile, options, tick } = await fixture()
  const first = createTaskCheckInScheduler(options)
  await first.schedule(statusFile, 150)
  first.stop(statusFile)
  let calls = 0
  const second = createTaskCheckInScheduler(options)
  await second.watch(statusFile, () => { calls++ })
  await tick(150)
  const third = createTaskCheckInScheduler(options)
  await third.watch(statusFile, () => { calls++ })
  await tick(151)
  assert.equal(calls, 1)
  assert.equal(JSON.parse(await readFile(`${statusFile}.check-in`, "utf8")).deadline, 150)
  second.stop(statusFile)
  third.stop(statusFile)
})

test("rearm supersedes an old claim and completion suppresses notification", async () => {
  const { statusFile, options, tick } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  let calls = 0
  await scheduler.watch(statusFile, () => { calls++ })
  await scheduler.schedule(statusFile, 110)
  await tick(110)
  await scheduler.schedule(statusFile, 120)
  await tick(120)
  assert.equal(calls, 2)
  await scheduler.schedule(statusFile, 130)
  await writeFile(statusFile, "complete")
  await tick(130)
  assert.equal(calls, 2)
  await scheduler.cancel(statusFile)
  await assert.rejects(readFile(`${statusFile}.check-in`))
})

test("stop keeps the deadline; cancel removes it", async () => {
  const { statusFile, options, tick } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  let calls = 0
  await scheduler.watch(statusFile, () => { calls++ })
  await scheduler.schedule(statusFile, 120)
  scheduler.stop(statusFile)
  await tick(120)
  assert.equal(calls, 0)
  await scheduler.watch(statusFile, () => { calls++ })
  await tick(121)
  assert.equal(calls, 1)
  await scheduler.cancel(statusFile)
})
