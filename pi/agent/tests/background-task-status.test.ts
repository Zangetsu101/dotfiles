import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import fs, { mkdtemp, rm } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import type { TestContext } from "node:test"
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
  let expectedActivity = "Checking 界 tests"
  const ctx = {
    hasUI: true, cwd: "/repo",
    sessionManager: { getSessionId: () => "progress-runtime", getBranch: () => [] },
    ui: {
      setStatus: (key: string, value: string | undefined) => {
        if (key !== "background-tasks-progress") return
        lines = value?.split("\n") ?? []
        if (lines.some((line) => line.includes(expectedActivity))) refreshed()
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
  expectedActivity = "Checking 界 tests again"
  const changed = new Promise<void>((resolve) => { refreshed = resolve })
  await reportAgentProgress(statusFile, { state: "blocked", activity: "Checking 界 tests again", at: Date.now() })
  await changed
  assert.equal(lines[0], "Tests · blocked · Checking 界 tests again · updated <1m ago")
})

test("age ticks retain cached progress and advance its age without observation events", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 60000 })
  const handlers = new Map<string, (event: any, ctx: any) => any>()
  let notify!: (tasks: BackgroundTask[]) => void
  let status: string | undefined
  const directory = await mkdtemp(join(tmpdir(), "cached-progress-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const statusFile = join(directory, "agent")
  await reportAgentProgress(statusFile, { state: "working", activity: "Cached activity", at: 1000 })
  let loaded!: () => void
  const ready = new Promise<void>((resolve) => { loaded = resolve })
  const ctx = {
    hasUI: true, cwd: "/repo",
    sessionManager: { getSessionId: () => "cached-progress", getBranch: () => [] },
    ui: { setStatus: (key: string, value: string | undefined) => {
      if (key === "background-tasks") {
        status = value
        if (value?.includes("Cached activity")) loaded()
      }
    } },
  }
  backgroundTaskStatusExtension({ on: (name: string, handler: any) => handlers.set(name, handler) } as any, {
    tasks: { async watchMetadata(_query: unknown, listener: typeof notify) { notify = listener; return () => {} } } as any,
    observation: { async watch() { return () => {} } },
  })
  t.after(() => handlers.get("session_shutdown")!({}, ctx))
  await handlers.get("session_start")!({ reason: "startup" }, ctx)
  notify([{ ...task("agent", "running"), statusFile }])
  await ready
  await reportAgentProgress(statusFile, { state: "working", activity: "Not observed yet", at: Date.now() })
  t.mock.timers.tick(5000)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(status, "1 agent · Cached activity · updated 1m ago")
})

function progressRuntime(t: TestContext) {
  const handlers = new Map<string, (event: any, ctx: any) => any>()
  let notify!: (tasks: BackgroundTask[]) => void
  const statuses: Array<string | undefined> = []
  const subscriptions = new Map<string, () => void>()
  const stopped: string[] = []
  const reads: Array<(activity: string) => void> = []
  const readFile = fs.readFile
  t.mock.method(fs, "readFile", ((path: unknown, ...args: unknown[]) => {
    if (typeof path !== "string" || !path.startsWith("/ui-progress/")) {
      return Reflect.apply(readFile, fs, [path, ...args])
    }
    return new Promise<string>((resolve) => {
      reads.push((activity) => resolve(JSON.stringify({ assignment: "one", latest: { id: "report", state: "working", activity, at: Date.now() }, history: [] })))
    })
  }) as typeof fs.readFile)
  syncBuiltinESMExports()
  const ctx = {
    hasUI: true, cwd: "/repo",
    sessionManager: { getSessionId: () => "ui-progress-races", getBranch: () => [] },
    ui: { setStatus: (key: string, value: string | undefined) => { if (key === "background-tasks") statuses.push(value) } },
  }
  backgroundTaskStatusExtension({ on: (name: string, handler: any) => handlers.set(name, handler) } as any, {
    tasks: { async watchMetadata(_query: unknown, listener: typeof notify) { notify = listener; return () => {} } } as any,
    observation: { async watch(directory, listener) {
      assert.equal(subscriptions.has(directory), false, "directory already subscribed")
      subscriptions.set(directory, listener)
      return () => { stopped.push(directory); subscriptions.delete(directory) }
    } },
  })
  const event = (name: string) => handlers.get(name)!({ reason: "startup" }, ctx)
  t.after(() => {
    event("session_shutdown")
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  return {
    event, statuses, subscriptions, stopped, reads,
    notify: (tasks: BackgroundTask[]) => notify(tasks),
    agent: (name: string) => ({ ...task("agent", "running"), id: name, statusFile: `/ui-progress/${name}/status` }),
  }
}

const flushProgress = () => new Promise<void>((resolve) => setImmediate(resolve))

test("progress subscriptions follow running agents and are released on tree restore and shutdown", async (t) => {
  const runtime = progressRuntime(t)
  await runtime.event("session_start")
  runtime.notify([runtime.agent("first"), runtime.agent("second")])
  await flushProgress()
  runtime.reads.splice(0).forEach((resolve) => resolve("Initial"))
  await flushProgress()
  assert.deepEqual([...runtime.subscriptions.keys()], ["/ui-progress/first", "/ui-progress/second"])
  runtime.notify([runtime.agent("second"), { ...runtime.agent("first"), status: "succeeded" }])
  await flushProgress()
  runtime.reads.splice(0).forEach((resolve) => resolve("Still running"))
  await flushProgress()
  assert.deepEqual([...runtime.subscriptions.keys()], ["/ui-progress/second"])
  assert.deepEqual(runtime.stopped, ["/ui-progress/first"])
  runtime.notify([runtime.agent("first"), runtime.agent("second")])
  await flushProgress()
  runtime.reads.splice(0).forEach((resolve) => resolve("Running again"))
  await flushProgress()
  assert.deepEqual([...runtime.subscriptions.keys()], ["/ui-progress/second", "/ui-progress/first"])
  await runtime.event("session_tree")
  assert.equal(runtime.subscriptions.size, 0)
  runtime.notify([runtime.agent("second")])
  await flushProgress()
  runtime.reads.splice(0).forEach((resolve) => resolve("Restored"))
  await flushProgress()
  await runtime.event("session_shutdown")
  assert.equal(runtime.subscriptions.size, 0)
  assert.deepEqual(runtime.stopped, ["/ui-progress/first", "/ui-progress/second", "/ui-progress/first", "/ui-progress/second"])
})

test("events during a progress read drain the latest report without duplicate subscriptions", async (t) => {
  const runtime = progressRuntime(t)
  await runtime.event("session_start")
  runtime.notify([runtime.agent("first")])
  await flushProgress()
  const change = runtime.subscriptions.get("/ui-progress/first")!
  change()
  change()
  runtime.reads.shift()!("Before changes")
  await flushProgress()
  assert.equal(runtime.reads.length, 1)
  runtime.reads.shift()!("Latest report")
  await flushProgress()
  assert.equal(runtime.statuses.at(-1), "1 agent · Latest report · updated <1m ago")
  assert.equal(runtime.statuses.filter((status) => status?.includes("Latest report")).length, 1)
  assert.equal(runtime.subscriptions.size, 1)
  assert.equal(runtime.reads.length, 0)
  assert.deepEqual(runtime.stopped, [])
})

test("a late progress read cannot restore a removed agent before the dirty drain finishes", async (t) => {
  const runtime = progressRuntime(t)
  await runtime.event("session_start")
  runtime.notify([runtime.agent("first")])
  await flushProgress()
  runtime.notify([runtime.agent("second")])
  const before = runtime.statuses.length
  runtime.reads.shift()!("Obsolete report")
  await flushProgress()
  assert.deepEqual(runtime.statuses.slice(before), [])
  assert.deepEqual([...runtime.subscriptions.keys()], ["/ui-progress/second"])
  runtime.reads.shift()!("Current report")
  await flushProgress()
  assert.equal(runtime.statuses.at(-1), "1 agent · Current report · updated <1m ago")
})

test("late progress reads cannot publish after tree restore or shutdown", async (t) => {
  for (const replacement of ["session_tree", "session_shutdown"]) {
    await t.test(replacement, async (t) => {
      const runtime = progressRuntime(t)
      await runtime.event("session_start")
      runtime.notify([runtime.agent("first")])
      await flushProgress()
      const lateEvent = runtime.subscriptions.get("/ui-progress/first")!
      await runtime.event(replacement)
      const before = [...runtime.statuses]
      lateEvent()
      runtime.reads.shift()!("Obsolete report")
      await flushProgress()
      assert.deepEqual(runtime.statuses, before)
      assert.equal(runtime.subscriptions.size, 0)
      assert.equal(runtime.reads.length, 0)
    })
  }
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
