import assert from "node:assert/strict"
import test from "node:test"
import backgroundAgentExtension, { delegatedTaskPrompt } from "../extensions/background-agent.ts"

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

test("a delegated task tells the child to do the work itself", () => {
  assert.equal(
    delegatedTaskPrompt("Review the authentication changes."),
    [
      "Delegated task: Complete all work—including skill delegation steps—in this session.",
      "",
      "Review the authentication changes.",
    ].join("\n"),
  )
})
