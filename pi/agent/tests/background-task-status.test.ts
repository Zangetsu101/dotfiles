import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import backgroundTaskStatusExtension, { formatRunningTasks } from "../extensions/background-task-status.ts"
import type { BackgroundTask } from "../extensions/lib/background-task.ts"

function task(kind: BackgroundTask["kind"], status: BackgroundTask["status"]): BackgroundTask {
  return { id: `${kind}-${status}`, kind, label: kind, status, target: kind, parent: "", cwd: "/repo", statusFile: "/tmp/status" }
}

test("statusline follows authoritative metadata and releases its subscription on shutdown", async () => {
  const handlers = new Map<string, (event: any, ctx: any) => any>()
  const statuses: Array<string | undefined> = []
  let notify: ((tasks: BackgroundTask[]) => void) | undefined
  const tasks = {
    async watchMetadata(_query: unknown, listener: (tasks: BackgroundTask[]) => void) {
      notify = listener
      listener([])
      return () => { notify = undefined }
    },
  }
  const pi = { events: new EventEmitter(), on: (name: string, handler: any) => handlers.set(name, handler) } as any
  const ctx = {
    hasUI: true, cwd: "/repo",
    sessionManager: { getSessionId: () => "status-runtime", getBranch: () => [] },
    ui: { setStatus: (_key: string, status: string | undefined) => statuses.push(status) },
  }
  backgroundTaskStatusExtension(pi, { tasks: tasks as any })
  await handlers.get("session_start")!({ reason: "startup" }, ctx)
  notify!([task("agent", "running"), task("monitor", "running")])
  assert.equal(statuses.at(-1), "tasks: 1 agent · 1 monitor")
  notify!([task("agent", "succeeded")])
  assert.equal(statuses.at(-1), undefined)
  await handlers.get("session_shutdown")!({}, ctx)
  assert.equal(notify, undefined)
  assert.equal(statuses.at(-1), undefined)
})

test("pending status subscriptions cannot update UI or survive shutdown or a newer tree restore", async () => {
  for (const replacement of ["session_shutdown", "session_tree"]) {
    const handlers = new Map<string, (event: any, ctx: any) => any>()
    const statuses: Array<string | undefined> = []
    const pending: Array<{ notify: (tasks: BackgroundTask[]) => void; release: () => void }> = []
    const listeners = new Set<unknown>()
    const tasks = {
      async watchMetadata(_query: unknown, notify: (tasks: BackgroundTask[]) => void) {
        await new Promise<void>((release) => { pending.push({ notify, release }) })
        listeners.add(notify)
        notify([task("agent", "running")])
        return () => { listeners.delete(notify) }
      },
    }
    const pi = { on: (name: string, handler: any) => handlers.set(name, handler) } as any
    const ctx = {
      hasUI: true, cwd: "/repo",
      sessionManager: { getSessionId: () => "status-race", getBranch: () => [] },
      ui: { setStatus: (_key: string, status: string | undefined) => statuses.push(status) },
    }
    backgroundTaskStatusExtension(pi, { tasks: tasks as any })
    const old = handlers.get("session_start")!({ reason: "startup" }, ctx)
    const next = handlers.get(replacement)!({}, ctx)
    if (replacement === "session_tree") pending[1]!.release()
    await next
    const before = [...statuses]
    pending[0]!.release()
    await old
    pending[0]!.notify([task("monitor", "running")])
    assert.deepEqual(statuses, before)
    assert.equal(listeners.size, replacement === "session_tree" ? 1 : 0)
    await handlers.get("session_shutdown")!({}, ctx)
    assert.equal(listeners.size, 0)
  }
})

test("status line shows running activity age and clears finished assignments", () => {
  const working = { ...task("agent", "running"), label: "tests", progress: { assignment: "one", latest: { id: "report", state: "blocked" as const, activity: "Waiting for token", at: 1000 }, history: [] } }
  assert.match(formatRunningTasks([working], undefined, 6000)!, /tests: blocked: Waiting for token \(5s ago\)/)
  assert.match(formatRunningTasks([working], undefined, 61000)!, /60s ago/)
  const completed = { ...working, status: "succeeded" as const, progress: { ...working.progress, latest: { ...working.progress.latest, state: "completed" as const, activity: "Tests pass" } } }
  for (const status of ["succeeded", "failed", "terminated", "interrupted", "completed"] as const) {
    assert.equal(formatRunningTasks([{ ...completed, status }], undefined, 6000), undefined)
    assert.equal(formatRunningTasks([working, { ...completed, status }], undefined, 6000), "tasks: 1 agent · tests: blocked: Waiting for token (5s ago)")
  }
})

test("a spawned agent does not count itself, but counts its descendants", () => {
  const self = { ...task("agent", "running"), id: "self", parentId: "root" }
  const child = { ...task("monitor", "running"), id: "child", parentId: "self" }
  assert.equal(formatRunningTasks([self], "self"), undefined)
  assert.equal(formatRunningTasks([self, child], "self"), "tasks: 1 monitor")
})

test("status line summarizes only running agents and monitors", () => {
  assert.equal(formatRunningTasks([
    task("agent", "running"),
    { ...task("agent", "running"), id: "agent-two" },
    task("monitor", "running"),
    task("monitor", "completed"),
  ]), "tasks: 2 agents · 1 monitor")
  assert.equal(formatRunningTasks([task("agent", "completed")]), undefined)
})
