import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import backgroundMonitorExtension, { formatTaskTree, taskArgumentCompletions } from "../extensions/background-monitor.ts"
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
  async list(query?: { subtreeRootId: string }) {
    if (!query) return this.tasks
    const descendants = new Set([query.subtreeRootId])
    for (let changed = true; changed;) {
      changed = false
      for (const task of this.tasks) {
        if (task.parentId && descendants.has(task.parentId) && !descendants.has(task.id)) {
          descendants.add(task.id)
          changed = true
        }
      }
    }
    return this.tasks.filter((task) => descendants.has(task.id))
  }
  subtree(root: BackgroundTask, tasks: BackgroundTask[]) {
    const descendants = new Set([root.id])
    for (let changed = true; changed;) {
      changed = false
      for (const task of tasks) {
        if (task.parentId && descendants.has(task.parentId) && !descendants.has(task.id)) {
          descendants.add(task.id)
          changed = true
        }
      }
    }
    return tasks.filter((task) => descendants.has(task.id))
  }
  async claimCompletion(task: BackgroundTask) {
    await this.claimBarrier
    const completion = this.completions.get(task.id)
    if (!completion || this.claimed.has(task.id)) return undefined
    this.claimed.add(task.id)
    return completion
  }
  async claimCompletionOrReconcile(task: BackgroundTask) { return this.claimCompletion(task) }
  async setStatus(task: BackgroundTask, status: BackgroundTask["status"]) { task.status = status }
  async terminate(task: BackgroundTask, reason = "terminated by user") {
    if (task.status !== "running") return []
    this.terminations.push({ id: task.id, reason })
    this.completions.set(task.id, { status: "cancelled", reason })
    task.status = "terminated"
    return [task]
  }
}

function runningTask(id = "one"): BackgroundTask {
  return { id, kind: "monitor", label: `task ${id}`, status: "running", target: `target-${id}`, parent: "%test", parentId: "%test", cwd: "/repo", statusFile: `/tmp/${id}` }
}

function runtime(shared: SharedTasks, confirmations: boolean[] = [], subtreeRootId: string | null = "%test") {
  const handlers = new Map<string, Handler[]>()
  const messages: any[] = []
  const notifications: string[] = []
  const prompts: string[] = []
  const events = new EventEmitter()
  const activity = { started: [] as string[], finished: [] as string[] }
  events.on(BACKGROUND_ACTIVITY_STARTED, (item) => activity.started.push(item.id))
  events.on(BACKGROUND_ACTIVITY_FINISHED, (item) => activity.finished.push(item.id))
  const commands = new Map<string, any>()
  const pi = {
    events,
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]) },
    registerTool() {}, registerCommand(name: string, command: any) { commands.set(name, command) },
    sendMessage(message: any) { messages.push(message) },
  } as any
  const ctx = {
    cwd: "/repo", hasUI: true,
    sessionManager: { getSessionId: () => "monitor-runtime", getBranch: () => [] },
    ui: {
      notify(message: string) { notifications.push(message) },
      async confirm(_title: string, message: string) { prompts.push(message); return confirmations.shift() ?? false },
    },
  }
  backgroundMonitorExtension(pi, { tasks: shared as any, pollMs: 5, ...(subtreeRootId === null ? {} : { subtreeRootId }) })
  return {
    messages, notifications, prompts, activity, commands,
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

test("task list formatting renders only the caller subtree as a tree", () => {
  const research = { ...runningTask("research"), label: "research", displayName: "research", parentId: "root" }
  const verify = { ...runningTask("verify"), label: "verify", displayName: "verify ← research", parentId: "research" }
  const sibling = { ...runningTask("sibling"), parentId: "other-root" }

  assert.equal(formatTaskTree([research, verify, sibling], "root"), [
    "research  monitor  running  research",
    "  verify ← research  monitor  running  verify",
  ].join("\n"))
})

test("task completion offers actions before a search term is typed", () => {
  assert.deepEqual(taskArgumentCompletions([], " ")?.map((item) => item.value), ["list", "attach", "parent", "return", "terminate", "clean"])
})

test("task list replaces the tasks command", async () => {
  const shared = new SharedTasks()
  shared.tasks.push(runningTask())
  const current = runtime(shared)

  assert.equal(current.commands.has("tasks"), false)
  await current.commands.get("task").handler("list", { ui: { notify: (message: string) => current.notifications.push(message) } })
  assert.match(current.notifications[0]!, /Background tasks:\ntask one  monitor  running  one/)
})

test("task completion searches task kind, status, label, id, and target", () => {
  const agent = { ...runningTask("agent-one"), kind: "agent" as const, label: "code review", status: "succeeded" as const }
  const monitor = { ...runningTask("monitor-one"), label: "build release", target: "release-target" }

  assert.deepEqual(taskArgumentCompletions([agent, monitor], "attach agent")?.map((item) => item.value), ["attach agent-one"])
  assert.deepEqual(taskArgumentCompletions([agent, monitor], "attach succeeded")?.map((item) => item.value), ["attach agent-one"])
  assert.deepEqual(taskArgumentCompletions([agent, monitor], "attach release-target")?.map((item) => item.value), ["attach monitor-one"])
})

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

test("session replacement keeps running family work without prompting", async () => {
  for (const reason of ["new", "resume", "fork"]) {
    const shared = new SharedTasks()
    shared.tasks.push(runningTask())
    const current = runtime(shared)
    await current.emit("session_start", { reason: "startup" })
    await current.emit("session_shutdown", { reason })

    assert.deepEqual(current.prompts, [])
    assert.equal(shared.tasks[0]?.status, "running")
    assert.equal(shared.terminations.length, 0)
  }
})

test("replacement and tree navigation do not warn when no owned monitor is running", async () => {
  const shared = new SharedTasks()
  shared.tasks.push({ ...runningTask("done"), status: "succeeded" })
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
  assert.equal(shared.tasks[0]?.status, "succeeded")
  assert.equal(current.messages.length, 1)
  assert.match(current.messages[0].content, /finished with exit code 0/)
})

test("Root Pi quit can terminate an active nested descendant", async () => {
  const shared = new SharedTasks()
  shared.tasks.push(
    { ...runningTask("parent"), familyId: "family:monitor-runtime", parentId: "root:monitor-runtime", status: "succeeded" },
    { ...runningTask("nested"), familyId: "family:monitor-runtime", parentId: "parent" },
  )
  const current = runtime(shared, [true], null)
  await current.emit("session_start", { reason: "startup" })
  await current.emit("session_shutdown", { reason: "quit" })

  assert.match(current.prompts[0]!, /Terminate 1 running task/)
  assert.deepEqual(shared.terminations, [{ id: "nested", reason: "Root Pi quit" }])
})

test("Root Pi quit terminates a running subtree only through its highest running node", async () => {
  const shared = new SharedTasks()
  shared.tasks.push(
    { ...runningTask("parent"), familyId: "family:monitor-runtime", parentId: "root:monitor-runtime" },
    { ...runningTask("settled"), familyId: "family:monitor-runtime", parentId: "parent", status: "succeeded" },
    { ...runningTask("nested"), familyId: "family:monitor-runtime", parentId: "settled" },
  )
  const current = runtime(shared, [true], null)
  await current.emit("session_start", { reason: "startup" })
  await current.emit("session_shutdown", { reason: "quit" })

  assert.deepEqual(shared.terminations, [{ id: "parent", reason: "Root Pi quit" }])
})

test("Root Pi quit defaults to keeping work and can terminate running monitors", async () => {
  for (const terminate of [false, true]) {
    const shared = new SharedTasks()
    shared.tasks.push(runningTask(), { ...runningTask("done"), status: "succeeded" }, { ...runningTask("agent"), kind: "agent" })
    const current = runtime(shared, [terminate])
    await current.emit("session_start", { reason: "startup" })
    await current.emit("session_shutdown", { reason: "quit" })

    assert.match(current.prompts[0]!, /Terminate 2 running task/)
    assert.deepEqual(shared.terminations.map((item) => item.id), terminate ? ["one", "agent"] : [])
    assert.equal(shared.tasks[2]?.status, terminate ? "terminated" : "running")
  }
})
