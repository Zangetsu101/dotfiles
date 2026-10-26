import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import backgroundAgentExtension from "../extensions/background-agent.ts"
import backgroundMonitorExtension from "../extensions/background-monitor.ts"
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

test("monitor-only children retain lifecycle guidance and messaging owns acknowledgement", async () => {
  process.env.PI_BACKGROUND_AGENT_STATUS_FILE = "/tmp/monitor-prompt-test"
  const runtime = new FakePiRuntime()
  backgroundMonitorExtension(runtime.pi)
  await backgroundAgentExtension(runtime.pi)
  assert.equal(runtime.tools.has("background_agent"), false)
  const monitor = runtime.tools.get("background_monitor")
  const lifecycle = monitor.promptGuidelines.join("\n")
  assert.match(lifecycle, /continue independent work/)
  assert.match(lifecycle, /ending your turn.*progress update/)
  assert.match(lifecycle, /automatically resume.*without a user reply/)
  assert.match(lifecycle, /Inspect tasks only.*check-in.*concrete failure/)
  assert.match(lifecycle, /If the user was waiting.*restate the question/)
  assert.match(lifecycle, /all background work is complete.*standalone final result/)
  assert.match(runtime.tools.get("background_agent_message").promptGuidelines.join("\n"), /follow-up work.*delivery acknowledgement/)
  const parameters = runtime.tools.get("background_task").parameters.properties
  assert.match(parameters.id.description, /Required for inspect, check-in, and terminate/)
  assert.match(parameters.afterMinutes.description, /Only the agent that spawned/)
  assert.match(runtime.tools.get("background_task").promptGuidelines.join("\n"), /inspect the task.*schedule another check-in.*Continue following up/)
})

test("child progress guidelines require the reporting tool at the start and activity changes", async () => {
  process.env.PI_BACKGROUND_AGENT_STATUS_FILE = "/tmp/progress-guidelines-test"
  const runtime = new FakePiRuntime()
  await backgroundAgentExtension(runtime.pi)
  const guidelines = runtime.tools.get("background_agent_report").promptGuidelines.join("\n")
  assert.match(guidelines, /Call background_agent_report before starting/)
  assert.match(guidelines, /Call it again when your activity changes/)
  assert.match(guidelines, /state.*blocked/)
  const parameters = runtime.tools.get("background_agent_report").parameters.properties
  assert.match(parameters.state.description, /Defaults to working/)
  assert.match(parameters.attention.description, /request parent intervention/)
})

for (const maxDepth of [1, 3]) test(`background agents respect a configured maximum depth of ${maxDepth}`, async () => {
  const previousAgentStatus = process.env.PI_BACKGROUND_AGENT_STATUS_FILE
  const previousDepth = process.env.PI_BACKGROUND_AGENT_DEPTH
  const previousMaxDepth = process.env.PI_BACKGROUND_AGENT_MAX_DEPTH
  const previousTmuxPane = process.env.TMUX_PANE
  process.env.PI_BACKGROUND_AGENT_ALLOW_DELEGATION = "1"
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
    assert.deepEqual(await registeredAtDepth(String(maxDepth)), ["background_agent_report", "background_agent_message"])
    assert.deepEqual(await registeredAtDepth(String(maxDepth + 1)), ["background_agent_report", "background_agent_message"])
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
      events: { on() {}, emit() {} },
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
