import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { BackgroundTasks, watchStatusDirectory, type BackgroundTask } from "./lib/background-task.ts"
import { familyForContext } from "./lib/background-family.ts"

import { readAgentProgress } from "./lib/background-progress.ts"
import { dirname } from "node:path"
import { sharedDirectoryObservation } from "./lib/directory-observation.ts"

const STATUS_KEY = "background-tasks"
const replaceControlCharacters = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")

function formatActivity(task: BackgroundTask, now: number): string {
  const report = task.progress!.latest
  const characters = [...replaceControlCharacters(report.activity)]
  const activity = characters.length > 50 ? `${characters.slice(0, 49).join("")}…` : characters.join("")
  const detail = report.state === "working" ? activity : `${report.state} · ${activity}`
  const minutes = Math.max(0, Math.floor((now - report.at) / 60000))
  return `${detail} · updated ${minutes === 0 ? "<1m" : `${minutes}m`} ago`
}

function updateUI(ctx: ExtensionContext, tasks: BackgroundTask[], nodeId: string) {
  ctx.ui.setStatus(STATUS_KEY, formatRunningTasks(tasks, nodeId))
  const agents = tasks.filter((task) => task.status === "running" && task.kind === "agent" && task.id !== nodeId)
  const now = Date.now()
  const lines = agents.length < 2 ? [] : agents.map((task) => {
    const age = task.startedAt === undefined ? "age unknown" : `running ${Math.max(0, Math.floor((now - task.startedAt) / 1000))}s`
    const detail = task.progress ? formatActivity(task, now) : `awaiting progress · ${age}`
    return `${replaceControlCharacters(task.label)} · ${detail}`
  })
  ctx.ui.setStatus(`${STATUS_KEY}-progress`, lines.length ? lines.join("\n") : undefined)
}

const isSameRun = (cached: BackgroundTask, task: BackgroundTask) =>
  cached.status === "running" && task.status === "running" && task.startedAt !== undefined
  && cached.startedAt === task.startedAt && cached.statusFile === task.statusFile

/** Metadata carries no progress, so keep progress already read for the same run until the next read. */
function carryProgress(cached: BackgroundTask[], visible: BackgroundTask[]): BackgroundTask[] {
  const previous = new Map(cached.map((task) => [task.id, task]))
  return visible.map((task) => {
    const prior = previous.get(task.id)
    return !task.progress && prior && isSameRun(prior, task) ? { ...task, progress: prior.progress } : task
  })
}

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
  const activities = (agents === 1 ? running.filter((task) => task.kind === "agent") : []).map((task) =>
    task.progress ? formatActivity(task, now) : `${replaceControlCharacters(task.label)} · awaiting progress`,
  )
  return [...parts, ...activities].join(" · ")
}

export default function (pi: ExtensionAPI, options: { tasks?: BackgroundTasks; observation?: Pick<typeof sharedDirectoryObservation, "watch"> } = {}) {
  const tasks = options.tasks ?? new BackgroundTasks()
  let stopMetadata: (() => void) | undefined
  let generation = 0
  let shuttingDown = false
  let ageTimer: NodeJS.Timeout | undefined
  let stopProgress: (() => void) | undefined

  const restore = async (reason: string, ctx: ExtensionContext) => {
    const restoring = ++generation
    stopMetadata?.()
    stopMetadata = undefined
    stopProgress?.()
    stopProgress = undefined
    if (ageTimer) clearInterval(ageTimer)
    ageTimer = undefined
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined)
      ctx.ui.setStatus(`${STATUS_KEY}-progress`, undefined)
    }
    if (shuttingDown || !ctx.hasUI) return
    const family = familyForContext(reason, ctx, pi.getSessionName?.())
    let visibleTasks: BackgroundTask[] = []
    let cachedTasks: BackgroundTask[] = []
    let updating = false
    let dirty = false
    const subscriptions = new Map<string, () => void>()
    const active = () => !shuttingDown && restoring === generation
    stopProgress = () => {
      for (const stop of subscriptions.values()) stop()
      subscriptions.clear()
    }
    const updateProgress = async () => {
      dirty = true
      if (updating || !active()) return
      updating = true
      try {
        while (dirty && active()) {
          dirty = false
          const snapshot = visibleTasks
          const directories = new Map(snapshot.filter((task) => task.kind === "agent" && task.status === "running" && task.id !== family.nodeId).map((task) => [dirname(task.statusFile), task]))
          for (const [directory, stop] of subscriptions) {
            if (!directories.has(directory)) { stop(); subscriptions.delete(directory) }
          }
          for (const [directory, task] of directories) {
            if (subscriptions.has(directory)) continue
            const stop = await watchStatusDirectory(task, refreshProgress, options.observation)
            if (!active()) { stop(); return }
            subscriptions.set(directory, stop)
          }
          const enriched = await Promise.all(snapshot.map(async (task) => task.kind === "agent" && task.status === "running" && task.id !== family.nodeId
            ? { ...task, progress: await readAgentProgress(task.statusFile) ?? task.progress }
            : task))
          if (active() && snapshot === visibleTasks) {
            cachedTasks = enriched
            updateUI(ctx, cachedTasks, family.nodeId)
          }
        }
      } finally { updating = false }
    }
    const refreshProgress = () => { void updateProgress().catch((error) => console.error("background task progress:", error)) }
    ageTimer = setInterval(() => { if (active()) updateUI(ctx, cachedTasks, family.nodeId) }, 5000)
    const stop = await tasks.watchMetadata({ subtreeRootId: family.nodeId, routingFamilyId: family.familyId }, (visible) => {
      if (active()) {
        visibleTasks = carryProgress(cachedTasks, visible)
        cachedTasks = visibleTasks
        updateUI(ctx, cachedTasks, family.nodeId)
        refreshProgress()
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
    stopProgress?.()
    stopProgress = undefined
    if (ageTimer) clearInterval(ageTimer)
    ageTimer = undefined
    stopMetadata?.()
    stopMetadata = undefined
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined)
      ctx.ui.setStatus(`${STATUS_KEY}-progress`, undefined)
    }
  })
}
