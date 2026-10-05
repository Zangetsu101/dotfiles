import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { BackgroundTasks, type BackgroundTask } from "./lib/background-task.ts"
import { familyForContext } from "./lib/background-family.ts"

const STATUS_KEY = "background-tasks"

export function formatRunningTasks(tasks: BackgroundTask[], nodeId?: string): string | undefined {
  const running = tasks.filter((task) => task.status === "running" && task.id !== nodeId)
  if (!running.length) return undefined
  const agents = running.filter((task) => task.kind === "agent").length
  const monitors = running.filter((task) => task.kind === "monitor").length
  const parts = [
    agents ? `${agents} agent${agents === 1 ? "" : "s"}` : "",
    monitors ? `${monitors} monitor${monitors === 1 ? "" : "s"}` : "",
  ].filter(Boolean)
  return `tasks: ${parts.join(" · ")}`
}

export default function (pi: ExtensionAPI, options: { tasks?: BackgroundTasks } = {}) {
  const tasks = options.tasks ?? new BackgroundTasks()
  let stopMetadata: (() => void) | undefined
  let generation = 0
  let shuttingDown = false

  const restore = async (reason: string, ctx: ExtensionContext) => {
    const restoring = ++generation
    stopMetadata?.()
    stopMetadata = undefined
    if (shuttingDown || !ctx.hasUI) return
    const family = familyForContext(reason, ctx, pi.getSessionName?.())
    const stop = await tasks.watchMetadata({ subtreeRootId: family.nodeId }, (visible) => {
      if (!shuttingDown && restoring === generation) ctx.ui.setStatus(STATUS_KEY, formatRunningTasks(visible, family.nodeId))
    })
    if (shuttingDown || restoring !== generation) stop()
    else stopMetadata = stop
  }

  pi.on("session_start", async (event, ctx) => { await restore(event.reason, ctx) })
  pi.on("session_tree", async (_event, ctx) => { await restore("tree", ctx) })

  pi.on("session_shutdown", (_event, ctx) => {
    shuttingDown = true
    generation++
    stopMetadata?.()
    stopMetadata = undefined
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined)
  })
}
