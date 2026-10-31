import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import backgroundAgent from "../extensions/background-agent.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"
import { installBackgroundTaskEnvironmentHooks } from "./support/background-task-environment.ts"

installBackgroundTaskEnvironmentHooks()

test("stale reports remind at deadlines without blocking work or starting idle turns", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const directory = await mkdtemp(join(tmpdir(), "pi-report-reminder-"))
  const runtime = new FakePiRuntime()
  let now = 0
  const advance = (milliseconds: number) => { now += milliseconds; t.mock.timers.tick(milliseconds) }
  const report = (activity: string, rest = {}) => runtime.execute("background_agent_report", { activity, ...rest })
  process.env.PI_BACKGROUND_AGENT_STATUS_FILE = join(directory, "status")
  try {
    await backgroundAgent(runtime.pi, { tmux: new FakeTmuxProcessAdapter(), now: () => now })
    await runtime.emit("session_start")
    await runtime.emit("agent_start")
    advance(300_000)
    assert.equal(runtime.messages.length, 0, "no stale reminder before the first report")
    await report("Checking tests")
    advance(299_999)
    assert.equal(runtime.messages.length, 0)
    advance(1)
    assert.equal(runtime.messages.length, 1)
    assert.match(runtime.messages[0].content, /background_agent_report/)
    assert.deepEqual(runtime.messageOptions[0], { deliverAs: "steer", triggerTurn: false })
    for (const handler of runtime.handlers.get("tool_call") ?? []) {
      assert.equal(await handler({ toolName: "bash" }, runtime.context), undefined)
    }
    advance(600_000)
    assert.equal(runtime.messages.length, 1)
    await assert.rejects(report(" "))
    advance(300_000)
    assert.equal(runtime.messages.length, 1, "a failed report must not restart reminders")
    await report("Still checking")
    advance(300_000)
    assert.equal(runtime.messages.length, 2, "a successful report starts a new stale period")
    await report("Checking more")
    await runtime.emit("agent_end")
    advance(300_000)
    assert.equal(runtime.messages.length, 2, "idle agents must not be woken")
    await runtime.emit("agent_start")
    advance(0)
    assert.equal(runtime.messages.length, 3)
    await report("Waiting for access", { state: "blocked", help: "Please supply access" })
    advance(300_000)
    assert.equal(runtime.messages.length, 3, "waiting for help suppresses reminders")
    await report("Blocked locally", { state: "blocked" })
    advance(300_000)
    assert.equal(runtime.messages.length, 4, "blocked work without a help request can become stale")
    await report("Done", { state: "completed" })
    advance(300_000)
    assert.equal(runtime.messages.length, 4)
    await runtime.emit("agent_start")
    advance(300_000)
    assert.equal(runtime.messages.length, 4, "follow-up must not inherit the old stale report")
    await report("Checking follow-up")
    advance(300_000)
    assert.equal(runtime.messages.length, 5)
    await runtime.emit("session_shutdown", { reason: "reload" })
    advance(300_000)
    assert.equal(runtime.messages.length, 5)
  } finally {
    await runtime.emit("session_shutdown", { reason: "reload" })
    await rm(directory, { recursive: true, force: true })
  }
})
