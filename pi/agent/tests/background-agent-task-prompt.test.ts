import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import backgroundAgentExtension from "../extensions/background-agent.ts"

test("background agents are available through depth one and unavailable at depth two", async () => {
  const previousAgentStatus = process.env.PI_BACKGROUND_AGENT_STATUS_FILE
  const previousDepth = process.env.PI_BACKGROUND_AGENT_DEPTH
  const previousTmuxPane = process.env.TMUX_PANE
  process.env.TMUX_PANE = "%isolated-depth-test"
  const registeredAtDepth = async (depth: string) => {
    process.env.PI_BACKGROUND_AGENT_STATUS_FILE = `/tmp/depth-${depth}`
    process.env.PI_BACKGROUND_AGENT_DEPTH = depth
    const tools: string[] = []
    await backgroundAgentExtension({
      events: new EventEmitter(), on() {}, registerCommand() {},
      registerTool(tool: { name: string }) { tools.push(tool.name) },
      getThinkingLevel() { return "medium" },
    } as any)
    return tools
  }

  try {
    assert.deepEqual(await registeredAtDepth("1"), ["background_agent"])
    assert.deepEqual(await registeredAtDepth("2"), [])
  } finally {
    if (previousAgentStatus === undefined) delete process.env.PI_BACKGROUND_AGENT_STATUS_FILE
    else process.env.PI_BACKGROUND_AGENT_STATUS_FILE = previousAgentStatus
    if (previousDepth === undefined) delete process.env.PI_BACKGROUND_AGENT_DEPTH
    else process.env.PI_BACKGROUND_AGENT_DEPTH = previousDepth
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
      registerTool(tool: { name: string }) { tools.push(tool.name) },
      getThinkingLevel() { return "medium" },
    } as any)
    assert.deepEqual(tools, ["background_agent"])
  } finally {
    if (previousTaskStatus === undefined) delete process.env.PI_BACKGROUND_TASK_STATUS_FILE
    else process.env.PI_BACKGROUND_TASK_STATUS_FILE = previousTaskStatus
    if (previousAgentStatus === undefined) delete process.env.PI_BACKGROUND_AGENT_STATUS_FILE
    else process.env.PI_BACKGROUND_AGENT_STATUS_FILE = previousAgentStatus
    if (previousTmuxPane === undefined) delete process.env.TMUX_PANE
    else process.env.TMUX_PANE = previousTmuxPane
  }
})
