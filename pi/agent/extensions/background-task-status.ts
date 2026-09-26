import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { BACKGROUND_TASK_CREATED, BackgroundTasks, type BackgroundTask } from "./lib/background-task.ts"
import { familyForContext, type TaskFamily } from "./lib/background-family.ts"

const REFRESH_MS = 1_000
const STATUS_KEY = "background-tasks"

export function formatRunningTasks(tasks: BackgroundTask[]): string | undefined {
  const running = tasks.filter((task) => task.status === "running")
  if (!running.length) return undefined
  const agents = running.filter((task) => task.kind === "agent").length
  const monitors = running.filter((task) => task.kind === "monitor").length
  const parts = [
    agents ? `${agents} agent${agents === 1 ? "" : "s"}` : "",
    monitors ? `${monitors} monitor${monitors === 1 ? "" : "s"}` : "",
  ].filter(Boolean)
  return `tasks: ${parts.join(" · ")}`
}

export default function (pi: ExtensionAPI) {
  const tasks = new BackgroundTasks()
  let timer: NodeJS.Timeout | undefined
  let update: (() => Promise<void>) | undefined
  let family: TaskFamily | undefined

  const restore = async (reason: string, ctx: ExtensionContext) => {
    family = familyForContext(reason, ctx, pi.getSessionName?.())
    if (update) await update()
  }

  pi.on("session_start", async (event, ctx) => {
    await restore(event.reason, ctx)
    if (!ctx.hasUI) return
    update = async () => ctx.ui.setStatus(STATUS_KEY, formatRunningTasks(await tasks.list({ subtreeRootId: family!.nodeId })))
    await update()
    timer = setInterval(() => void update?.(), REFRESH_MS)
  })

  pi.on("session_tree", async (_event, ctx) => { await restore("tree", ctx) })
  pi.events.on(BACKGROUND_TASK_CREATED, () => void update?.())

  pi.on("session_shutdown", (_event, ctx) => {
    if (timer) clearInterval(timer)
    timer = undefined
    update = undefined
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined)
  })
}
