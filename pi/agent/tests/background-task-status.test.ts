import assert from "node:assert/strict"
import test from "node:test"
import { formatRunningTasks } from "../extensions/background-task-status.ts"
import type { BackgroundTask } from "../extensions/lib/background-task.ts"

function task(kind: BackgroundTask["kind"], status: BackgroundTask["status"]): BackgroundTask {
  return { id: `${kind}-${status}`, kind, label: kind, status, target: kind, parent: "", cwd: "/repo", statusFile: "/tmp/status" }
}

test("a spawned agent does not count itself, but counts its descendants", () => {
  const self = { ...task("agent", "running"), id: "self", parentId: "root" }
  const child = { ...task("monitor", "running"), id: "child", parentId: "self" }
  assert.equal(formatRunningTasks([self], "self"), undefined)
  assert.equal(formatRunningTasks([self, child], "self"), "tasks: 1 monitor")
})

test("status line summarizes only running agents and monitors", () => {
  assert.equal(formatRunningTasks([
    task("agent", "running"),
    { ...task("agent", "running"), id: "agent-two" },
    task("monitor", "running"),
    task("monitor", "completed"),
  ]), "tasks: 2 agents · 1 monitor")
  assert.equal(formatRunningTasks([task("agent", "completed")]), undefined)
})
