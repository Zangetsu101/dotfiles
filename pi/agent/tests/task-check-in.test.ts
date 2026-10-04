import assert from "node:assert/strict"
import { mkdtemp, open, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { BackgroundTask, BackgroundTasks } from "../extensions/lib/background-task.ts"
import { createTaskCheckInScheduler } from "../extensions/lib/task-check-in.ts"
import { notifyRunningTask, readOutputTail } from "../extensions/lib/background-task-check-in.ts"

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

test("two scheduler instances claim a check-in once", async () => {
  const { statusFile, options, tick } = await fixture()
  const first = createTaskCheckInScheduler(options)
  const second = createTaskCheckInScheduler(options)
  let calls = 0
  await first.watch(statusFile, () => { calls++ })
  await second.watch(statusFile, () => { calls++ })
  await first.schedule(statusFile, 120)
  await second.watch(statusFile, () => { calls++ })
  await tick(120)
  assert.equal(calls, 1)
  first.stop(statusFile)
  second.stop(statusFile)
})

test("bounded output reads the tail of a large log", async () => {
  const { statusFile } = await fixture()
  const path = `${statusFile}.output`
  const file = await open(path, "w")
  try {
    await file.truncate(8_000_000)
    await file.write("last lines", 7_999_990)
  } finally { await file.close() }
  const tail = await readOutputTail(path)
  assert.ok(tail.length <= 4_000)
  assert.ok(tail.endsWith("last lines"))
})

test("output tails start at a UTF-8 boundary", async () => {
  const { statusFile } = await fixture()
  const path = `${statusFile}.output`
  await writeFile(path, `€${"a".repeat(3998)}`)
  const tail = await readOutputTail(path)
  assert.equal(tail, "a".repeat(3998))
})

test("completion during output collection suppresses the check-in", async () => {
  const { statusFile } = await fixture()
  const outputFile = `${statusFile}.output`
  await writeFile(outputFile, "progress")
  const task: BackgroundTask = { id: "child", kind: "monitor", label: "work", status: "running", statusFile, outputFile, parentId: "root", parent: "root", target: "%child", cwd: "/tmp" }
  let checks = 0
  const tasks: Pick<BackgroundTasks, "completion" | "list"> = {
    async completion() { return ++checks === 2 ? { status: "completed" } : undefined },
    async list() { return [task] },
  }
  const messages: Parameters<ExtensionAPI["sendMessage"]>[0][] = []
  const pi: Pick<ExtensionAPI, "sendMessage"> = { sendMessage(message) { messages.push(message) } }
  await notifyRunningTask(pi, tasks, task, () => true)
  assert.equal(checks, 2)
  assert.deepEqual(messages, [])
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
