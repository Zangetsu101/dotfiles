import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import backgroundAgent from "../extensions/background-agent.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"

async function waitFor(predicate: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`Timed out waiting for ${description}`)
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

test("force message cancels real Pi bash and its subprocess without killing the session or an unrelated process", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-force-real-"))
  const previous = { ...process.env }
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_")) delete process.env[key]
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux, { metadataDirectory: directory })
  const parent = new FakePiRuntime()
  const unrelated = spawn("sleep", ["60"], { stdio: "ignore" })
  let ownedPid = 0
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined
  try {
    await backgroundAgent(parent.pi, { tasks, tmux, pollMs: 10 })
    const spawned = await parent.execute("background_agent", { task: "Initial assignment", expectedCompletionMinutes: 1 })
    process.env.PI_BACKGROUND_AGENT_STATUS_FILE = spawned.details.statusFile
    process.env.PI_BACKGROUND_AGENT_DEPTH = "3"
    const faux = fauxProvider({ tokensPerSecond: 0 })
    const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false })
    modelRuntime.registerNativeProvider(faux.provider)
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
    const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [(pi) => backgroundAgent(pi, { tmux, pollMs: 10 })] })
    await resourceLoader.reload()
    ;({ session } = await createAgentSession({ cwd: directory, modelRuntime, model: faux.getModel(), resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(directory) }))
    await session.bindExtensions({ mode: "json" })
    const pidFile = join(directory, "owned.pid")
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("background_agent_report", { state: "working", activity: "Starting work" })),
      fauxAssistantMessage(fauxToolCall("bash", { command: `sleep 60 & echo $! > '${pidFile}'; wait` })),
      fauxAssistantMessage("Recovery received."),
    ])
    const run = session.prompt("Start blocking work.")
    await waitFor(() => existsSync(pidFile), "bash subprocess")
    ownedPid = Number(await readFile(pidFile, "utf8"))
    assert.ok(alive(ownedPid))
    assert.ok(unrelated.pid && alive(unrelated.pid))
    const result = await parent.execute("background_agent_message", { id: spawned.details.id, message: "Stop and recover", force: true })
    assert.equal(result.details.status, "delivered")
    assert.equal(result.details.interruption, "confirmed")
    await run
    await waitFor(() => !alive(ownedPid), "owned subprocess exit")
    assert.ok(unrelated.pid && alive(unrelated.pid), "unrelated process must survive")
    await waitFor(() => session!.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Stop and recover")), "recovery message")
    await waitFor(() => !session!.isStreaming, "recovery turn")
    assert.equal(session.getLastAssistantText(), "Recovery received.")
  } finally {
    if (session) {
      await session.abort()
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" })
      session.dispose()
    }
    if (ownedPid && alive(ownedPid)) { try { process.kill(ownedPid, "SIGKILL") } catch {} }
    unrelated.kill("SIGKILL")
    await parent.emit("session_shutdown")
    await rm(directory, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_")) delete process.env[key]
    Object.assign(process.env, previous)
  }
})
