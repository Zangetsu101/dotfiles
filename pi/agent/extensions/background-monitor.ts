import { readFile } from "node:fs/promises"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { BACKGROUND_ACTIVITY_FINISHED, BACKGROUND_ACTIVITY_STARTED, type BackgroundActivity } from "./lib/background-activity.ts"
import { BACKGROUND_TASK_CREATED, BackgroundTasks, safeTaskLabel, type BackgroundTask } from "./lib/background-task.ts"

const MAX_OUTPUT_CHARS = 50_000
const POLL_MS = 100

export function taskArgumentCompletions(tasks: BackgroundTask[], prefix: string) {
  const actions = ["list", "attach", "return", "terminate", "clean"]
  const normalized = prefix.trimStart()
  if (!normalized) return actions.map((value) => ({ value, label: value }))
  const words = normalized.split(/\s+/)
  if (words.length <= 1 && !prefix.endsWith(" ")) {
    return actions.filter((action) => action.startsWith(words[0] ?? "")).map((value) => ({ value, label: value }))
  }
  const action = words[0]
  if (action === "list" || action === "return") return null
  if (action !== "attach" && action !== "terminate" && action !== "clean") return null
  const query = words.slice(1).join(" ").toLowerCase()
  const matches = tasks.filter((task) =>
    [task.kind, task.status, task.label, safeTaskLabel(task.label), task.id, task.target]
      .join(" ")
      .toLowerCase()
      .includes(query),
  ).map((task) => ({
    value: `${action} ${task.id}`,
    label: task.label,
    description: `${task.kind} · ${task.status} · ${task.target}`,
  }))
  return matches.length ? matches : null
}

type BackgroundMonitorOptions = {
  tasks?: BackgroundTasks
  pollMs?: number
  owner?: string
}

export default function (pi: ExtensionAPI, options: BackgroundMonitorOptions = {}) {
  const tasks = options.tasks ?? new BackgroundTasks()
  const pollMs = options.pollMs ?? POLL_MS
  const owner = options.owner ?? process.env.TMUX_PANE ?? ""
  const timers = new Map<string, NodeJS.Timeout>()
  const consumers = new Set<Promise<void>>()
  const activities = new Map<string, BackgroundActivity>()
  let shuttingDown = false
  let shutdown: Promise<void> | undefined
  let taskCache: BackgroundTask[] = []

  const refreshTasks = async () => (taskCache = await tasks.list(owner))
  const ownedRunning = async () => (await tasks.list(owner)).filter((task) => task.storageMode !== "legacy" && task.kind === "monitor" && task.status === "running")

  const monitor = (task: BackgroundTask, ctx: ExtensionContext) => {
    if (timers.has(task.id)) return
    const activity = { id: `background-monitor:${task.id}`, source: "background_monitor", label: task.label }
    activities.set(task.id, activity)
    pi.events.emit(BACKGROUND_ACTIVITY_STARTED, activity)
    const consume = async () => {
      if (shuttingDown) return
      const completion = await tasks.claimCompletion(task)
      if (!completion) return
      clearInterval(timers.get(task.id))
      timers.delete(task.id)
      activities.delete(task.id)
      await tasks.setStatus(task, completion.status)
      pi.events.emit(BACKGROUND_ACTIVITY_FINISHED, activity)
      let output = ""
      try { if (task.outputFile) output = (await readFile(task.outputFile, "utf8")).slice(-MAX_OUTPUT_CHARS) } catch {}
      const failed = completion.status !== "completed"
      const status = completion.status === "cancelled"
        ? `was cancelled${completion.reason ? `: ${completion.reason}` : ""}`
        : completion.status === "failed"
          ? `failed with exit code ${completion.exitCode ?? "unknown"}`
          : `finished with exit code ${completion.exitCode ?? 0}`
      const summary = `Background monitor ${task.id} (${task.label}) ${status}.`
      const attach = process.env.TMUX ? `/task attach ${task.id}` : `tmux attach -t ${task.target}`
      if (ctx.hasUI) ctx.ui.notify(summary, failed ? "error" : "info")
      pi.sendMessage({ customType: "background-monitor", content: `${summary}\nAttach with: ${attach}\n\nOutput:\n${output.trim() || "(no output)"}\n\nReview the result and report it to the user.`, display: true }, { deliverAs: "followUp", triggerTurn: true })
    }
    const launchConsume = () => {
      const pending = consume()
      consumers.add(pending)
      void pending.finally(() => consumers.delete(pending))
    }
    timers.set(task.id, setInterval(launchConsume, pollMs))
    launchConsume()
  }

  pi.events.on(BACKGROUND_TASK_CREATED, (task) => {
    const created = task as BackgroundTask
    if (created.owner === owner && !taskCache.some((item) => item.id === created.id)) taskCache.push(created)
  })

  pi.on("session_start", async (_event, ctx) => {
    for (const task of await refreshTasks()) {
      if (task.storageMode !== "legacy" && task.kind === "monitor" && task.status === "running") monitor(task, ctx)
    }
  })

  pi.registerTool({
    name: "background_monitor",
    label: "Background monitor",
    description: "Run a slow, finite shell command asynchronously in an inspectable tmux task. On exit, wake the agent with status and bounded output.",
    promptSnippet: "Run slow, finite shell commands asynchronously in inspectable tmux tasks",
    promptGuidelines: ["Slow, finite commands requiring follow-up: use background_monitor.", "Short commands requiring immediate results: use bash."],
    parameters: Type.Object({ command: Type.String({ description: "Slow, finite shell command to run asynchronously until it exits" }), label: Type.Optional(Type.String({ description: "Short description shown on completion" })) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!(await tasks.available())) throw new Error("background_monitor requires tmux on PATH")
      const label = params.label?.trim() || params.command
      let task: BackgroundTask
      try { task = await tasks.create({ kind: "monitor", label, cwd: ctx.cwd, owner, command: "/bin/bash", args: ["-lc", params.command], remainOnExit: true }) }
      catch (error) { throw new Error(`background_monitor failed to start tmux task: ${error instanceof Error ? error.message : String(error)}`) }
      taskCache.push(task)
      monitor(task, ctx)
      const attach = process.env.TMUX ? `/task attach ${task.id}` : `tmux attach -t ${task.target}`
      return { content: [{ type: "text", text: `Started background monitor: ${label}\nTask: ${task.id}\nTmux target: ${task.target}\nAttach with: ${attach}` }], details: { id: task.id, label, target: task.target, statusFile: task.statusFile } }
    },
  })


  pi.registerCommand("task", { description: "List, attach, return, terminate, or clean background tasks", getArgumentCompletions: (prefix: string) => taskArgumentCompletions(taskCache, prefix), handler: async (args, ctx) => {
    const [action, ...rest] = args.trim().split(/\s+/); const reference = rest.join(" ")
    if (action === "list") {
      const all = await tasks.list(owner)
      taskCache = all
      ctx.ui.notify(all.length ? `Background tasks:\n${all.map((task) => `${task.id}  ${task.kind}  ${task.storageMode === "legacy" ? "cleanup-only" : task.status}  ${task.label}\n  ${task.target} · ${task.storageMode ?? "hub"}`).join("\n")}` : "No background tasks found.", "info")
      return
    }
    if (action === "return") { const parent = process.env.PI_BACKGROUND_TASK_PARENT; if (!process.env.TMUX || !parent) ctx.ui.notify("No parent tmux session is available.", "warning"); else await tasks.attach({ target: parent } as BackgroundTask); return }
    if (action === "clean" && !reference) { ctx.ui.notify(`Cleaned ${await tasks.cleanup(await tasks.list(owner))} background task(s).`, "info"); return }
    const resolved = await tasks.resolveReference(reference, owner)
    if (resolved.kind === "unknown") { ctx.ui.notify(`Unknown background task: ${reference || "(missing reference)"}`, "error"); return }
    if (resolved.kind === "ambiguous") { ctx.ui.notify(`Ambiguous background task label: ${reference}. Use its ID or tmux target.`, "error"); return }
    const task = resolved.task
    if (action === "clean") { ctx.ui.notify(`Cleaned ${await tasks.cleanup([task])} background task(s).`, "info"); return }
    if (task.storageMode === "legacy") { ctx.ui.notify(`Legacy cleanup-only task ${task.id} cannot be ${action === "attach" ? "attached" : "terminated"}. Use /task clean ${task.id}.`, "warning"); return }
    if (action === "attach") { const result = await tasks.attach(task); if (result !== "switched") ctx.ui.notify(`Run: ${result}`, "info"); return }
    if (action === "terminate") {
      if (task.status !== "running") { ctx.ui.notify(`Task ${task.id} is ${task.status}; only running tasks can be terminated.`, "warning"); return }
      await tasks.terminate(task); ctx.ui.notify(`Cancelled ${task.id}.`, "info"); return
    }
    ctx.ui.notify("Usage: /task list|attach|return|terminate|clean [task]", "warning")
  } })

  const confirmReplacement = async (_event: unknown, ctx: any) => {
    const running = await ownedRunning(); if (!running.length) return
    const ok = await ctx.ui.confirm("Running background tasks", `${running.length} monitored task(s) will be terminated if you replace this session. Continue?`)
    if (!ok) return { cancel: true }
  }
  pi.on("session_before_switch", confirmReplacement)
  pi.on("session_before_fork", confirmReplacement)
  pi.on("session_shutdown", async (event) => {
    if (shutdown) return shutdown
    shutdown = (async () => {
      shuttingDown = true
      for (const timer of timers.values()) clearInterval(timer)
      timers.clear()
      await Promise.allSettled([...consumers])
      if (event.reason !== "reload") {
        for (const task of await ownedRunning()) {
          await tasks.terminate(task, `Pi session shutdown (${event.reason})`)
        }
      }
      for (const activity of activities.values()) pi.events.emit(BACKGROUND_ACTIVITY_FINISHED, activity)
      activities.clear()
    })()
    return shutdown
  })
}
