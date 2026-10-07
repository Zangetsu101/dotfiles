import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import backgroundAgentExtension from "../extensions/background-agent.ts"
import { FakePiRuntime } from "./support/background-task-runtime.ts"
import { installBackgroundTaskEnvironmentHooks } from "./support/background-task-environment.ts"

installBackgroundTaskEnvironmentHooks()

test("delegation guidelines define yielding, automatic resumption, and inspection triggers", async () => {
  const runtime = new FakePiRuntime()
  await backgroundAgentExtension(runtime.pi)
  const guidelines = runtime.tools.get("background_agent").promptGuidelines as string[]
  const yielding = guidelines.find((line) => line.includes("ending your turn"))
  assert.ok(yielding, "yield must specify ending the turn, not keeping a tool call active")
  assert.match(yielding, /progress update/)
  assert.match(yielding, /automatically.*resume/)
  assert.match(yielding, /without a user reply/)
  assert.match(yielding, /Inspect tasks only.*check-in.*concrete failure/)
})

for (const maxDepth of [1, 3]) test(`background agents respect a configured maximum depth of ${maxDepth}`, async () => {
  const previousAgentStatus = process.env.PI_BACKGROUND_AGENT_STATUS_FILE
  const previousDepth = process.env.PI_BACKGROUND_AGENT_DEPTH
  const previousMaxDepth = process.env.PI_BACKGROUND_AGENT_MAX_DEPTH
  const previousTmuxPane = process.env.TMUX_PANE
  process.env.PI_BACKGROUND_AGENT_MAX_DEPTH = String(maxDepth)
  process.env.TMUX_PANE = "%isolated-depth-test"
  const registeredAtDepth = async (depth: string) => {
    process.env.PI_BACKGROUND_AGENT_STATUS_FILE = `/tmp/depth-${depth}`
    process.env.PI_BACKGROUND_AGENT_DEPTH = depth
    const tools: string[] = []
    await backgroundAgentExtension({
      events: new EventEmitter(), on() {}, registerCommand() {},
      registerMessageRenderer() {}, registerTool(tool: { name: string }) { tools.push(tool.name) },
      getThinkingLevel() { return "medium" },
    } as any)
    return tools
  }

  try {
    assert.deepEqual(await registeredAtDepth(String(maxDepth - 1)), ["background_agent_report", "background_agent_message", "background_agent"])
    assert.deepEqual(await registeredAtDepth(String(maxDepth)), ["background_agent_report"])
    assert.deepEqual(await registeredAtDepth(String(maxDepth + 1)), ["background_agent_report"])
  } finally {
    if (previousAgentStatus === undefined) delete process.env.PI_BACKGROUND_AGENT_STATUS_FILE
    else process.env.PI_BACKGROUND_AGENT_STATUS_FILE = previousAgentStatus
    if (previousDepth === undefined) delete process.env.PI_BACKGROUND_AGENT_DEPTH
    else process.env.PI_BACKGROUND_AGENT_DEPTH = previousDepth
    if (previousMaxDepth === undefined) delete process.env.PI_BACKGROUND_AGENT_MAX_DEPTH
    else process.env.PI_BACKGROUND_AGENT_MAX_DEPTH = previousMaxDepth
    if (previousTmuxPane === undefined) delete process.env.TMUX_PANE
    else process.env.TMUX_PANE = previousTmuxPane
  }
})

test("generic background task metadata does not turn Pi into an agent child bridge", async () => {
  const previousTaskStatus = process.env.PI_BACKGROUND_TASK_STATUS_FILE
  const previousAgentStatus = process.env.PI_BACKGROUND_AGENT_STATUS_FILE
  const previousTmuxPane = process.env.TMUX_PANE
  process.env.TMUX_PANE = "%isolated-background-agent-test"
  process.env.PI_BACKGROUND_TASK_STATUS_FILE = "/tmp/generic-task-status"
  delete process.env.PI_BACKGROUND_AGENT_STATUS_FILE
  const tools: string[] = []

  try {
    await backgroundAgentExtension({
      events: { on() {} },
      on() {},
      registerCommand() {},
      registerMessageRenderer() {},
      registerTool(tool: { name: string }) { tools.push(tool.name) },
      getThinkingLevel() { return "medium" },
    } as any)
    assert.deepEqual(tools, ["background_agent_message", "background_agent"])
  } finally {
    if (previousTaskStatus === undefined) delete process.env.PI_BACKGROUND_TASK_STATUS_FILE
    else process.env.PI_BACKGROUND_TASK_STATUS_FILE = previousTaskStatus
    if (previousAgentStatus === undefined) delete process.env.PI_BACKGROUND_AGENT_STATUS_FILE
    else process.env.PI_BACKGROUND_AGENT_STATUS_FILE = previousAgentStatus
    if (previousTmuxPane === undefined) delete process.env.TMUX_PANE
    else process.env.TMUX_PANE = previousTmuxPane
  }
})
