import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import backgroundAgent from "../extensions/background-agent.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"
import { installBackgroundTaskEnvironmentHooks } from "./support/background-task-environment.ts"

installBackgroundTaskEnvironmentHooks()

test("stale reports remind once per period without blocking work or starting idle turns", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const directory = await mkdtemp(join(tmpdir(), "pi-report-reminder-"))
  const runtime = new FakePiRuntime()
  let now = 0
  process.env.PI_BACKGROUND_AGENT_STATUS_FILE = join(directory, "status")
  try {
    await backgroundAgent(runtime.pi, { tmux: new FakeTmuxProcessAdapter(), now: () => now, pollMs: 100 })
    await runtime.emit("session_start")
    await runtime.emit("agent_start")
    now = 300_000
    t.mock.timers.tick(100)
    assert.equal(runtime.messages.length, 0, "no stale reminder before the first report")
    await runtime.execute("background_agent_report", { activity: "Checking tests" })
    now = 599_999
    t.mock.timers.tick(100)
    assert.equal(runtime.messages.length, 0)
    now = 600_000
    t.mock.timers.tick(100)
    assert.equal(runtime.messages.length, 1)
    assert.match(runtime.messages[0].content, /background_agent_report/)
    assert.deepEqual(runtime.messageOptions[0], { deliverAs: "steer", triggerTurn: false })
    for (const handler of runtime.handlers.get("tool_call") ?? []) {
      assert.equal(await handler({ toolName: "bash" }, runtime.context), undefined)
    }
    now = 1_200_000
    t.mock.timers.tick(100)
    assert.equal(runtime.messages.length, 1)
    await assert.rejects(runtime.execute("background_agent_report", { activity: " " }))
    t.mock.timers.tick(100)
    assert.equal(runtime.messages.length, 1, "a failed report must not restart reminders")
    await runtime.execute("background_agent_report", { activity: "Still checking" })
    now += 300_000
    t.mock.timers.tick(100)
    assert.equal(runtime.messages.length, 2, "a successful report starts a new stale period")
    await runtime.execute("background_agent_report", { activity: "Checking more" })
    await runtime.emit("agent_end")
    now += 300_000
    t.mock.timers.tick(100)
    assert.equal(runtime.messages.length, 2, "idle agents must not be woken")
    await runtime.emit("agent_start")
    t.mock.timers.tick(100)
    assert.equal(runtime.messages.length, 3)
    await runtime.execute("background_agent_report", { activity: "Waiting for access", state: "blocked", help: "Please supply access" })
    now += 300_000
    t.mock.timers.tick(100)
    assert.equal(runtime.messages.length, 3, "waiting for help suppresses reminders")
    await runtime.execute("background_agent_report", { activity: "Blocked locally", state: "blocked" })
    now += 300_000
    t.mock.timers.tick(100)
    assert.equal(runtime.messages.length, 4, "blocked work without a help request can become stale")
    await runtime.execute("background_agent_report", { activity: "Done", state: "completed" })
    now += 300_000
    t.mock.timers.tick(100)
    assert.equal(runtime.messages.length, 4)
    await runtime.emit("agent_start")
    now += 300_000
    t.mock.timers.tick(100)
    assert.equal(runtime.messages.length, 4, "follow-up must not inherit the old stale report")
    await runtime.execute("background_agent_report", { activity: "Checking follow-up" })
    now += 300_000
    t.mock.timers.tick(100)
    assert.equal(runtime.messages.length, 5)
    await runtime.emit("session_shutdown", { reason: "reload" })
    now += 300_000
    t.mock.timers.tick(100)
    assert.equal(runtime.messages.length, 5)
  } finally {
    await runtime.emit("session_shutdown", { reason: "reload" })
    await rm(directory, { recursive: true, force: true })
  }
})
