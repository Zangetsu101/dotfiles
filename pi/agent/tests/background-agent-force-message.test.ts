import assert from "node:assert/strict"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import backgroundAgent from "../extensions/background-agent.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"

async function fixture(run: (f: { parent: FakePiRuntime; child: FakePiRuntime; tmux: FakeTmuxProcessAdapter; id: string; target: string; statusFile: string }) => Promise<void>) {
  const inherited = { ...process.env }
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_")) delete process.env[key]
  const directory = await mkdtemp(join(tmpdir(), "pi-force-message-"))
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux, { metadataDirectory: directory })
  const parent = new FakePiRuntime()
  const child = new FakePiRuntime()
  try {
    await backgroundAgent(parent.pi, { tasks, tmux, pollMs: 5, settledPollMs: 10 })
    const spawned = await parent.execute("background_agent", { task: "Initial assignment", expectedCompletionMinutes: 1 })
    process.env.PI_BACKGROUND_AGENT_STATUS_FILE = spawned.details.statusFile
    process.env.PI_BACKGROUND_AGENT_DEPTH = "3"
    await backgroundAgent(child.pi, { tmux, pollMs: 5 })
    await run({ parent, child, tmux, id: spawned.details.id, target: spawned.details.target, statusFile: spawned.details.statusFile })
  } finally {
    await child.emit("session_shutdown")
    await parent.emit("session_shutdown")
    await rm(directory, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_")) delete process.env[key]
    Object.assign(process.env, inherited)
  }
}

test("force message to an idle agent needs no interruption", async () => fixture(async ({ parent, child, id }) => {
  await child.emit("session_start")
  const result = await parent.execute("background_agent_message", { id, message: "New assignment", force: true })
  assert.equal(result.details.status, "delivered")
  assert.equal(result.details.interruption, "not_needed")
  assert.equal(child.userMessages.length, 1)
  assert.equal(child.userMessages[0].text, "New assignment")
}))

test("false force preserves ordinary steering without cancellation", async () => fixture(async ({ parent, child, id }) => {
  await child.emit("session_start")
  const controller = new AbortController()
  child.context.signal = controller.signal
  child.context.abort = () => controller.abort()
  await child.emit("agent_start")
  for (const force of [undefined, false]) {
    const result = await parent.execute("background_agent_message", { id, message: "Continue", force })
    assert.equal(result.details.status, "delivered")
    assert.equal(result.details.interruption, undefined)
  }
  assert.equal(controller.signal.aborted, false)
  assert.deepEqual(child.userMessages.map((message) => message.options), [{ deliverAs: "steer" }, { deliverAs: "steer" }])
}))

test("force follow-up resets a completed assignment in a live session", async () => fixture(async ({ parent, child, id }) => {
  await child.emit("session_start")
  await child.execute("background_agent_report", { state: "completed", activity: "Done" })
  const result = await parent.execute("background_agent_message", { id, message: "Follow up", force: true })
  assert.equal(result.details.status, "delivered")
  assert.equal(result.details.interruption, "not_needed")
  assert.equal(child.userMessages[0].text, "Follow up")
  await child.execute("background_agent_report", { state: "working", activity: "Following up" })
}))

test("force message to an active agent requests interruption and delivers once", async () => fixture(async ({ parent, child, id }) => {
  await child.emit("session_start")
  const controller = new AbortController()
  child.context.signal = controller.signal
  child.context.abort = () => {
    controller.abort()
    void (async () => { await child.emit("agent_end"); await child.emit("agent_settled") })()
  }
  await child.emit("agent_start")
  const result = await parent.execute("background_agent_message", { id, message: "Stop and change direction", force: true })
  assert.equal(result.details.status, "delivered")
  assert.equal(result.details.interruption, "confirmed")
  assert.deepEqual(child.userMessages.map((message) => message.text), ["Stop and change direction"])
}))

test("an already-aborting operation settles before recovery is submitted", async () => fixture(async ({ parent, child, id }) => {
  await child.emit("session_start")
  const controller = new AbortController()
  child.context.signal = controller.signal
  child.context.abort = () => assert.fail("must not cancel again")
  await child.emit("agent_start")
  controller.abort()
  const delivery = parent.execute("background_agent_message", { id, message: "Recover", force: true })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(child.userMessages.length, 0)
  await child.emit("agent_end")
  await child.emit("agent_settled")
  const result = await delivery
  assert.equal(result.details.status, "delivered")
  assert.equal(result.details.interruption, "unconfirmed")
  assert.equal(child.userMessages[0].text, "Recover")
}))

test("a replaced Pi signal is never aborted on behalf of the old operation", async () => fixture(async ({ parent, child, id }) => {
  await child.emit("session_start")
  const original = new AbortController()
  const replacement = new AbortController()
  child.context.signal = original.signal
  child.context.abort = () => replacement.abort()
  await child.emit("agent_start")
  child.context.signal = replacement.signal
  const result = await parent.execute("background_agent_message", { id, message: "Recover", force: true })
  assert.equal(result.details.status, "delivered")
  assert.equal(result.details.interruption, "failed")
  assert.equal(replacement.signal.aborted, false)
  assert.equal(child.userMessages[0].text, "Recover")
}))

test("cancellation failure still submits the recovery message", async () => fixture(async ({ parent, child, id }) => {
  await child.emit("session_start")
  child.context.signal = new AbortController().signal
  child.context.abort = () => { throw new Error("abort failed") }
  await child.emit("agent_start")
  const result = await parent.execute("background_agent_message", { id, message: "Recover", force: true })
  assert.equal(result.details.status, "delivered")
  assert.equal(result.details.interruption, "failed")
  assert.deepEqual(child.userMessages.map((message) => message.text), ["Recover"])
}))

test("a timed out interruption retains the message until the operation settles", async () => fixture(async ({ parent, child, id }) => {
  await child.emit("session_start")
  const controller = new AbortController()
  child.context.signal = controller.signal
  child.context.abort = () => controller.abort()
  await child.emit("agent_start")
  const result = await parent.execute("background_agent_message", { id, message: "Recover later", force: true })
  assert.equal(result.details.status, "error")
  assert.equal(result.details.interruption, "requested")
  assert.equal(child.userMessages.length, 0)
  await child.emit("agent_end")
  await child.emit("agent_settled")
  for (let i = 0; i < 100 && child.userMessages.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(child.userMessages.map((message) => message.text), ["Recover later"])
}))

test("a stale target never interrupts a later operation", async () => fixture(async ({ parent, child, id, statusFile }) => {
  await writeFile(`${statusFile}.operation`, "old-operation")
  const delivery = parent.execute("background_agent_message", { id, message: "Recover", force: true })
  for (let i = 0; i < 100; i++) {
    if ((await readdir(`${statusFile}.messages`).catch(() => [])).some(name => name.endsWith(".request"))) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const controller = new AbortController()
  child.context.signal = controller.signal
  child.context.abort = () => controller.abort()
  await child.emit("agent_start")
  await child.emit("session_start")
  const result = await delivery
  assert.equal(result.details.interruption, "not_needed")
  assert.equal(controller.signal.aborted, false)
  assert.deepEqual(child.userMessages.map((message) => message.text), ["Recover"])
}))

test("a delivery failure is not reported as successful", async () => fixture(async ({ parent, child, id }) => {
  child.pi.sendUserMessage = () => { throw new Error("delivery failed") }
  await child.emit("session_start")
  const result = await parent.execute("background_agent_message", { id, message: "Change direction", force: true })
  assert.equal(result.details.status, "error")
  assert.ok(["not_needed", "failed", "unconfirmed"].includes(result.details.interruption))
  assert.equal(child.userMessages.length, 0)
}))

test("force delivery timeout is an error, not confirmation", async () => fixture(async ({ parent, id }) => {
  const result = await parent.execute("background_agent_message", { id, message: "Change direction", force: true })
  assert.equal(result.details.status, "error")
  assert.equal(result.details.interruption, "unconfirmed")
}))

test("force cannot message an exited child", async () => fixture(async ({ parent, child, tmux, id, target }) => {
  await child.emit("session_start")
  await tmux.complete(target, "failed", "exited")
  const result = await parent.execute("background_agent_message", { id, message: "Recover", force: true })
  assert.equal(result.details.status, "not_running")
  assert.equal(child.userMessages.length, 0)
}))

test("force does not authorize messaging an unknown agent", async () => fixture(async ({ parent, child }) => {
  await child.emit("session_start")
  const result = await parent.execute("background_agent_message", { id: "outside-subtree", message: "Change direction", force: true })
  assert.notEqual(result.details.status, "delivered")
  assert.equal(child.userMessages.length, 0)
}))

test("concurrent force messages are each delivered at most once", async () => fixture(async ({ parent, child, id }) => {
  await child.emit("session_start")
  const results = await Promise.all(["First", "Second"].map((message) => parent.execute("background_agent_message", { id, message, force: true })))
  assert.deepEqual(results.map((result) => result.details.status), ["delivered", "delivered"])
  assert.deepEqual(child.userMessages.map((message) => message.text).sort(), ["First", "Second"])
}))
