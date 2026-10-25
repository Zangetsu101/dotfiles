import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reportAgentProgress } from "../extensions/lib/background-progress.ts"
import { familyForContext } from "../extensions/lib/background-family.ts"
import backgroundTaskStatusExtension, { formatRunningTasks } from "../extensions/background-task-status.ts"
import type { BackgroundTask } from "../extensions/lib/background-task.ts"

function task(kind: BackgroundTask["kind"], status: BackgroundTask["status"]): BackgroundTask {
  return { id: `${kind}-${status}`, kind, label: kind, status, target: kind, parent: "", cwd: "/repo", statusFile: "/tmp/status" }
}

test("statusline follows authoritative metadata and releases its subscription on shutdown", async (t) => {
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
    ui: { setStatus: (key: string, status: string | undefined) => { if (key === "background-tasks") statuses.push(status) }, setWidget: () => {} },
  }
  backgroundTaskStatusExtension(pi, { tasks: tasks as any })
  t.after(() => handlers.get("session_shutdown")!({}, ctx))
  await handlers.get("session_start")!({ reason: "startup" }, ctx)
  notify!([task("agent", "running"), task("monitor", "running")])
  assert.equal(statuses.at(-1), "1 agent · 1 monitor · agent · awaiting progress")
  notify!([task("agent", "succeeded")])
  assert.equal(statuses.at(-1), undefined)
  await handlers.get("session_shutdown")!({}, ctx)
  assert.equal(notify, undefined)
  assert.equal(statuses.at(-1), undefined)
})

test("pending status subscriptions cannot update UI or survive shutdown or a newer tree restore", async (t) => {
  for (const replacement of ["session_shutdown", "session_tree"]) {
    const handlers = new Map<string, (event: any, ctx: any) => any>()
    const statuses: Array<string | undefined> = []
    const widgets: unknown[] = []
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
      ui: { setStatus: (key: string, status: string | undefined) => statuses.push(`${key}:${status}`), setWidget: (_key: string, widget: unknown) => widgets.push(widget) },
    }
    backgroundTaskStatusExtension(pi, { tasks: tasks as any })
    t.after(() => handlers.get("session_shutdown")!({}, ctx))
    const old = handlers.get("session_start")!({ reason: "startup" }, ctx)
    const next = handlers.get(replacement)!({}, ctx)
    if (replacement === "session_tree") pending[1]!.release()
    await next
    const before = [...statuses]
    const widgetsBefore = [...widgets]
    pending[0]!.release()
    await old
    pending[0]!.notify([task("agent", "running"), { ...task("agent", "running"), id: "second" }])
    assert.deepEqual(statuses, before)
    assert.deepEqual(widgets, widgetsBefore)
    assert.equal(listeners.size, replacement === "session_tree" ? 1 : 0)
    await handlers.get("session_shutdown")!({}, ctx)
    assert.equal(listeners.size, 0)
  }
})

test("single agent without a report shows its label and awaits progress", () => {
  const agent = { ...task("agent", "running"), label: "Integrate\nStryker" }
  assert.equal(formatRunningTasks([agent]), "1 agent · Integrate Stryker · awaiting progress")
  assert.equal(formatRunningTasks([agent, task("monitor", "running")]), "1 agent · 1 monitor · Integrate Stryker · awaiting progress")
})

test("progress age uses whole minutes and clamps future timestamps", () => {
  const working = { ...task("agent", "running"), progress: { assignment: "one", latest: { id: "report", state: "working" as const, activity: "Reading tests", at: 1000 }, history: [] } }
  for (const [elapsed, age] of [[-1000, "<1m"], [0, "<1m"], [59999, "<1m"], [60000, "1m"], [119999, "1m"], [120000, "2m"], [3600000, "60m"]] as const) {
    assert.equal(formatRunningTasks([working], undefined, 1000 + elapsed), `1 agent · Reading tests · updated ${age} ago`)
  }
})

test("status line preserves blockers and clears finished assignments", () => {
  const working = { ...task("agent", "running"), label: "tests", progress: { assignment: "one", latest: { id: "report", state: "blocked" as const, activity: "Waiting for token", at: 1000 }, history: [] } }
  assert.equal(formatRunningTasks([working], undefined, 6000), "1 agent · blocked · Waiting for token · updated <1m ago")
  const completed = { ...working, status: "succeeded" as const, progress: { ...working.progress, latest: { ...working.progress.latest, state: "completed" as const, activity: "Tests pass" } } }
  for (const status of ["succeeded", "failed", "terminated", "interrupted", "completed"] as const) {
    assert.equal(formatRunningTasks([{ ...completed, status }]), undefined)
    assert.equal(formatRunningTasks([working, { ...completed, status }], undefined, 6000), "1 agent · blocked · Waiting for token · updated <1m ago")
  }
})

test("multiple agents publish newline progress status and clear them on transitions", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 20000 })
  const handlers = new Map<string, (event: any, ctx: any) => any>()
  let notify!: (tasks: BackgroundTask[]) => void
  let progress: string | undefined
  let status: string | undefined
  const ctx = {
    hasUI: true, cwd: "/repo",
    sessionManager: { getSessionId: () => "progress-status-runtime", getBranch: () => [] },
    ui: {
      setStatus: (key: string, value: string | undefined) => {
        if (key === "background-tasks") status = value
        else if (key === "background-tasks-progress") progress = value
        else assert.fail(`Unexpected status key: ${key}`)
      },
      setWidget: () => assert.fail("Progress must not use a widget"),
    },
  }
  backgroundTaskStatusExtension({ on: (name: string, handler: any) => handlers.set(name, handler) } as any, {
    tasks: { async watchMetadata(_query: unknown, listener: typeof notify) { notify = listener; return () => {} } } as any,
  })
  t.after(() => handlers.get("session_shutdown")!({}, ctx))
  await handlers.get("session_start")!({ reason: "startup" }, ctx)
  const working = { ...task("agent", "running"), label: "Tests\nwide", progress: { assignment: "one", latest: { id: "report", state: "blocked" as const, activity: "Waiting\nfor token", at: Date.now() - 5000 }, history: [] } }
  const second = { ...task("agent", "running"), id: "second", label: "Docs", startedAt: Date.now() - 10000 }
  notify([working, second, task("monitor", "running")])
  assert.equal(status, "2 agents · 1 monitor")
  assert.equal(progress, "Tests wide · blocked · Waiting for token · updated <1m ago\nDocs · awaiting progress · running 10s")
  notify([{ ...working, progress: { ...working.progress, latest: { ...working.progress.latest, state: "working", activity: "b".repeat(51) } } }, second])
  assert.equal(progress, `Tests wide · ${"b".repeat(49)}… · updated <1m ago\nDocs · awaiting progress · running 10s`)
  notify([working, task("monitor", "running")])
  assert.equal(progress, undefined)
  notify([working, second])
  await handlers.get("session_tree")!({}, ctx)
  assert.equal(progress, undefined)
  notify([working, second])
  await handlers.get("session_shutdown")!({}, ctx)
  assert.equal(progress, undefined)
  notify([working, second])
  assert.equal(progress, undefined)
})

test("progress status reads progress files and excludes the caller and finished agents", { timeout: 3000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 20000 })
  const directory = await mkdtemp(join(tmpdir(), "task-status-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const statusFile = join(directory, "agent")
  await reportAgentProgress(statusFile, { state: "working", activity: "Checking 界 tests", at: Date.now() })
  const handlers = new Map<string, (event: any, ctx: any) => any>()
  let notify!: (tasks: BackgroundTask[]) => void
  let refreshed!: () => void
  const ready = new Promise<void>((resolve) => { refreshed = resolve })
  let lines: string[] = []
  const ctx = {
    hasUI: true, cwd: "/repo",
    sessionManager: { getSessionId: () => "progress-runtime", getBranch: () => [] },
    ui: {
      setStatus: (key: string, value: string | undefined) => {
        if (key !== "background-tasks-progress") return
        lines = value?.split("\n") ?? []
        if (lines.some((line) => line.includes("Checking 界 tests"))) refreshed()
      },
      setWidget: () => assert.fail("Progress must not use a widget"),
    },
  }
  backgroundTaskStatusExtension({ on: (name: string, handler: any) => handlers.set(name, handler) } as any, {
    tasks: { async watchMetadata(_query: unknown, listener: typeof notify) { notify = listener; return () => {} } } as any,
  })
  t.after(() => handlers.get("session_shutdown")!({}, ctx))
  await handlers.get("session_start")!({ reason: "startup" }, ctx)
  notify([
    { ...task("agent", "running"), label: "Tests", statusFile },
    { ...task("agent", "running"), id: "second", label: "Docs", statusFile: join(directory, "second") },
    { ...task("agent", "succeeded"), label: "Finished" },
    { ...task("agent", "running"), id: familyForContext("startup", ctx).nodeId, label: "Self" },
  ])
  await ready
  assert.equal(lines.length, 2)
  assert.equal(lines[0], "Tests · Checking 界 tests · updated <1m ago")
  assert.equal(lines[1], "Docs · awaiting progress · age unknown")
})

test("single agent activities hide working and cap reports at 50 characters", () => {
  const working = { ...task("agent", "running"), progress: { assignment: "one", latest: { id: "report", state: "working" as const, activity: "Reading tests", at: 1000 }, history: [] } }
  for (const [activity, expected] of [
    ["Reading\ntests", "Reading tests"],
    ["a".repeat(49), "a".repeat(49)],
    ["a".repeat(50), "a".repeat(50)],
    ["a".repeat(51), `${"a".repeat(49)}…`],
    ["界".repeat(51), `${"界".repeat(49)}…`],
  ]) {
    assert.equal(formatRunningTasks([{ ...working, progress: { ...working.progress, latest: { ...working.progress.latest, activity } } }], undefined, 6000), `1 agent · ${expected} · updated <1m ago`)
  }
})

test("multiple agents keep activities out of the count summary", () => {
  const working = { ...task("agent", "running"), progress: { assignment: "one", latest: { id: "report", state: "working" as const, activity: "Reading tests", at: 1000 }, history: [] } }
  assert.equal(formatRunningTasks([working, { ...working, id: "second" }, task("monitor", "running")]), "2 agents · 1 monitor")
})

test("a spawned agent does not count itself, but counts its descendants", () => {
  const self = { ...task("agent", "running"), id: "self", parentId: "root" }
  const child = { ...task("monitor", "running"), id: "child", parentId: "self" }
  assert.equal(formatRunningTasks([self], "self"), undefined)
  assert.equal(formatRunningTasks([self, child], "self"), "1 monitor")
})

test("status line summarizes only running agents and monitors", () => {
  assert.equal(formatRunningTasks([
    task("agent", "running"),
    { ...task("agent", "running"), id: "agent-two" },
    task("monitor", "running"),
    task("monitor", "completed"),
  ]), "2 agents · 1 monitor")
  assert.equal(formatRunningTasks([task("agent", "completed")]), undefined)
})
