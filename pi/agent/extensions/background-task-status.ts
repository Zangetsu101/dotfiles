import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { BackgroundTasks, type BackgroundTask } from "./lib/background-task.ts"
import { familyForContext } from "./lib/background-family.ts"

import { readAgentProgress, describeAgentProgress } from "./lib/background-progress.ts"

const STATUS_KEY = "background-tasks"

export function formatRunningTasks(tasks: BackgroundTask[], nodeId?: string, now = Date.now()): string | undefined {
  const running = tasks.filter((task) => task.status === "running" && task.id !== nodeId)
  const reported = running.filter((task) => task.kind === "agent" && task.progress)
  if (!running.length && !reported.length) return undefined
  const agents = running.filter((task) => task.kind === "agent").length
  const monitors = running.filter((task) => task.kind === "monitor").length
  const parts = [
    agents ? `${agents} agent${agents === 1 ? "" : "s"}` : "",
    monitors ? `${monitors} monitor${monitors === 1 ? "" : "s"}` : "",
  ].filter(Boolean)
  const activities = reported.map((task) => {
    const progress = task.progress!
    const compact = { ...progress, latest: { ...progress.latest, activity: [...progress.latest.activity.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")].slice(0, 60).join(""), help: undefined } }
    return `${task.label}: ${describeAgentProgress(compact, now)}`
  })
  return `tasks: ${[...parts, ...activities].join(" · ")}`
}

export default function (pi: ExtensionAPI, options: { tasks?: BackgroundTasks } = {}) {
  const tasks = options.tasks ?? new BackgroundTasks()
  let stopMetadata: (() => void) | undefined
  let generation = 0
  let shuttingDown = false
  let ageTimer: NodeJS.Timeout | undefined

  const restore = async (reason: string, ctx: ExtensionContext) => {
    const restoring = ++generation
    stopMetadata?.()
    stopMetadata = undefined
    if (ageTimer) clearInterval(ageTimer)
    ageTimer = undefined
    if (shuttingDown || !ctx.hasUI) return
    const family = familyForContext(reason, ctx, pi.getSessionName?.())
    let visibleTasks: BackgroundTask[] = []
    let updating = false
    const updateProgress = async () => {
      if (updating || shuttingDown || restoring !== generation) return
      updating = true
      try {
        const snapshot = visibleTasks
        const enriched = await Promise.all(snapshot.map(async (task) => task.kind === "agent" ? { ...task, progress: await readAgentProgress(task.statusFile) } : task))
        if (!shuttingDown && restoring === generation && snapshot === visibleTasks) ctx.ui.setStatus(STATUS_KEY, formatRunningTasks(enriched, family.nodeId))
      } finally { updating = false }
    }
    ageTimer = setInterval(() => { void updateProgress().catch((error) => console.error("background task progress:", error)) }, 1000)
    const stop = await tasks.watchMetadata({ subtreeRootId: family.nodeId }, (visible) => {
      if (!shuttingDown && restoring === generation) {
        visibleTasks = visible
        ctx.ui.setStatus(STATUS_KEY, formatRunningTasks(visible, family.nodeId))
        void updateProgress().catch((error) => console.error("background task progress:", error))
      }
    })
    if (shuttingDown || restoring !== generation) stop()
    else stopMetadata = stop
  }

  pi.on("session_start", async (event, ctx) => { await restore(event.reason, ctx) })
  pi.on("session_tree", async (_event, ctx) => { await restore("tree", ctx) })

  pi.on("session_shutdown", (_event, ctx) => {
    shuttingDown = true
    generation++
    if (ageTimer) clearInterval(ageTimer)
    ageTimer = undefined
    stopMetadata?.()
    stopMetadata = undefined
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined)
  })
}
