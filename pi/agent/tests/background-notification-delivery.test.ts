import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import backgroundMonitor from "../extensions/background-monitor.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"
import { installBackgroundTaskEnvironmentHooks } from "./support/background-task-environment.ts"

installBackgroundTaskEnvironmentHooks()

for (const status of ["completed", "failed"] as const) {
  test(`monitor ${status} requests steering delivery with idle turn triggering`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-notification-"))
    const tmux = new FakeTmuxProcessAdapter()
    const tasks = new BackgroundTasks(tmux, { metadataDirectory: directory })
    const parent = new FakePiRuntime()
    try {
      await backgroundMonitor(parent.pi, { tasks, tmux })
      const spawned = await parent.execute("background_monitor", { command: "build", expectedRunningMinutes: 1 })
      await tmux.complete(spawned.details.target, status, "Build result")
      for (let attempt = 0; attempt < 100 && parent.messages.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(parent.messages.length, 1)
      assert.equal(parent.messages[0].details.status, status)
      assert.deepEqual(parent.messageOptions[0], { deliverAs: "steer", triggerTurn: true })
    } finally {
      await parent.emit("session_shutdown", { reason: "reload" })
      await rm(directory, { recursive: true, force: true })
    }
  })
}
