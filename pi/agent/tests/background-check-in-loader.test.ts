import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { createExtensionRuntime, loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"
import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"
import { installBackgroundTaskEnvironmentHooks } from "./support/background-task-environment.ts"

installBackgroundTaskEnvironmentHooks()

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await pause(5)
  assert.ok(condition(), message)
}

for (const agentFirst of [true, false]) test(`separately loaded extensions reschedule agent check-ins before and after reload, agent first: ${agentFirst}`, { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-check-in-loader-"))
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux)
  const parent = new FakePiRuntime({ sessionId: `check-in:${directory}` })
  const optionsKey = `pi-check-in-test:${directory}`
  const globals = globalThis as unknown as Record<string, unknown>
  globals[optionsKey] = { tasks, tmux, millisecondsPerMinute: 20, pollMs: 5 }
  const paths = []
  for (const name of ["background-agent", "background-monitor"]) {
    const path = join(directory, `${name}.ts`)
    const source = fileURLToPath(new URL(`../extensions/${name}.ts`, import.meta.url))
    await writeFile(path, `import extension from ${JSON.stringify(source)}\nexport default (pi) => extension(pi, globalThis[${JSON.stringify(optionsKey)}])\n`)
    paths.push(path)
  }
  if (!agentFirst) paths.reverse()
  const bus = createEventBus()
  let runtime = createExtensionRuntime()
  const start = async () => {
    Object.assign(runtime, parent.pi)
    const loaded = await loadExtensions(paths, directory, bus, runtime)
    assert.deepEqual(loaded.errors, [])
    for (const extension of loaded.extensions) {
      for (const [name, tool] of extension.tools) parent.tools.set(name, tool.definition)
      for (const [name, handlers] of extension.handlers) parent.handlers.set(name, [...(parent.handlers.get(name) ?? []), ...handlers])
    }
    await parent.emit("session_start", { reason: "startup" })
  }
  let statusFile: string | undefined
  try {
    await start()
    const agent = await parent.execute("background_agent", { task: "still running", expectedCompletionMinutes: 1 })
    statusFile = agent.details.statusFile
    const notifications = () => parent.messages.filter((message) => message.customType === "background-agent-check-in")
    await waitFor(() => notifications().length === 1, "initial check-in must be delivered")
    const first = JSON.parse(await readFile(`${statusFile}.check-in`, "utf8"))
    const result = await parent.execute("background_task", { action: "check-in", id: agent.details.id, afterMinutes: 1 })
    assert.equal(result.details.status, "scheduled")
    const next = JSON.parse(await readFile(`${statusFile}.check-in`, "utf8"))
    assert.notEqual(next.id, first.id)
    await waitFor(() => notifications().length === 2, "rescheduled check-in must be delivered after the first delivery")
    const artifacts = await readdir(dirname(agent.details.statusFile))
    assert.ok(artifacts.includes(`completion.json.check-in.${first.id}.claimed`))
    assert.ok(artifacts.includes(`completion.json.check-in.${next.id}.claimed`))
    await pause(40)
    assert.equal(notifications().length, 2, "each deadline must deliver only once")

    await parent.emit("session_shutdown", { reason: "reload" })
    runtime.invalidate()
    parent.handlers.clear()
    parent.tools.clear()
    runtime = createExtensionRuntime()
    await start()
    await pause(40)
    assert.equal(notifications().length, 2, "reload must not redeliver claimed deadlines")
    const rescheduled = await parent.execute("background_task", { action: "check-in", id: agent.details.id, afterMinutes: 1 })
    assert.equal(rescheduled.details.status, "scheduled")
    await waitFor(() => notifications().length === 3, "replacement runtime must own the rescheduled check-in")
  } finally {
    await parent.emit("session_shutdown", { reason: "reload" })
    runtime.invalidate()
    bus.clear()
    delete globals[optionsKey]
    if (statusFile) await rm(dirname(statusFile), { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})
