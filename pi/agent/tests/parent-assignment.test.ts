import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { BackgroundAssignment, ParentAssignment } from "../extensions/lib/background-assignment.ts"
import { BACKGROUND_ACTIVITY_FINISHED, BACKGROUND_ACTIVITY_STARTED } from "../extensions/lib/background-activity.ts"
import { BACKGROUND_TASK_STATUS_CHANGED, BackgroundTasks, writeTaskCompletion, type BackgroundTask, type TaskCompletionRecord, type TaskStatus } from "../extensions/lib/background-task.ts"
import type { AgentProgress } from "../extensions/lib/background-progress.ts"
import { createTaskCheckInScheduler } from "../extensions/lib/task-check-in.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"
import { installBackgroundTaskEnvironmentHooks } from "./support/background-task-environment.ts"

installBackgroundTaskEnvironmentHooks()

async function fixture(run: (f: {
  parent: ParentAssignment
  child: BackgroundAssignment
  completions: Array<{ completion: TaskCompletionRecord; status: TaskStatus }>
  activities: string[]
  statuses: TaskStatus[]
  tmux: FakeTmuxProcessAdapter
  tasks: BackgroundTasks
  task: BackgroundTask
  lifetime: { active: boolean; current: boolean }
  reopen: () => ParentAssignment
  progress: Array<AgentProgress | undefined>
  checkIns: ReturnType<typeof createTaskCheckInScheduler>
  runtime: FakePiRuntime
  tick: (time: number) => Promise<number>
  clock: { onArm?: () => void }
  activityDetails: unknown[]
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-parent-assignment-"))
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux, { metadataDirectory: directory })
  const task = await tasks.create({ kind: "agent", label: "Research", cwd: directory, command: "pi", args: [], familyId: "family", familyName: "Research", rootId: "root", rootPane: "%root", parentId: "root", parentTarget: "%root" })
  const runtime = new FakePiRuntime()
  let now = 0
  let nextTimer = 0
  const timers = new Map<number, { at: number; callback: () => Promise<void> }>()
  const clock: { onArm?: () => void } = {}
  const checkIns = createTaskCheckInScheduler({
    now: () => now,
    setTimer: (callback, delay) => {
      const id = ++nextTimer
      timers.set(id, { at: now + delay, callback })
      clock.onArm?.()
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (timer) => { timers.delete(timer as unknown as number) },
  })
  const tick = async (time: number) => {
    now = time
    let fired = 0
    for (const [id, timer] of [...timers]) {
      if (timer.at > time) continue
      timers.delete(id)
      fired++
      await timer.callback()
    }
    return fired
  }
  const completions: Array<{ completion: TaskCompletionRecord; status: TaskStatus }> = []
  const activities: string[] = []
  const statuses: TaskStatus[] = []
  const activityDetails: unknown[] = []
  runtime.events.on(BACKGROUND_ACTIVITY_STARTED, (activity) => { activities.push("running"); activityDetails.push(activity) })
  runtime.events.on(BACKGROUND_ACTIVITY_FINISHED, (activity) => { activities.push("settled"); activityDetails.push(activity) })
  const lifetime = { active: true, current: true }
  const progress: Array<AgentProgress | undefined> = []
  const reopen = () => new ParentAssignment(task, {
    tasks, tmux, pi: runtime.pi, checkIns,
    active: () => lifetime.active && lifetime.current,
    current: () => lifetime.current,
    onProgress: async (report) => { progress.push(report) },
    onCompletion: (completion, status) => { completions.push({ completion, status }) },
    onStatus: (status) => { statuses.push(status); runtime.events.emit(BACKGROUND_TASK_STATUS_CHANGED, task) },
  })
  const parent = reopen()
  const child = new BackgroundAssignment(task.statusFile, { setRunning: async () => {} })
  try {
    await run({ parent, child, completions, activities, statuses, tmux, tasks, task, lifetime, reopen, progress, checkIns, runtime, tick, clock, activityDetails })
  } finally {
    checkIns.stop(task.statusFile)
    await rm(dirname(task.statusFile), { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
}

test("a follow-up outcome cannot overtake an earlier outcome whose status effect is pending", async () => {
  await fixture(async ({ parent, child, completions, tmux }) => {
    let entered!: () => void
    const updating = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const ready = new Promise<void>((resolve) => { release = resolve })
    const run = tmux.run.bind(tmux)
    let paused = false
    tmux.run = async (args) => {
      if (!paused && args.includes("@pi_agent_status")) {
        paused = true
        entered()
        await ready
      }
      return run(args)
    }
    await child.report({ activity: "First result", state: "completed" })
    const first = parent.reconcile()
    try {
      await updating
      await child.resume()
      await child.report({ activity: "Second result", state: "completed" })
      await parent.reconcile()
      await parent.reconcile()
      assert.equal(completions.length, 0)
    } finally {
      release()
      await first
    }
    assert.deepEqual(completions.map(({ completion }) => "output" in completion ? completion.output : undefined), ["First result", "Second result"])
  })
})

test("a settled agent reactivates for follow-up and can settle another assignment", async () => {
  await fixture(async ({ parent, child, completions, activities }) => {
    await child.report({ activity: "First result", state: "completed" })
    await parent.reconcile()
    await child.resume()
    await child.report({ activity: "Follow-up work" })
    await parent.reconcile()
    assert.equal(parent.running, true)
    assert.deepEqual(activities, ["running", "settled", "running"])
    await child.report({ activity: "Follow-up blocked", state: "failed" })
    await parent.reconcile()
    assert.equal(parent.running, false)
    assert.deepEqual(completions.map(({ status }) => status), ["succeeded", "failed"])
    assert.deepEqual(activities, ["running", "settled", "running", "settled"])
  })
})

for (const followupState of ["working", "completed"] as const) {
  test(`an older outcome does not settle a ${followupState} follow-up assignment`, async () => {
    await fixture(async ({ parent, child, completions, activities, statuses, tmux, task }) => {
      await child.report({ activity: "Old result", state: "completed" })
      await child.resume()
      await child.report({ activity: "New assignment", state: followupState })
      await parent.reconcile()
      assert.equal(parent.running, true)
      assert.deepEqual(activities, ["running"])
      assert.deepEqual(statuses, [])
      assert.equal(tmux.tasks().find((candidate) => candidate.target === task.target)?.status, "running")
      assert.equal(completions.length, 1)
      if (followupState === "working") await child.report({ activity: "New result", state: "completed" })
      await parent.reconcile()
      assert.equal(parent.running, false)
      assert.equal(completions.length, 2)
    })
  })
}

for (const disappearance of ["exit", "missing"] as const) {
  test(`assignment outcomes precede a separate runtime ${disappearance} notification`, async () => {
    await fixture(async ({ parent, child, completions, activities, tmux, task, reopen }) => {
      await child.report({ activity: "First result", state: "completed" })
      await parent.reconcile()
      const restored = reopen()
      await restored.reconcile()
      assert.equal(completions.length, 1)
      assert.deepEqual(activities, ["running", "settled"])
      await child.resume()
      await child.report({ activity: "Second result", state: "failed" })
      if (disappearance === "exit") await writeTaskCompletion(task.statusFile, { kind: "exit", exitCode: 2 })
      else await tmux.run(["kill-window", "-t", task.target])
      await restored.reconcile()
      assert.equal(completions.length, 2)
      assert.equal(completions[1].status, "failed")
      assert.ok("kind" in completions[1].completion && completions[1].completion.kind === "reported")
      await restored.reconcile()
      assert.equal(completions.length, 3)
      const exit = completions[2].completion
      assert.ok("kind" in exit && exit.kind === "exit")
      assert.equal(completions[2].status, "failed")
      if (disappearance === "missing") assert.equal(exit.reason, "agent session disappeared after reporting assignment completion")
      else assert.equal(exit.exitCode, 2)
      await restored.reconcile()
      assert.equal(completions.length, 3)
    })
  })
}

test("cleanup suppresses completion delivery and post-settlement disappearance", async () => {
  await fixture(async ({ parent, child, completions, activities, tmux, task, tasks }) => {
    await child.report({ activity: "Result", state: "completed" })
    await writeFile(`${task.statusFile}.cleanup`, "")
    await parent.reconcile()
    assert.deepEqual(completions, [])
    assert.deepEqual(activities, ["running"])
    assert.equal(parent.running, true)
    await rm(`${task.statusFile}.cleanup`)
    await child.resume()
    await child.report({ activity: "Next result", state: "completed" })
    await parent.reconcile()
    assert.equal(completions.length, 1)
    await writeFile(`${task.statusFile}.cleanup`, "")
    await tmux.run(["kill-window", "-t", task.target])
    await parent.reconcile()
    const completion = await tasks.completion(task)
    assert.ok(completion && "kind" in completion && completion.kind === "reported")
    assert.equal(completions.length, 1)
  })
})

test("completion takes precedence over progress and legacy cancellation remains termination", async () => {
  await fixture(async ({ parent, child, completions, progress, task }) => {
    const report = await child.report({ activity: "Need access", state: "blocked", help: "Supply a token", attention: true })
    await parent.reconcile()
    assert.deepEqual(progress, [report])
    await writeTaskCompletion(task.statusFile, { status: "cancelled", reason: "Stopped by user" })
    await parent.reconcile()
    assert.equal(completions[0].status, "terminated")
    assert.equal(parent.running, false)
    assert.deepEqual(progress, [report])
  })
})

test("reconciliation can retry after a durable-record read failure", async () => {
  await fixture(async ({ parent, child, completions, task }) => {
    const invalid = join(`${task.statusFile}.assignments`, "invalid.json")
    await mkdir(`${task.statusFile}.assignments`)
    await writeFile(invalid, "{")
    await assert.rejects(parent.reconcile(), SyntaxError)
    await rm(invalid)
    await child.report({ activity: "Recovered", state: "completed" })
    await parent.reconcile()
    assert.equal(completions.length, 1)
    assert.equal(completions[0].status, "succeeded")
  })
})

test("reactivation immediately consumes an outcome published during its running-status update", async () => {
  await fixture(async ({ parent, child, completions, tmux }) => {
    await child.report({ activity: "First result", state: "completed" })
    await parent.reconcile()
    await child.resume()
    const run = tmux.run.bind(tmux)
    tmux.run = async (args) => {
      if (args.includes("@pi_task_status") && args.at(-1) === "running") {
        await child.report({ activity: "Fast follow-up", state: "completed" })
      }
      return run(args)
    }
    await parent.reconcile()
    assert.equal(parent.running, false)
    assert.deepEqual(completions.map(({ status }) => status), ["succeeded", "succeeded"])
  })
})

for (const end of ["replacement", "shutdown"] as const) {
  test(`a ${end} during status effects retains the existing watcher-identity delivery rule`, async () => {
    await fixture(async ({ parent, child, completions, statuses, tmux, lifetime, tasks, task }) => {
      await child.report({ activity: "Result", state: "completed" })
      const run = tmux.run.bind(tmux)
      tmux.run = async (args) => {
        if (args.includes("@pi_agent_status")) {
          if (end === "replacement") lifetime.current = false
          else lifetime.active = false
        }
        return run(args)
      }
      await parent.reconcile()
      assert.equal(completions.length, end === "replacement" ? 0 : 1)
      assert.deepEqual(statuses, end === "replacement" ? [] : ["succeeded"])
      assert.equal(await tasks.claimCompletionRecord(task), undefined, "a consumed claim is not rolled back")
    })
  })
}

test("an inactive reconciliation leaves outcomes unclaimed for the active lifetime", async () => {
  await fixture(async ({ parent, child, completions, lifetime }) => {
    await child.report({ activity: "Result", state: "completed" })
    lifetime.active = false
    await parent.reconcile()
    assert.equal(completions.length, 0)
    lifetime.active = true
    await parent.reconcile()
    assert.equal(completions.length, 1)
  })
})

test("reactivation stops before activity and consumption when its lifetime ends during status update", async () => {
  await fixture(async ({ parent, child, completions, activities, tmux, lifetime, task, checkIns, tick }) => {
    await child.report({ activity: "First result", state: "completed" })
    await parent.reconcile()
    await child.resume()
    await checkIns.schedule(task.statusFile, 100)
    const run = tmux.run.bind(tmux)
    tmux.run = async (args) => {
      if (args.includes("@pi_task_status") && args.at(-1) === "running") lifetime.active = false
      return run(args)
    }
    await parent.reconcile()
    assert.equal(completions.length, 1)
    assert.deepEqual(activities, ["running", "settled"])
    assert.equal(await tick(100), 0, "an ended lifetime must not rearm check-ins")
  })
})

test("the parent observes an explicit runtime exit after settlement only once", async () => {
  await fixture(async ({ parent, child, completions, task }) => {
    await child.report({ activity: "Result", state: "completed" })
    await parent.reconcile()
    await writeTaskCompletion(task.statusFile, { kind: "exit", exitCode: 3 })
    await parent.reconcile()
    assert.equal(parent.running, false)
    assert.equal(completions.length, 2)
    assert.equal(completions[1].status, "failed")
    await parent.reconcile()
    assert.equal(completions.length, 2)
  })
})

test("an old outcome keeps follow-up check-ins active and settling cancels their wakeups", async () => {
  await fixture(async ({ parent, child, checkIns, task, runtime, tick }) => {
    await child.report({ activity: "Old result", state: "completed" })
    await child.resume()
    await child.report({ activity: "Follow-up work" })
    await checkIns.schedule(task.statusFile, 100)
    await parent.reconcile()
    await tick(100)
    assert.equal(runtime.messages.length, 1)
    assert.equal(runtime.messages[0].customType, "background-agent-check-in")
    assert.deepEqual(runtime.messageOptions[0], { deliverAs: "followUp", triggerTurn: true })
    await checkIns.schedule(task.statusFile, 200)
    await child.report({ activity: "New result", state: "completed" })
    await parent.reconcile()
    assert.equal(await tick(200), 0)
    await child.resume()
    await child.report({ activity: "Another follow-up" })
    await checkIns.schedule(task.statusFile, 300)
    await parent.reconcile()
    await tick(300)
    assert.equal(runtime.messages.length, 2, "reactivation restores check-in delivery")
  })
})

test("a restored agent reports its existing runtime exit without overwriting the exit details", async () => {
  await fixture(async ({ task, tmux, reopen, completions }) => {
    task.status = "failed"
    await writeTaskCompletion(task.statusFile, { kind: "exit", exitCode: 7, reason: "Original runtime failure" })
    await tmux.run(["kill-window", "-t", task.target])
    const restored = reopen()
    await restored.reconcile()
    assert.deepEqual(completions, [{ completion: { kind: "exit", exitCode: 7, reason: "Original runtime failure" }, status: "failed" }])
  })
})

test("inactive lifetimes cannot send check-ins even while the assignment is running", async () => {
  await fixture(async ({ child, lifetime, task, checkIns, tick, runtime }) => {
    await child.report({ activity: "Working" })
    await checkIns.schedule(task.statusFile, 100)
    lifetime.active = false
    await tick(100)
    assert.equal(runtime.messages.length, 0)
  })
})

test("a lifetime ending during check-in attachment cannot publish reactivation", async () => {
  await fixture(async ({ parent, child, task, checkIns, clock, lifetime, activities, progress }) => {
    await child.report({ activity: "First result", state: "completed" })
    await parent.reconcile()
    await child.resume()
    await checkIns.schedule(task.statusFile, 100)
    clock.onArm = () => { lifetime.active = false }
    await parent.reconcile()
    assert.deepEqual(activities, ["running", "settled"])
    assert.equal(progress.length, 0)
  })
})

test("replacement during a runtime-presence check cannot publish old progress", async () => {
  await fixture(async ({ parent, child, lifetime, tmux, progress }) => {
    await child.report({ activity: "Working" })
    const run = tmux.run.bind(tmux)
    tmux.run = async (args) => {
      if (args[0] === "list-windows" && args.includes("#{@pi_task_id}")) lifetime.current = false
      return run(args)
    }
    await parent.reconcile()
    assert.equal(progress.length, 0)
  })
})

test("replacement triggered by a status event suppresses completion delivery", async () => {
  await fixture(async ({ parent, child, runtime, lifetime, statuses, completions }) => {
    await child.report({ activity: "Result", state: "completed" })
    runtime.events.once(BACKGROUND_TASK_STATUS_CHANGED, () => { lifetime.current = false })
    await parent.reconcile()
    assert.deepEqual(statuses, ["succeeded"])
    assert.equal(completions.length, 0)
  })
})

test("a malformed progress report is diagnosed without preventing later completion", async (t) => {
  const errors = t.mock.method(console, "error", () => {})
  await fixture(async ({ parent, child, task, completions }) => {
    await writeFile(`${task.statusFile}.progress`, "{")
    await parent.reconcile()
    assert.equal(errors.mock.calls.length, 1)
    assert.equal(errors.mock.calls[0].arguments[0], "background agent progress:")
    assert.ok(errors.mock.calls[0].arguments[1] instanceof SyntaxError)
    await rm(`${task.statusFile}.progress`)
    await child.report({ activity: "Recovered", state: "completed" })
    await parent.reconcile()
    assert.equal(completions.length, 1)
  })
})

for (const outcome of ["completed", "failed", "cancelled"] as const) {
  test(`the parent publishes ${outcome} status to the agent window and preserves activity identity`, async () => {
    await fixture(async ({ parent, child, task, tmux, activityDetails }) => {
      if (outcome === "cancelled") await writeTaskCompletion(task.statusFile, { status: "cancelled", reason: "Stopped" })
      else await child.report({ activity: "Result", state: outcome })
      await parent.reconcile()
      const windows = await tmux.run(["list-windows", "-a", "-F", "#{window_id}\t#{@pi_agent_status}\t#{@pi_task_status}"])
      const line = windows.split("\n").find((line) => line.startsWith(`${task.target}\t`))
      const expected = outcome === "completed" ? "settled\tsucceeded" : outcome === "failed" ? "failed\tfailed" : "terminated\tterminated"
      assert.equal(line, `${task.target}\t${expected}`)
      assert.deepEqual(activityDetails, [
        { id: `background-agent:${task.id}`, source: "background_agent", label: "Research" },
        { id: `background-agent:${task.id}`, source: "background_agent", label: "Research" },
      ])
    })
  })
}

test("a failed tmux status update does not prevent delivering a claimed outcome", async () => {
  await fixture(async ({ parent, child, tmux, completions, statuses }) => {
    await child.report({ activity: "Result", state: "completed" })
    tmux.failSetupFor = "@pi_agent_status"
    await parent.reconcile()
    assert.equal(completions.length, 1)
    assert.equal(completions[0].status, "succeeded")
    assert.deepEqual(statuses, ["succeeded"])
  })
})

test("the parent claims a completed assignment once and settles only the current cycle", async () => {
  await fixture(async ({ parent, child, completions, activities, statuses }) => {
    assert.equal(parent.running, true)
    const progress = await child.report({ activity: "Research complete", state: "completed" })
    await parent.reconcile()
    assert.equal(parent.running, false)
    assert.deepEqual(completions, [{ completion: { kind: "reported", outcome: "completed", assignment: progress.assignment, output: "Research complete" }, status: "succeeded" }])
    assert.deepEqual(activities, ["running", "settled"])
    assert.deepEqual(statuses, ["succeeded"])
    await parent.reconcile()
    assert.equal(completions.length, 1)
    assert.deepEqual(activities, ["running", "settled"])
  })
})
