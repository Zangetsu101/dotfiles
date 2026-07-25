import assert from "node:assert/strict"
import test from "node:test"
import { formatRunningTasks } from "../extensions/background-task-status.ts"
import type { BackgroundTask } from "../extensions/lib/background-task.ts"

function task(kind: BackgroundTask["kind"], status: BackgroundTask["status"]): BackgroundTask {
  return { id: `${kind}-${status}`, kind, label: kind, status, target: kind, owner: "%1", parent: "", cwd: "/repo", statusFile: "/tmp/status" }
}

test("status line summarizes only running agents and monitors", () => {
  assert.equal(formatRunningTasks([
    task("agent", "running"),
    { ...task("agent", "running"), id: "agent-two" },
    task("monitor", "running"),
    { ...task("monitor", "running"), id: "legacy-monitor", storageMode: "legacy" },
    task("monitor", "completed"),
  ]), "tasks: 2 agents · 1 monitor")
  assert.equal(formatRunningTasks([task("agent", "completed")]), undefined)
})
