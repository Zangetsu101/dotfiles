import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { BackgroundAssignment } from "../extensions/lib/background-assignment.ts"
import { BackgroundTasks, writeTaskCompletion } from "../extensions/lib/background-task.ts"
import { readAgentProgress } from "../extensions/lib/background-progress.ts"

async function fixture(run: (assignment: BackgroundAssignment, statusFile: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-assignment-"))
  try {
    const statusFile = join(directory, "status")
    await run(new BackgroundAssignment(statusFile, { now: () => 1000, setRunning: async () => {} }), statusFile)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("reports keep assignment identity and unlock work only after a successful report", async () => {
  await fixture(async (assignment) => {
    assert.equal(assignment.needsInitialReport, true)
    assert.equal(assignment.completed, false)
    await assert.rejects(assignment.report({ activity: "  " }), /Activity must not be empty/)
    assert.equal(assignment.needsInitialReport, true)
    const first = await assignment.report({ activity: "  Reading tests  " })
    const second = await assignment.report({ activity: "Waiting for access", state: "blocked", help: "Supply a token", attention: true })
    assert.equal(assignment.needsInitialReport, false)
    assert.equal(second.assignment, first.assignment)
    assert.notEqual(second.latest.id, first.latest.id)
    assert.equal(first.latest.activity, "Reading tests")
    assert.equal(first.latest.state, "working")
    assert.equal(second.latest.at, 1000)
    assert.equal(second.latest.help, "Supply a token")
    assert.equal(second.latest.attention, true)
    assert.deepEqual(second.history.map((report) => report.activity), ["Reading tests", "Waiting for access"])
    assert.deepEqual(assignment.latestReport, second.latest)
  })
})

test("follow-up resumes with a fresh report gate without losing the previous outcome", async () => {
  await fixture(async (assignment, statusFile) => {
    assert.equal(await assignment.resume(), false)
    const first = await assignment.report({ activity: "First result", state: "completed" })
    assert.equal(await assignment.resume(), true)
    assert.equal(assignment.completed, false)
    assert.equal(assignment.needsInitialReport, true)
    assert.equal(assignment.latestReport, undefined)
    const tasks = new BackgroundTasks()
    assert.equal(await tasks.completion({ statusFile }), undefined)
    const second = await assignment.report({ activity: "Follow-up work" })
    assert.notEqual(second.assignment, first.assignment)
    assert.deepEqual(second.history.map((report) => report.activity), ["Follow-up work"])
    assert.deepEqual(await tasks.claimCompletionRecord({ statusFile }), {
      kind: "reported", outcome: "completed", assignment: first.assignment, output: "First result",
    })
    assert.equal(await tasks.claimCompletionRecord({ statusFile }), undefined)
  })
})

test("settlement publishes the final output once with the reported assignment identity", async () => {
  await fixture(async (assignment, statusFile) => {
    const progress = await assignment.report({ activity: "Investigating" })
    await assignment.settle(() => ({ output: "Model failed", stopReason: "error" }), async () => {})
    assert.equal(assignment.completed, true)
    await assignment.settle(() => { throw new Error("Must not replace settled output") }, async () => { throw new Error("Must not drain after settlement") })
    assert.deepEqual(await new BackgroundTasks().completion({ statusFile }), {
      kind: "settled", assignment: progress.assignment, output: "Model failed", stopReason: "error",
    })
  })
})

test("settlement drains follow-up delivery and defers to remaining requests", async () => {
  await fixture(async (assignment, statusFile) => {
    const mailbox = `${statusFile}.messages`
    await assignment.settle(() => { throw new Error("Pending work must prevent settlement") }, async () => {
      await mkdir(mailbox)
      await writeFile(join(mailbox, "follow-up.request"), "More work")
    })
    assert.equal(assignment.completed, false)
    assert.equal(await new BackgroundTasks().completion({ statusFile }), undefined)
    await rm(join(mailbox, "follow-up.request"))
    await writeFile(join(mailbox, "incomplete.request.tmp"), "Not published")
    await assignment.settle(() => ({ output: "Finished without a report" }), async () => {})
    const completion = await new BackgroundTasks().completion({ statusFile })
    assert.ok(completion && "kind" in completion)
    assert.equal(completion.kind, "settled")
    assert.equal(completion.output, "Finished without a report")
    assert.ok(completion.assignment)
    assert.equal(assignment.completed, true)
  })
})

test("reopening a completed assignment retains the fresh-report gate until follow-up", async () => {
  await fixture(async (_assignment, statusFile) => {
    await writeFile(statusFile, "Not parsed during initialization")
    const assignment = new BackgroundAssignment(statusFile, { setRunning: async () => {} })
    assert.equal(assignment.completed, true)
    assert.equal(assignment.needsInitialReport, true)
    assert.equal(assignment.latestReport, undefined)
    await assert.rejects(assignment.report({ activity: "Not follow-up yet" }), /Assignment already completed/)
    assert.equal(await assignment.resume(), true)
    const progress = await assignment.report({ activity: "Follow-up" })
    assert.equal(progress.latest.state, "working")
    assert.ok(progress.latest.at > 0)
  })
})

test("a terminal publication failure can leave a durable outcome without completing the report call", async () => {
  await fixture(async (assignment, statusFile) => {
    await writeFile(`${statusFile}.assignments`, "Prevent history publication")
    await assert.rejects(assignment.report({ activity: "First result", state: "completed" }), { code: "EEXIST" })
    const tasks = new BackgroundTasks()
    const published = await tasks.completion({ statusFile })
    assert.ok(published && "kind" in published)
    assert.equal(published.output, "First result")
    assert.equal(assignment.completed, false)
    assert.equal(assignment.needsInitialReport, true)
    assert.equal(assignment.latestReport, undefined)
    assert.equal((await readAgentProgress(statusFile))?.latest.state, "completed")
    await rm(`${statusFile}.assignments`)
    const retry = await assignment.report({ activity: "Retried result", state: "completed" })
    assert.equal(retry.assignment, published.assignment)
    assert.equal(assignment.completed, true)
    assert.deepEqual(assignment.latestReport, retry.latest)
  })
})

test("a failed automatic settlement remains completed in memory and is not retried", async () => {
  await fixture(async (assignment, statusFile) => {
    await writeFile(`${statusFile}.assignments`, "Prevent history publication")
    await assert.rejects(assignment.settle(() => ({ output: "Settled result" }), async () => {}), { code: "EEXIST" })
    assert.equal(assignment.completed, true)
    await assignment.settle(() => { throw new Error("Must not retry settlement") }, async () => {})
    await assert.rejects(assignment.report({ activity: "Too late" }), /Assignment already completed/)
    const completion = await new BackgroundTasks().completion({ statusFile })
    assert.ok(completion && "kind" in completion)
    assert.equal(completion.output, "Settled result")
  })
})

test("a failed reset preserves in-memory report state despite partial filesystem effects", async () => {
  await fixture(async (assignment, statusFile) => {
    const progress = await assignment.report({ activity: "Final result", state: "completed" })
    await mkdir(`${statusFile}.check-in`)
    await assert.rejects(assignment.resume())
    assert.equal(assignment.completed, true)
    assert.equal(assignment.needsInitialReport, false)
    assert.deepEqual(assignment.latestReport, progress.latest)
    await rm(`${statusFile}.check-in`, { recursive: true })
    assert.equal(await assignment.resume(), true)
    assert.equal(assignment.completed, false)
    assert.equal(assignment.needsInitialReport, true)
    assert.equal(assignment.latestReport, undefined)
  })
})

test("reports wait for follow-up reset before joining the new assignment", async () => {
  await fixture(async (_assignment, statusFile) => {
    let entered!: () => void
    const resetting = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const running = new Promise<void>((resolve) => { release = resolve })
    const assignment = new BackgroundAssignment(statusFile, { setRunning: async () => { entered(); await running } })
    await assignment.report({ activity: "First result", state: "completed" })
    const resuming = assignment.resume()
    await resetting
    const reporting = assignment.report({ activity: "Follow-up work" })
    const outcome = reporting.then((progress) => ({ progress }), (error: unknown) => ({ error }))
    try {
      await new Promise((resolve) => setTimeout(resolve, 30))
    } finally {
      release()
    }
    assert.equal(await resuming, true)
    const result = await outcome
    assert.ok("progress" in result, "report must wait rather than reject against the old assignment")
    assert.equal(result.progress.latest.activity, "Follow-up work")
    assert.equal(assignment.needsInitialReport, false)
  })
})

test("reporting rejects unavailable assignment storage without retrying or unlocking work", { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  await fixture(async (_assignment, statusFile) => {
    const assignment = new BackgroundAssignment(join(statusFile, "missing-status"), { setRunning: async () => {} })
    await assert.rejects(assignment.report({ activity: "Cannot persist" }), { code: "ENOENT" })
    assert.equal(assignment.needsInitialReport, true)
    assert.equal(assignment.completed, false)
    assert.equal(assignment.latestReport, undefined)
  })
})

test("reporting eventually rejects a permanently occupied mailbox", { timeout: 5000 }, async () => {
  await fixture(async (assignment, statusFile) => {
    await mkdir(`${statusFile}.message-lock`)
    await assert.rejects(assignment.report({ activity: "Cannot acquire assignment" }), { code: "EEXIST" })
    assert.equal(assignment.needsInitialReport, true)
    assert.equal(assignment.completed, false)
  })
})

test("unreadable mailbox state prevents settlement rather than losing pending work", async () => {
  await fixture(async (assignment, statusFile) => {
    await writeFile(`${statusFile}.messages`, "Not a directory")
    await assert.rejects(assignment.settle(() => ({ output: "Must not publish" }), async () => {}), { code: "ENOTDIR" })
    assert.equal(assignment.completed, false)
    assert.equal(await new BackgroundTasks().completion({ statusFile }), undefined)
  })
})

test("follow-up resets fallback notification claims as well as assignment state", async () => {
  await fixture(async (assignment, statusFile) => {
    await assignment.report({ activity: "First result", state: "completed" })
    const tasks = new BackgroundTasks()
    await tasks.claimCompletionRecord({ statusFile })
    await writeTaskCompletion(statusFile, { status: "cancelled", reason: "First interruption" })
    assert.deepEqual(await tasks.claimCompletionRecord({ statusFile }), { status: "cancelled", reason: "First interruption" })
    await assignment.resume()
    await writeTaskCompletion(statusFile, { status: "cancelled", reason: "Second interruption" })
    assert.deepEqual(await tasks.claimCompletionRecord({ statusFile }), { status: "cancelled", reason: "Second interruption" })
  })
})

for (const outcome of ["completed", "failed"] as const) {
  test(`a ${outcome} report publishes its outcome and rejects later reports`, async () => {
    await fixture(async (assignment, statusFile) => {
      const progress = await assignment.report({ activity: "Final result", state: outcome })
      assert.equal(assignment.completed, true)
      assert.equal(assignment.needsInitialReport, false)
      assert.deepEqual(await new BackgroundTasks().completion({ statusFile }), {
        kind: "reported", outcome, assignment: progress.assignment, output: "Final result",
      })
      await assert.rejects(assignment.report({ activity: "Too late" }), /Assignment already completed/)
      assert.deepEqual(assignment.latestReport, progress.latest)
      await assignment.settle(() => { throw new Error("Must not replace an explicit report") }, async () => {})
      const completion = await new BackgroundTasks().completion({ statusFile })
      assert.ok(completion && "kind" in completion)
      assert.equal(completion.kind, "reported")
    })
  })
}
