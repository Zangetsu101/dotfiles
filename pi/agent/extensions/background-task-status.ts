import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { BACKGROUND_TASK_CREATED, BackgroundTasks, type BackgroundTask } from "./lib/background-task.ts"

const REFRESH_MS = 1_000
const STATUS_KEY = "background-tasks"

export function formatRunningTasks(tasks: BackgroundTask[]): string | undefined {
  const running = tasks.filter((task) => task.storageMode !== "legacy" && task.status === "running")
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

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return
    const owner = process.env.TMUX_PANE ?? ""
    update = async () => ctx.ui.setStatus(STATUS_KEY, formatRunningTasks(await tasks.list(owner)))
    await update()
    timer = setInterval(() => void update?.(), REFRESH_MS)
  })

  pi.events.on(BACKGROUND_TASK_CREATED, () => void update?.())

  pi.on("session_shutdown", (_event, ctx) => {
    if (timer) clearInterval(timer)
    timer = undefined
    update = undefined
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined)
  })
}
