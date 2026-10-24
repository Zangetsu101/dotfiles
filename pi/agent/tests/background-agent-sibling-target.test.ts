import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import backgroundAgent from "../extensions/background-agent.ts"
import backgroundMonitor from "../extensions/background-monitor.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"

test("messaging a settled agent does not revive a terminated sibling", async () => {
  const inherited = { ...process.env }
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_")) delete process.env[key]
  const directory = await mkdtemp(join(tmpdir(), "pi-sibling-target-"))
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux, { metadataDirectory: directory })
  const parent = new FakePiRuntime()
  const child = new FakePiRuntime()
  try {
    await backgroundAgent(parent.pi, { tasks, tmux, pollMs: 10, settledPollMs: 10 })
    backgroundMonitor(parent.pi, { tasks, pollMs: 10 })
    const first = await parent.execute("background_agent", { task: "First sibling", expectedCompletionMinutes: 1 })
    const second = await parent.execute("background_agent", { task: "Second sibling", expectedCompletionMinutes: 1 })
    await parent.execute("background_task", { action: "terminate", id: first.details.id })
    tmux.currentSession = first.details.target
    const window = [...tmux.sessions.values()].flatMap((session) => [...session.windows.values()]).find((window) => window.id === second.details.target)!
    process.env.TMUX_PANE = [...window.panes.keys()][0]!
    process.env.PI_BACKGROUND_AGENT_STATUS_FILE = second.details.statusFile
    process.env.PI_BACKGROUND_AGENT_DEPTH = "3"
    await tmux.complete(second.details.target)
    for (let attempt = 0; attempt < 100 && !parent.messages.some((message) => message.details.id === second.details.id); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(parent.messages.some((message) => message.details.id === second.details.id))
    await backgroundAgent(child.pi, { tmux, pollMs: 5 })
    await child.emit("session_start")
    const result = await parent.execute("background_agent_message", { id: second.details.id, message: "Follow-up" })
    assert.equal(result.details.status, "delivered")
    assert.equal(child.userMessages[0].text, "Follow-up")
    assert.equal(tmux.tasks().find((task) => task.target === first.details.target)?.status, "terminated")
    assert.equal(tmux.tasks().find((task) => task.target === second.details.target)?.status, "running")
    const sibling = [...tmux.sessions.values()].flatMap((session) => [...session.windows.values()]).find((window) => window.id === first.details.target)!
    const siblingModel = sibling.metadata.get("@pi_agent_model")
    const siblingThinking = sibling.metadata.get("@pi_agent_thinking")
    await child.emit("model_select", { model: { provider: "test", id: "model" } })
    await child.emit("thinking_level_select", { level: "high" })
    assert.equal(window.metadata.get("@pi_agent_model"), "test/model")
    assert.equal(window.metadata.get("@pi_agent_thinking"), "high")
    assert.equal(sibling.metadata.get("@pi_agent_model"), siblingModel)
    assert.equal(sibling.metadata.get("@pi_agent_thinking"), siblingThinking)
  } finally {
    await child.emit("session_shutdown")
    await parent.emit("session_shutdown")
    await rm(directory, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_") || key === "TMUX_PANE") delete process.env[key]
    Object.assign(process.env, inherited)
  }
})
