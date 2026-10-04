import { existsSync } from "node:fs"
import { open } from "node:fs/promises"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { BackgroundTask, BackgroundTasks } from "./background-task.ts"

const OUTPUT_CHARS = 4_000

export async function readOutputTail(path: string | undefined, maxBytes = OUTPUT_CHARS): Promise<string> {
  if (!path) return ""
  let file
  try { file = await open(path, "r") } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw error
  }
  try {
    const { size } = await file.stat()
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, size - length)
    let start = 0
    if (size > length) while (start < bytesRead && (buffer[start]! & 0xc0) === 0x80) start++
    return buffer.toString("utf8", start, bytesRead)
  } finally { await file.close() }
}

export async function notifyRunningTask(
  pi: Pick<ExtensionAPI, "sendMessage">,
  tasks: Pick<BackgroundTasks, "completion" | "list">,
  task: BackgroundTask,
  active: () => boolean,
): Promise<boolean> {
  if (!active() || await tasks.completion(task)) return false
  const current = (await tasks.list({ subtreeRootId: task.parentId ?? task.id })).find((candidate) => candidate.id === task.id)
  if (!current || current.status !== "running") return false
  const output = await readOutputTail(task.outputFile)
  const elapsed = task.startedAt === undefined ? "unknown" : `${Math.max(0, Math.floor((Date.now() - task.startedAt) / 60_000))} minutes`
  if (!active() || await tasks.completion(task) || existsSync(task.statusFile)) return false
  pi.sendMessage({
    customType: task.kind === "agent" ? "background-agent-check-in" : "background-monitor-check-in",
    content: `Background ${task.kind} ${task.id} (${task.label}) status: running; elapsed: ${elapsed}.\nRecent output:\n${output.trim() || "(no output)"}\nUse background_task to inspect it or schedule another check-in.`,
    display: true,
  }, { deliverAs: "followUp", triggerTurn: true })
  return true
}
