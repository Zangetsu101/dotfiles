import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import backgroundMonitorExtension from "../extensions/background-monitor.ts"
import { BACKGROUND_ACTIVITY_FINISHED, BACKGROUND_ACTIVITY_STARTED } from "../extensions/lib/background-activity.ts"
import type { BackgroundTask, TaskCompletion } from "../extensions/lib/background-task.ts"

type Handler = (event: any, ctx: any) => any

class SharedTasks {
  tasks: BackgroundTask[] = []
  completions = new Map<string, TaskCompletion>()
  claimed = new Set<string>()
  terminations: Array<{ id: string; reason: string }> = []
  claimBarrier?: Promise<void>
  async available() { return true }
  async list(owner?: string) { return this.tasks.filter((task) => owner === undefined || task.owner === owner) }
  async claimCompletion(task: BackgroundTask) {
    await this.claimBarrier
    const completion = this.completions.get(task.id)
    if (!completion || this.claimed.has(task.id)) return undefined
    this.claimed.add(task.id)
    return completion
  }
  async setStatus(task: BackgroundTask, status: BackgroundTask["status"]) { task.status = status }
  async terminate(task: BackgroundTask, reason = "terminated by user") {
    if (task.status !== "running") return
    this.terminations.push({ id: task.id, reason })
    this.completions.set(task.id, { status: "cancelled", reason })
    task.status = "cancelled"
  }
}

function runningTask(id = "one"): BackgroundTask {
  return { id, kind: "monitor", label: `task ${id}`, status: "running", target: `target-${id}`, owner: "%test", parent: "", cwd: "/repo", statusFile: `/tmp/${id}` }
}

function runtime(shared: SharedTasks, confirmations: boolean[] = []) {
  const handlers = new Map<string, Handler[]>()
  const messages: any[] = []
  const notifications: string[] = []
  const prompts: string[] = []
  const events = new EventEmitter()
  const activity = { started: [] as string[], finished: [] as string[] }
  events.on(BACKGROUND_ACTIVITY_STARTED, (item) => activity.started.push(item.id))
  events.on(BACKGROUND_ACTIVITY_FINISHED, (item) => activity.finished.push(item.id))
  const pi = {
    events,
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]) },
    registerTool() {}, registerCommand() {},
    sendMessage(message: any) { messages.push(message) },
  } as any
  const ctx = {
    cwd: "/repo", hasUI: true,
    ui: {
      notify(message: string) { notifications.push(message) },
      async confirm(_title: string, message: string) { prompts.push(message); return confirmations.shift() ?? false },
    },
  }
  backgroundMonitorExtension(pi, { tasks: shared as any, pollMs: 5, owner: "%test" })
  return {
    messages, notifications, prompts, activity,
    async emit(name: string, event: any = {}) {
      let result
      for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx)
      return result
    },
  }
}

async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail("condition was not reached")
}

test("reload hands a running monitor to the replacement runtime and reports its completion once", async () => {
  const shared = new SharedTasks()
  shared.tasks.push(runningTask())
  const outgoing = runtime(shared)
  await outgoing.emit("session_start", { reason: "startup" })
  await outgoing.emit("session_shutdown", { reason: "reload" })

  const replacement = runtime(shared)
  await replacement.emit("session_start", { reason: "reload" })
  shared.completions.set("one", { status: "completed", exitCode: 0 })
  await eventually(() => replacement.messages.length === 1)

  assert.equal(shared.terminations.length, 0)
  assert.equal(outgoing.messages.length, 0)
  assert.deepEqual(outgoing.activity.finished, ["background-monitor:one"])
  assert.match(replacement.messages[0].content, /finished with exit code 0/)
  assert.deepEqual(replacement.activity.started, ["background-monitor:one"])
  assert.deepEqual(replacement.activity.finished, ["background-monitor:one"])
})

test("declining session replacement leaves the monitor and runtime untouched", async () => {
  const shared = new SharedTasks()
  shared.tasks.push(runningTask())
  const current = runtime(shared, [false])
  await current.emit("session_start", { reason: "startup" })

  assert.deepEqual(await current.emit("session_before_switch", { reason: "resume" }), { cancel: true })
  assert.match(current.prompts[0]!, /1 monitored task/)
  assert.match(current.prompts[0]!, /terminated/)
  assert.equal(shared.tasks[0]?.status, "running")
  assert.equal(shared.terminations.length, 0)
  await current.emit("session_shutdown", { reason: "reload" })
})

test("confirming switch and fork replacement cancels owned monitors but not agents", async () => {
  for (const beforeEvent of ["session_before_switch", "session_before_fork"]) {
    const shared = new SharedTasks()
    shared.tasks.push(runningTask(), { ...runningTask("agent"), kind: "agent" })
    const current = runtime(shared, [true])
    await current.emit("session_start", { reason: "startup" })

    assert.equal(await current.emit(beforeEvent, {}), undefined)
    await current.emit("session_shutdown", { reason: beforeEvent === "session_before_switch" ? "new" : "fork" })

    assert.deepEqual(shared.terminations.map((item) => item.id), ["one"])
    assert.match(shared.terminations[0]!.reason, /Pi session shutdown/)
    assert.equal(shared.tasks[1]?.status, "running")
  }
})

test("replacement and tree navigation do not warn when no owned monitor is running", async () => {
  const shared = new SharedTasks()
  shared.tasks.push({ ...runningTask("done"), status: "completed" })
  const current = runtime(shared)
  await current.emit("session_before_switch", { reason: "new" })
  await current.emit("session_before_fork", {})
  await current.emit("session_before_tree", {})
  assert.deepEqual(current.prompts, [])
})

test("shutdown waits for a racing completion instead of overwriting it with cancellation", async () => {
  const shared = new SharedTasks()
  shared.tasks.push(runningTask())
  shared.completions.set("one", { status: "completed", exitCode: 0 })
  let release!: () => void
  shared.claimBarrier = new Promise<void>((resolve) => { release = resolve })
  const current = runtime(shared)
  await current.emit("session_start", { reason: "startup" })

  const shutdown = current.emit("session_shutdown", { reason: "quit" })
  release()
  await shutdown

  assert.equal(shared.terminations.length, 0)
  assert.equal(shared.tasks[0]?.status, "completed")
  assert.equal(current.messages.length, 1)
  assert.match(current.messages[0].content, /finished with exit code 0/)
})

test("unavoidable shutdown durably cancels only running monitors and is idempotent", async () => {
  const shared = new SharedTasks()
  shared.tasks.push(runningTask(), { ...runningTask("done"), status: "completed" }, { ...runningTask("agent"), kind: "agent" })
  const current = runtime(shared)
  await current.emit("session_start", { reason: "startup" })

  await current.emit("session_shutdown", { reason: "quit" })
  await current.emit("session_shutdown", { reason: "quit" })

  assert.deepEqual(shared.terminations.map((item) => item.id), ["one"])
  assert.equal(shared.completions.get("one")?.status, "cancelled")
  assert.match(shared.completions.get("one")?.reason ?? "", /quit/)
  assert.equal(shared.tasks[1]?.status, "completed")
  assert.equal(shared.tasks[2]?.status, "running")
  assert.equal(current.messages.length, 0)
  assert.deepEqual(current.activity.finished, ["background-monitor:one"])
})
