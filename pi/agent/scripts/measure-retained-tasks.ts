// Bounded synthetic probe: no real tmux server, child Pi, or provider calls.
import { monitorEventLoopDelay } from "node:perf_hooks"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import backgroundAgent from "../extensions/background-agent.ts"
import { BackgroundTasks, writeTaskCompletion } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "../tests/support/background-task-runtime.ts"

// This standalone probe must not join the invoking agent's real task family.
for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_")) delete process.env[key]
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
for (const count of [0, 5, 20]) {
  const directory = await mkdtemp(join(tmpdir(), "pi-retained-probe-"))
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux, { metadataDirectory: directory })
  const parent = new FakePiRuntime()
  let calls = 0
  const run = tmux.run.bind(tmux)
  tmux.run = async (args) => { calls++; return run(args) }
  const delay = monitorEventLoopDelay({ resolution: 10 })
  try {
    for (let i = 0; i < count; i++) {
      const task = await tasks.create({ kind: "agent", label: `Completed ${i}`, cwd: directory,
        command: "unused", args: [], familyId: "family:conversation", rootId: "root:conversation",
        rootPane: "%root", parentId: "root:conversation" })
      await writeTaskCompletion(task.statusFile, { kind: "settled", output: "Done" })
      await tasks.setStatus(task, "succeeded")
    }
    await backgroundAgent(parent.pi, { tasks, tmux })
    await parent.emit("session_start", { reason: "startup" })
    await pause(100)
    calls = 0
    delay.enable()
    const cpu = process.cpuUsage()
    const start = performance.now()
    await pause(2200)
    const elapsed = performance.now() - start
    const used = process.cpuUsage(cpu)
    delay.disable()
    console.log(JSON.stringify({ retained: count, elapsedMs: Math.round(elapsed), tmuxCalls: calls,
      cpuMs: (used.user + used.system) / 1000, eventLoopP99Ms: delay.percentile(99) / 1e6 }))
  } finally {
    delay.disable()
    await parent.emit("session_shutdown", { reason: "reload" })
    await rm(directory, { recursive: true, force: true })
  }
}
