import { existsSync } from "node:fs"
import { open, stat } from "node:fs/promises"
import { dirname } from "node:path"
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
): Promise<void> {
  if (!active() || await tasks.completion(task)) return
  const current = (await tasks.list({ subtreeRootId: task.parentId ?? task.id })).find((candidate) => candidate.id === task.id)
  if (!current || current.status !== "running") return
  const output = await readOutputTail(task.outputFile)
  const started = await stat(dirname(task.statusFile)).catch(() => undefined)
  const elapsed = started ? `${Math.max(0, Math.floor((Date.now() - started.birthtimeMs) / 60_000))} minutes` : "unknown"
  if (!active() || await tasks.completion(task) || existsSync(task.statusFile)) return
  pi.sendMessage({
    customType: task.kind === "agent" ? "background-agent-check-in" : "background-monitor-check-in",
    content: `Background ${task.kind} ${task.id} (${task.label}) is still running after ${elapsed}.\nRecent output:\n${output.trim() || "(no output)"}\nUse background_task to inspect it or schedule another check-in.`,
    display: true,
  }, { deliverAs: "followUp", triggerTurn: true })
}
