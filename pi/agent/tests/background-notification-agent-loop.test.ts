import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai"
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import backgroundMonitor from "../extensions/background-monitor.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"
import { installBackgroundTaskEnvironmentHooks } from "./support/background-task-environment.ts"

installBackgroundTaskEnvironmentHooks()

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(predicate(), "expected Pi delivery boundary")
}

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, release: () => resolve() }
}

test("monitor completion reaches the next model request while tool calls continue, without aborting the active batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delivery-loop-"))
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux, { metadataDirectory: directory })
  const firstBatch = gate()
  const nextBatch = gate()
  const started: string[] = []
  const finished: string[] = []
  const aborted: boolean[] = []
  let continuingRequestSawCompletion = false
  let settled = false
  const faux = fauxProvider({ tokensPerSecond: 0 })
  const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false })
  modelRuntime.registerNativeProvider(faux.provider)
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [(pi) => backgroundMonitor(pi, { tasks, tmux })],
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    cwd: directory, modelRuntime, model: faux.getModel(), resourceLoader, settingsManager,
    sessionManager: SessionManager.inMemory(directory), noTools: "builtin",
    customTools: [{
      name: "work", label: "Work", description: "Continue work", parameters: Type.Object({ batch: Type.String() }),
      async execute(id, { batch }, signal) {
        started.push(id)
        await (batch === "first" ? firstBatch : nextBatch).promise
        aborted.push(signal?.aborted ?? false)
        finished.push(id)
        return { content: [{ type: "text", text: "Work completed" }], details: undefined }
      },
    }],
  })
  try {
    await session.bindExtensions({ mode: "json" })
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("background_monitor", { command: "build", expectedRunningMinutes: 1 })),
      fauxAssistantMessage([
        fauxToolCall("work", { batch: "first" }, { id: "first-a" }),
        fauxToolCall("work", { batch: "first" }, { id: "first-b" }),
      ]),
      (context) => {
        continuingRequestSawCompletion = context.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Build result"))
        return fauxAssistantMessage(fauxToolCall("work", { batch: "next" }, { id: "next" }))
      },
      fauxAssistantMessage("Reviewed the background result."),
    ])
    const run = session.prompt("Start a background build and keep working.").then(() => { settled = true })
    await waitFor(() => started.length === 2)
    const monitor = tmux.tasks().find((task) => task.kind === "monitor")!
    await tmux.complete(monitor.target, "completed", "Build result")
    await waitFor(() => session.agent.hasQueuedMessages())
    assert.deepEqual(finished, [], "notification must not interrupt active tools")
    assert.equal(settled, false)
    firstBatch.release()
    await waitFor(() => started.includes("next"))
    assert.equal(continuingRequestSawCompletion, true, "completion must reach the model before the continuing tool-call loop stops")
    assert.deepEqual(finished.sort(), ["first-a", "first-b"])
    assert.deepEqual(aborted, [false, false])
    assert.equal(settled, false, "parent run is still busy with another tool call")
    nextBatch.release()
    await run
    assert.deepEqual(aborted, [false, false, false])

    faux.appendResponses([
      fauxAssistantMessage(fauxToolCall("background_monitor", { command: "idle-build", expectedRunningMinutes: 1 })),
      fauxAssistantMessage("Waiting for the idle build."),
      fauxAssistantMessage("Reviewed the idle background result."),
    ])
    await session.prompt("Start another background build.")
    assert.equal(session.isStreaming, false)
    const idleMonitor = tmux.tasks().find((task) => task.kind === "monitor" && task.target !== monitor.target)!
    await tmux.complete(idleMonitor.target, "completed", "Idle build result")
    await waitFor(() => session.getLastAssistantText() === "Reviewed the idle background result." && !session.isStreaming)
  } finally {
    firstBatch.release()
    nextBatch.release()
    await session.abort()
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" })
    session.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
