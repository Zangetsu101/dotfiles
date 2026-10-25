import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { BackgroundTask, BackgroundTasks } from "../extensions/lib/background-task.ts"
import { createTaskCheckInScheduler } from "../extensions/lib/task-check-in.ts"
import { notifyRunningTask } from "../extensions/lib/background-task-check-in.ts"

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "task-check-in-"))
  const statusFile = join(directory, "status")
  let now = 100
  const pending = new Map<number, { due: number; callback: () => void | Promise<void> }>()
  let next = 0
  const options = {
    now: () => now,
    setTimer: (callback: () => void | Promise<void>, delay: number) => {
      const id = ++next
      pending.set(id, { due: now + delay, callback })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => { pending.delete(timer as unknown as number) },
  }
  const tick = async (time: number) => {
    now = time
    const firing: Array<void | Promise<void>> = []
    for (const [id, timer] of [...pending]) {
      if (timer.due > time) continue
      pending.delete(id)
      firing.push(timer.callback())
    }
    await Promise.all(firing)
  }
  // Timer callbacks can already be queued when canceled, or fire before a long deadline.
  const queued = () => [...pending].map(([id, timer]) => () => {
    pending.delete(id)
    return timer.callback()
  })
  return { statusFile, options, tick, queued, advance: (time: number) => { now = time } }
}

test("restores a deadline after reload and claims it only once", async () => {
  const { statusFile, options, tick } = await fixture()
  const first = createTaskCheckInScheduler(options)
  await first.schedule(statusFile, 150)
  first.stop(statusFile)
  let calls = 0
  const second = createTaskCheckInScheduler(options)
  await second.watch(statusFile, () => { calls++ })
  await tick(149)
  assert.equal(calls, 0)
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
  await tick(109); assert.equal(calls, 0)
  await tick(110); assert.equal(calls, 1)
  await tick(111); assert.equal(calls, 1)
  await scheduler.schedule(statusFile, 120)
  await tick(119); assert.equal(calls, 1)
  await tick(120); assert.equal(calls, 2)
  await tick(121); assert.equal(calls, 2)
  await scheduler.schedule(statusFile, 130)
  await writeFile(statusFile, "complete")
  await tick(130)
  assert.equal(calls, 2)
  scheduler.stop(statusFile)
})

test("two scheduler instances claim a check-in once", async (context) => {
  const errors = context.mock.method(console, "error", () => {})
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
  assert.deepEqual(errors.mock.calls, [])
  first.stop(statusFile)
  second.stop(statusFile)
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

test("a suppressed check-in can be delivered after its parent resumes", async () => {
  const { statusFile, options, tick } = await fixture()
  const first = createTaskCheckInScheduler(options)
  await first.watch(statusFile, () => false)
  await first.schedule(statusFile, 120)
  await tick(120)
  first.stop(statusFile)
  let calls = 0
  const resumed = createTaskCheckInScheduler(options)
  await resumed.watch(statusFile, () => { calls++ })
  await tick(121)
  assert.equal(calls, 1)
  resumed.stop(statusFile)
})

test("check-in reports task start time and running status", async (context) => {
  context.mock.method(Date, "now", () => 1_000_000)
  const { statusFile } = await fixture()
  const task: BackgroundTask = { id: "child", kind: "monitor", label: "work", status: "running", statusFile, startedAt: 850_000, parentId: "root", parent: "root", target: "%child", cwd: "/tmp" }
  const tasks: Pick<BackgroundTasks, "completion" | "list"> = {
    async completion() { return undefined },
    async list() { return [task] },
  }
  const messages: Parameters<ExtensionAPI["sendMessage"]>[0][] = []
  const pi: Pick<ExtensionAPI, "sendMessage"> = { sendMessage(message) { messages.push(message) } }
  await notifyRunningTask(pi, tasks, task, () => true)
  assert.match(messages[0]!.content, /status: running; elapsed: 2 minutes/)
})

test("non-finite deadlines are rejected without replacing a scheduled check-in", async () => {
  const { statusFile, options, tick } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  let calls = 0
  await scheduler.watch(statusFile, () => { calls++ })
  await scheduler.schedule(statusFile, 120)
  for (const deadline of [NaN, Infinity, -Infinity]) {
    await assert.rejects(scheduler.schedule(statusFile, deadline), RangeError)
  }
  await tick(120)
  assert.equal(calls, 1)
  scheduler.stop(statusFile)
})

test("timer requests respect deadlines and the platform delay limit", async () => {
  const { statusFile, options } = await fixture()
  const delays: number[] = []
  const scheduler = createTaskCheckInScheduler({
    ...options,
    setTimer(callback, delay) {
      delays.push(delay)
      return options.setTimer(callback, delay)
    },
  })
  await scheduler.watch(statusFile, () => {})
  await scheduler.schedule(statusFile, 150)
  await scheduler.schedule(statusFile, 99)
  await scheduler.schedule(statusFile, 3_000_000_100)
  assert.deepEqual(delays, [50, 0, 2_147_483_647])
  scheduler.stop(statusFile)
})

test("an early timer wakeup waits until the deadline", async () => {
  const { statusFile, options, tick, queued } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  let calls = 0
  await scheduler.watch(statusFile, () => { calls++ })
  await scheduler.schedule(statusFile, 150)
  await queued()[0]!()
  assert.equal(calls, 0)
  await tick(149)
  assert.equal(calls, 0)
  await tick(150)
  assert.equal(calls, 1)
  scheduler.stop(statusFile)
})

test("a canceled but already queued timer cannot notify after stop", async () => {
  const { statusFile, options, tick, queued } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  let calls = 0
  await scheduler.watch(statusFile, () => { calls++ })
  await scheduler.schedule(statusFile, 100)
  const callback = queued()[0]!
  scheduler.stop(statusFile)
  await callback()
  await tick(101)
  assert.equal(calls, 0)
})

test("a suppressed check-in retries after one second, not before", async () => {
  const { statusFile, options, tick } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  let calls = 0
  await scheduler.watch(statusFile, () => ++calls > 1)
  await scheduler.schedule(statusFile, 120)
  await tick(120)
  assert.equal(calls, 1)
  await tick(1119)
  assert.equal(calls, 1)
  await tick(1120)
  assert.equal(calls, 2)
  await tick(2120)
  assert.equal(calls, 2)
  scheduler.stop(statusFile)
})

test("stopping while a check-in is suppressed prevents retry wakeups", async () => {
  const { statusFile, options, tick, queued } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  let calls = 0
  await scheduler.watch(statusFile, () => {
    calls++
    scheduler.stop(statusFile)
    return false
  })
  await scheduler.schedule(statusFile, 120)
  await tick(120)
  assert.equal(queued().length, 0)
  await tick(1120)
  assert.equal(calls, 1)
})

test("a queued superseded timer cannot steal the replacement deadline", async () => {
  const { statusFile, options, tick, queued } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  let calls = 0
  await scheduler.watch(statusFile, () => { calls++ })
  await scheduler.schedule(statusFile, 100)
  const stale = queued()[0]!
  await scheduler.schedule(statusFile, 150)
  await stale()
  assert.equal(calls, 0)
  await tick(150)
  assert.equal(calls, 1)
  scheduler.stop(statusFile)
})

test("stop keeps the deadline across a reload", async () => {
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
  scheduler.stop(statusFile)
})

test("invalid persisted deadline shapes do not arm a check-in", async () => {
  for (const state of [null, 1, "bad", {}, { id: "a" }, { deadline: 120 }, { id: 1, deadline: 120 }, { id: "a", deadline: "120" }]) {
    const { statusFile, options, queued } = await fixture()
    await writeFile(`${statusFile}.check-in`, JSON.stringify(state))
    const scheduler = createTaskCheckInScheduler(options)
    await scheduler.watch(statusFile, () => assert.fail("invalid deadline notified"))
    assert.equal(queued().length, 0)
    scheduler.stop(statusFile)
  }
})

test("watch reports corrupt JSON instead of silently losing a deadline", async () => {
  const { statusFile, options } = await fixture()
  await writeFile(`${statusFile}.check-in`, "{broken")
  const scheduler = createTaskCheckInScheduler(options)
  await assert.rejects(scheduler.watch(statusFile, () => {}), SyntaxError)
  scheduler.stop(statusFile)
})

test("a failed deadline replacement removes its temporary file and can be retried", async () => {
  const { statusFile, options, tick, queued } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  let calls = 0
  await scheduler.watch(statusFile, () => { calls++ })
  await mkdir(`${statusFile}.check-in`)
  await assert.rejects(scheduler.schedule(statusFile, 120), { code: "EISDIR" })
  assert.deepEqual(await readdir(join(statusFile, "..")), ["status.check-in"])
  assert.equal(queued().length, 0)
  await rm(`${statusFile}.check-in`, { recursive: true })
  await scheduler.schedule(statusFile, 150)
  await tick(150)
  assert.equal(calls, 1)
  scheduler.stop(statusFile)
})

test("watch propagates filesystem read errors without arming a timer", async () => {
  const { statusFile, options, queued } = await fixture()
  await mkdir(`${statusFile}.check-in`)
  const scheduler = createTaskCheckInScheduler(options)
  await assert.rejects(scheduler.watch(statusFile, () => assert.fail("unreadable deadline notified")), { code: "EISDIR" })
  assert.equal(queued().length, 0)
  scheduler.stop(statusFile)
})

test("a timer reports a corrupted deadline and accepts a later replacement", async (context) => {
  const errors = context.mock.method(console, "error", () => {})
  const { statusFile, options, tick } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  let calls = 0
  await scheduler.watch(statusFile, () => { calls++ })
  await scheduler.schedule(statusFile, 120)
  await writeFile(`${statusFile}.check-in`, "{broken")
  await tick(120)
  assert.equal(calls, 0)
  assert.equal(errors.mock.callCount(), 1)
  assert.equal(errors.mock.calls[0]!.arguments[0], "background task check-in failed:")
  assert.ok(errors.mock.calls[0]!.arguments[1] instanceof SyntaxError)
  await scheduler.schedule(statusFile, 150)
  await tick(150)
  assert.equal(calls, 1)
  scheduler.stop(statusFile)
})

test("a claim permission failure is reported instead of treated as a duplicate", async (context) => {
  if (process.getuid?.() === 0) return context.skip("root bypasses directory write permissions")
  const errors = context.mock.method(console, "error", () => {})
  const { statusFile, options, tick } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  let calls = 0
  await scheduler.watch(statusFile, () => { calls++ })
  await scheduler.schedule(statusFile, 120)
  const directory = join(statusFile, "..")
  await chmod(directory, 0o500)
  try {
    await tick(120)
    assert.equal(calls, 0)
    assert.equal(errors.mock.callCount(), 1)
    assert.equal((errors.mock.calls[0]!.arguments[1] as NodeJS.ErrnoException).code, "EACCES")
  } finally {
    await chmod(directory, 0o700)
    scheduler.stop(statusFile)
  }
})

test("an unreadable completion marker is reported rather than notifying", async (context) => {
  const errors = context.mock.method(console, "error", () => {})
  const { statusFile, options, tick } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  let calls = 0
  await scheduler.watch(statusFile, () => { calls++ })
  await scheduler.schedule(statusFile, 120)
  await symlink(statusFile, statusFile)
  await tick(120)
  assert.equal(calls, 0)
  assert.equal(errors.mock.callCount(), 1)
  assert.equal((errors.mock.calls[0]!.arguments[1] as NodeJS.ErrnoException).code, "ELOOP")
  scheduler.stop(statusFile)
})

test("a transient callback rejection retries after one second and claims success across reload", async (context) => {
  const errors = context.mock.method(console, "error", () => {})
  const { statusFile, options, tick } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  const failure = new Error("notification unavailable")
  let calls = 0
  await scheduler.watch(statusFile, async () => {
    if (++calls === 1) throw failure
  })
  await scheduler.schedule(statusFile, 120)
  await tick(120)
  assert.equal(errors.mock.callCount(), 1)
  assert.deepEqual(errors.mock.calls[0]!.arguments, ["background task check-in failed:", failure])
  await tick(1120)
  assert.equal(calls, 2)
  scheduler.stop(statusFile)
  const resumed = createTaskCheckInScheduler(options)
  await resumed.watch(statusFile, () => { calls++ })
  await tick(1200)
  assert.equal(calls, 2)
  resumed.stop(statusFile)
})

test("live retry uses the persisted rejection deadline even when bookkeeping takes time", async (context) => {
  context.mock.method(console, "error", () => {})
  const { statusFile, options, tick, advance } = await fixture()
  let rejected = false
  const scheduler = createTaskCheckInScheduler({
    ...options,
    now() {
      const time = options.now()
      if (rejected) {
        rejected = false
        advance(620)
      }
      return time
    },
  })
  let calls = 0
  await scheduler.watch(statusFile, () => {
    if (++calls === 1) {
      rejected = true
      throw new Error("offline")
    }
  })
  await scheduler.schedule(statusFile, 120)
  await tick(120)
  await tick(1119)
  assert.equal(calls, 1)
  await tick(1120)
  assert.equal(calls, 2)
  scheduler.stop(statusFile)
})

test("callback exceptions have three persisted backoffs then terminal failure, even across schedulers", async (context) => {
  const errors = context.mock.method(console, "error", () => {})
  const { statusFile, options, tick, queued } = await fixture()
  let scheduler = createTaskCheckInScheduler(options)
  const attempts: number[] = []
  const callback = () => {
    attempts.push(options.now())
    throw new Error("offline")
  }
  await scheduler.watch(statusFile, callback)
  await scheduler.schedule(statusFile, 120)
  await tick(120)
  for (const [before, due] of [[1119, 1120], [6119, 6120], [36119, 36120]]) {
    scheduler.stop(statusFile)
    scheduler = createTaskCheckInScheduler(options)
    const competitor = createTaskCheckInScheduler(options)
    await scheduler.watch(statusFile, callback)
    await competitor.watch(statusFile, callback)
    const count = attempts.length
    await tick(before!)
    assert.equal(attempts.length, count)
    await tick(due!)
    assert.equal(attempts.length, count + 1)
    competitor.stop(statusFile)
  }
  assert.deepEqual(attempts, [120, 1120, 6120, 36120])
  assert.equal(queued().length, 0)
  assert.match(String(errors.mock.calls.at(-1)!.arguments[0]), /terminal failure.*4 callback exceptions/)
  scheduler.stop(statusFile)
  scheduler = createTaskCheckInScheduler(options)
  await scheduler.watch(statusFile, callback)
  await tick(100_000)
  assert.equal(attempts.length, 4)
  await scheduler.schedule(statusFile, 100_100)
  await tick(100_100)
  assert.equal(attempts.length, 5)
  scheduler.stop(statusFile)
})

test("completion, replacement, or stop while a callback rejects cancels its retry", async (context) => {
  context.mock.method(console, "error", () => {})
  for (const action of ["complete", "replace", "stop"] as const) {
    const { statusFile, options, tick, queued } = await fixture()
    const scheduler = createTaskCheckInScheduler(options)
    let calls = 0
    let reject!: (error: Error) => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    await scheduler.watch(statusFile, () => {
      calls++
      if (calls > 1) return
      started()
      return new Promise<void>((_, fail) => { reject = fail })
    })
    await scheduler.schedule(statusFile, 120)
    const firing = tick(120)
    await ready
    if (action === "complete") await writeFile(statusFile, "complete")
    if (action === "replace") await scheduler.schedule(statusFile, 200)
    if (action === "stop") scheduler.stop(statusFile)
    reject(new Error("offline"))
    await firing
    assert.equal(queued().length, action === "replace" ? 1 : 0)
    await tick(199)
    assert.equal(calls, 1)
    await tick(200)
    assert.equal(calls, action === "replace" ? 2 : 1)
    await tick(40_000)
    assert.equal(calls, action === "replace" ? 2 : 1)
    scheduler.stop(statusFile)
  }
})

test("a stopped watcher cannot rearm a new watch while its rejection settles", async (context) => {
  context.mock.method(console, "error", () => {})
  const { statusFile, options, tick, queued } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let reject!: (error: Error) => void
  let calls = 0
  const callback = () => {
    calls++
    started()
    return new Promise<void>((_, fail) => { reject = fail })
  }
  await scheduler.watch(statusFile, callback)
  await scheduler.schedule(statusFile, 120)
  const firing = tick(120)
  await ready
  scheduler.stop(statusFile)
  await scheduler.watch(statusFile, callback)
  await tick(121)
  reject(new Error("offline"))
  await firing
  assert.equal(queued().length, 0)
  await tick(1121)
  assert.equal(calls, 1)
  scheduler.stop(statusFile)
})

test("suppression does not consume the exception retry budget", async (context) => {
  context.mock.method(console, "error", () => {})
  const { statusFile, options, tick } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  let calls = 0
  await scheduler.watch(statusFile, () => {
    calls++
    if (calls === 1 || calls === 3 || calls === 5) throw new Error("offline")
    return calls === 7
  })
  await scheduler.schedule(statusFile, 120)
  for (const due of [120, 1120, 2120, 7120, 8120, 38120, 39120]) await tick(due)
  assert.equal(calls, 7)
  await tick(100_000)
  assert.equal(calls, 7)
  scheduler.stop(statusFile)
})

test("invalid retry state fails closed rather than resetting the exception budget", async (context) => {
  const errors = context.mock.method(console, "error", () => {})
  for (const retry of [null, {}, { failures: 0, deadline: 120 }, { failures: 4, deadline: 120 },
    { failures: 1.5, deadline: 120 }, { failures: "1", deadline: 120 }, { failures: 1, deadline: "120" }]) {
    const { statusFile, options, tick, queued } = await fixture()
    const scheduler = createTaskCheckInScheduler(options)
    await scheduler.schedule(statusFile, 120)
    const { id } = JSON.parse(await readFile(`${statusFile}.check-in`, "utf8"))
    await writeFile(`${statusFile}.check-in.${id}.retry`, JSON.stringify(retry))
    let calls = 0
    await scheduler.watch(statusFile, () => { calls++ })
    await tick(120)
    assert.equal(calls, 0)
    assert.equal(queued().length, 0)
    assert.equal((errors.mock.calls.at(-1)!.arguments[1] as Error).message, "invalid check-in retry state")
    scheduler.stop(statusFile)
    const resumed = createTaskCheckInScheduler(options)
    await resumed.watch(statusFile, () => { calls++ })
    await tick(1120)
    assert.equal(calls, 0)
    resumed.stop(statusFile)
  }
})

test("retry sidecar read and write failures retain the claim without automatic filesystem retries", async (context) => {
  const errors = context.mock.method(console, "error", () => {})
  for (const operation of ["read", "write"] as const) {
    const { statusFile, options, tick, queued } = await fixture()
    const scheduler = createTaskCheckInScheduler(options)
    await scheduler.schedule(statusFile, 120)
    const { id } = JSON.parse(await readFile(`${statusFile}.check-in`, "utf8"))
    const retryFile = `${statusFile}.check-in.${id}.retry`
    if (operation === "read") await mkdir(retryFile)
    let calls = 0
    await scheduler.watch(statusFile, async () => {
      calls++
      await mkdir(retryFile)
      throw new Error("offline")
    })
    await tick(120)
    assert.equal(calls, operation === "write" ? 1 : 0)
    assert.equal((errors.mock.calls.at(-1)!.arguments[1] as NodeJS.ErrnoException).code, "EISDIR")
    assert.equal(queued().length, 0)
    await rm(retryFile, { recursive: true })
    scheduler.stop(statusFile)
    const resumed = createTaskCheckInScheduler(options)
    await resumed.watch(statusFile, () => { calls++ })
    await tick(1120)
    assert.equal(calls, operation === "write" ? 1 : 0)
    resumed.stop(statusFile)
  }
})

test("a crash-held claim is not reclaimed even with persisted retry state", async () => {
  const { statusFile, options, tick } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  await scheduler.schedule(statusFile, 120)
  const { id } = JSON.parse(await readFile(`${statusFile}.check-in`, "utf8"))
  await writeFile(`${statusFile}.check-in.${id}.claimed`, "")
  await writeFile(`${statusFile}.check-in.${id}.retry`, JSON.stringify({ failures: 1, deadline: 1120 }))
  await scheduler.watch(statusFile, () => assert.fail("crash-held claim redelivered"))
  await tick(120)
  await tick(1120)
  scheduler.stop(statusFile)
})

test("stopping or replacing a pending retry removes the old wakeup", async (context) => {
  context.mock.method(console, "error", () => {})
  for (const action of ["stop", "replace"] as const) {
    const { statusFile, options, tick, queued } = await fixture()
    const scheduler = createTaskCheckInScheduler(options)
    let calls = 0
    await scheduler.watch(statusFile, () => {
      if (++calls === 1) throw new Error("offline")
    })
    await scheduler.schedule(statusFile, 120)
    await tick(120)
    assert.equal(queued().length, 1)
    if (action === "stop") scheduler.stop(statusFile)
    else await scheduler.schedule(statusFile, 200)
    assert.equal(queued().length, action === "stop" ? 0 : 1)
    await tick(200)
    await tick(1120)
    assert.equal(calls, action === "stop" ? 1 : 2)
    scheduler.stop(statusFile)
  }
})

test("completion during a suppressed callback prevents retry", async () => {
  const { statusFile, options, tick, queued } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  await scheduler.watch(statusFile, async () => {
    await writeFile(statusFile, "complete")
    return false
  })
  await scheduler.schedule(statusFile, 120)
  await tick(120)
  assert.equal(queued().length, 0)
  scheduler.stop(statusFile)
})

test("rescheduling during suppression preserves the replacement deadline", async () => {
  const { statusFile, options, tick } = await fixture()
  const scheduler = createTaskCheckInScheduler(options)
  let calls = 0
  await scheduler.watch(statusFile, async () => {
    if (++calls === 1) {
      await scheduler.schedule(statusFile, 200)
      return false
    }
  })
  await scheduler.schedule(statusFile, 120)
  await tick(120)
  await tick(199)
  assert.equal(calls, 1)
  await tick(200)
  assert.equal(calls, 2)
  scheduler.stop(statusFile)
})
