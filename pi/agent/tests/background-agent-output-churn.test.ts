import assert from "node:assert/strict"
import { appendFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import agentExtension from "../extensions/background-agent.ts"
import monitorExtension from "../extensions/background-monitor.ts"
import statusExtension from "../extensions/background-task-status.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"

let environment: NodeJS.ProcessEnv
beforeEach(() => {
  environment = { ...process.env }
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_")) delete process.env[key]
  process.env.TMUX = "fake"
  process.env.TMUX_PANE = "%root"
})
afterEach(() => { process.env = environment })

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Counts tmux commands issued after the agents' terminal output grows, with nothing else changing. */
async function tmuxCallsDuringOutput(agents: number, writes: number): Promise<number> {
  const tmux = new FakeTmuxProcessAdapter()
  let calls = 0
  const run = tmux.run.bind(tmux)
  tmux.run = (args) => { calls++; return run(args) }
  const runtime = new FakePiRuntime({ sessionId: `output-churn-${agents}` })
  // A private metadata directory keeps other Pi processes and test files from invalidating this one.
  const metadataDirectory = await mkdtemp(join(tmpdir(), "output-churn-metadata-"))
  const tasks = new BackgroundTasks(tmux, { metadataDirectory })
  monitorExtension(runtime.pi, { tasks, pollMs: 5 })
  await agentExtension(runtime.pi, { tasks, tmux, pollMs: 5, settledPollMs: 5 })
  statusExtension(runtime.pi, { tasks })
  runtime.context.ui.setStatus = () => {}
  await runtime.emit("session_start", { reason: "resume" })
  try {
    for (let index = 0; index < agents; index++) await runtime.execute("background_agent", { task: `work ${index}`, expectedCompletionMinutes: 5 })
    const outputs = (await tasks.list()).filter((task) => task.kind === "agent").map((task) => task.outputFile!)
    assert.equal(outputs.length, agents)
    await settle(300)
    calls = 0
    for (let write = 0; write < writes; write++) {
      for (const output of outputs) await appendFile(output, "\r⠋ Working")
      await settle(20)
    }
    await settle(300)
    return calls
  } finally {
    await runtime.emit("session_shutdown", { reason: "reload" })
    await rm(metadataDirectory, { recursive: true, force: true })
  }
}

test("agent terminal output issues no tmux commands", async (t) => {
  for (const agents of [1, 4]) {
    await t.test(`${agents} agents`, async () => {
      assert.equal(await tmuxCallsDuringOutput(agents, 10), 0)
    })
  }
})
