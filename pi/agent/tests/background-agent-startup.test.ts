import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import backgroundAgent from "../extensions/background-agent.ts"
import backgroundMonitor from "../extensions/background-monitor.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"
import { installBackgroundTaskEnvironmentHooks } from "./support/background-task-environment.ts"

installBackgroundTaskEnvironmentHooks()

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(condition(), "startup state did not reach the parent")
}

test("a child waiting for project trust requests parent attention before session startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-startup-"))
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux, { metadataDirectory: directory })
  const parent = new FakePiRuntime()
  const child = new FakePiRuntime()
  let resolveChoice!: (choice: string) => void
  let prompt: Promise<unknown> | undefined
  try {
    await backgroundAgent(parent.pi, { tasks, tmux, pollMs: 5 })
    await backgroundMonitor(parent.pi, { tasks, tmux })
    const spawned = await parent.execute("background_agent", { task: "Review", expectedCompletionMinutes: 1 })
    process.env.PI_BACKGROUND_AGENT_STATUS_FILE = spawned.details.statusFile
    process.env.PI_BACKGROUND_AGENT_DEPTH = "3"
    await backgroundAgent(child.pi, { tmux })
    child.context.cwd = directory
    const choices = ["Trust", "Trust (this session only)", "Do not trust"]
    let shown: unknown[] = []
    child.context.ui.select = (...args: unknown[]) => {
      if (shown.length) return Promise.resolve("Another choice")
      shown = args
      return new Promise<string>((resolve) => { resolveChoice = resolve })
    }
    await child.emit("project_trust", { cwd: directory })
    prompt = child.context.ui.select(`Trust project folder?\n${directory}`, choices)
    await waitFor(() => parent.messages.length > 0)
    const attention = parent.messages[0]
    assert.equal(attention.details.id, spawned.details.id)
    assert.equal(attention.details.status, "blocked")
    assert.match(attention.content, /project trust/i)
    assert.match(attention.content, new RegExp(`/task attach ${spawned.details.id}`))
    assert.doesNotMatch(attention.content, /background_agent_message to help/)
    assert.deepEqual(parent.messageOptions[0], { deliverAs: "steer", triggerTurn: true })
    assert.deepEqual(shown, [`Trust project folder?\n${directory}`, choices])
    const inspected = await parent.execute("background_task", { action: "inspect", id: spawned.details.id })
    assert.equal(inspected.details.progress.latest.state, "blocked")
    assert.match(inspected.details.progress.latest.help, /trust/i)
    await waitFor(() => !parent.activeTools.includes("background_agent_message"))
    for (const force of [false, true]) {
      const message = await parent.execute("background_agent_message", { id: spawned.details.id, message: "Proceed", force })
      assert.equal(message.details.status, "blocked")
      assert.equal(message.details.blocker, "project_trust")
      assert.match(message.content[0].text, /project trust/i)
      assert.match(message.content[0].text, new RegExp(`/task attach ${spawned.details.id}`))
    }
    await parent.emit("session_tree")
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(parent.messages.length, 1, "restoring must not repeat the attention notification")
    resolveChoice("Do not trust")
    assert.equal(await prompt, "Do not trust", "observing trust must preserve the user's decision")
    prompt = undefined
    await child.emit("session_start", { reason: "startup" })
    await waitFor(() => parent.activeTools.includes("background_agent_message"))
    assert.equal(await child.context.ui.select("Unrelated dialog", ["Another choice"]), "Another choice")
    const ready = await parent.execute("background_task", { action: "inspect", id: spawned.details.id })
    assert.equal(ready.details.progress.latest.state, "working")
    assert.match(ready.details.progress.latest.activity, /Starting assignment/)
    const gate = child.handlers.get("tool_call")![0]
    assert.equal((await gate({ toolName: "bash" }, child.context)).block, true, "startup reporting must not replace the agent's initial report")
    const delivered = await parent.execute("background_agent_message", { id: spawned.details.id, message: "Follow-up" })
    assert.equal(delivered.details.status, "delivered")
    assert.equal(child.userMessages[0].text, "Follow-up")
    await child.execute("background_agent_report", { state: "blocked", activity: "Need credentials", help: "Supply a token", attention: true })
    await waitFor(() => parent.messages.length === 2)
    assert.match(parent.messages[1].content, /background_agent_message to help/)
    assert.doesNotMatch(parent.messages[1].content, /trust prompt/)
    assert.ok(parent.activeTools.includes("background_agent_message"), "ordinary blockers remain messageable")
    await child.emit("session_start", { reason: "reload" })
    const reloaded = await parent.execute("background_task", { action: "inspect", id: spawned.details.id })
    assert.equal(reloaded.details.progress.latest.activity, "Need credentials", "session startup must preserve an ordinary blocker")
    const help = await parent.execute("background_agent_message", { id: spawned.details.id, message: "Here is help" })
    assert.equal(help.details.status, "delivered")
    const exited = (await tasks.list()).find((task) => task.id === spawned.details.id)!
    await tasks.setStatus(exited, "terminated")
    const unavailable = await parent.execute("background_agent_message", { id: spawned.details.id, message: "Too late" })
    assert.equal(unavailable.details.status, "not_running")
    assert.match(unavailable.content[0].text, /no longer running/)
  } finally {
    resolveChoice?.("Do not trust")
    await prompt
    await child.emit("session_shutdown")
    await parent.emit("session_shutdown")
    await rm(directory, { recursive: true, force: true })
  }
})

test("a reporting failure logs a diagnostic without preventing the trust decision", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-startup-error-"))
  process.env.PI_BACKGROUND_AGENT_STATUS_FILE = join(directory, "missing/completion.json")
  const child = new FakePiRuntime()
  const diagnostic = t.mock.method(console, "error", () => {})
  try {
    await backgroundAgent(child.pi, { tmux: new FakeTmuxProcessAdapter() })
    child.context.ui.select = async () => "Do not trust"
    await child.emit("project_trust", { cwd: directory })
    assert.equal(await child.context.ui.select("Trust project folder?", ["Do not trust"]), "Do not trust")
    assert.equal(diagnostic.mock.callCount(), 1)
    assert.match(String(diagnostic.mock.calls[0].arguments[0]), /background agent startup/)
    assert.match(String(diagnostic.mock.calls[0].arguments[1]), /ENOENT/)
  } finally {
    await child.emit("session_shutdown")
    await rm(directory, { recursive: true, force: true })
  }
})
