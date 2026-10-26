import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import backgroundAgent from "../extensions/background-agent.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"
import { installBackgroundTaskEnvironmentHooks } from "./support/background-task-environment.ts"

installBackgroundTaskEnvironmentHooks()

async function toolCall(runtime: FakePiRuntime, toolName: string) {
  for (const handler of runtime.handlers.get("tool_call") ?? []) {
    const result = await handler({ toolName, input: {} }, runtime.context)
    if (result?.block) return result
  }
}

test("child work waits for a successful report and follow-up requires a fresh report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-report-gate-"))
  const runtime = new FakePiRuntime()
  process.env.PI_BACKGROUND_AGENT_STATUS_FILE = join(directory, "status")
  try {
    await backgroundAgent(runtime.pi, { tmux: new FakeTmuxProcessAdapter() })
    await runtime.emit("agent_start")
    assert.ok(runtime.activeTools.includes("read"))
    for (const tool of ["read", "bash", "background_monitor", "codemode", "background_task"]) {
      assert.equal((await toolCall(runtime, tool))?.block, true)
    }
    assert.equal(await toolCall(runtime, "background_agent_report"), undefined)
    await assert.rejects(runtime.execute("background_agent_report", { activity: "  " }))
    assert.equal((await toolCall(runtime, "read"))?.block, true)
    await writeFile(`${process.env.PI_BACKGROUND_AGENT_STATUS_FILE}.progress`, "invalid json")
    await assert.rejects(runtime.execute("background_agent_report", { activity: "Checking tests" }))
    assert.equal((await toolCall(runtime, "read"))?.block, true)
    await rm(`${process.env.PI_BACKGROUND_AGENT_STATUS_FILE}.progress`)
    await runtime.execute("background_agent_report", { activity: "Checking tests", state: "working" })
    assert.equal(await toolCall(runtime, "read"), undefined)
    await runtime.execute("background_agent_report", { activity: "Done", state: "completed" })
    await runtime.emit("agent_start")
    assert.equal((await toolCall(runtime, "bash"))?.block, true)
    await runtime.execute("background_agent_report", { activity: "Checking follow-up" })
    assert.equal(await toolCall(runtime, "bash"), undefined)
  } finally {
    await runtime.emit("session_shutdown", { reason: "reload" })
    await rm(directory, { recursive: true, force: true })
  }
})

test("Root Pi work does not require a report", async () => {
  const runtime = new FakePiRuntime()
  await backgroundAgent(runtime.pi, { tmux: new FakeTmuxProcessAdapter() })
  assert.equal(await toolCall(runtime, "bash"), undefined)
  await runtime.emit("session_shutdown", { reason: "reload" })
})
