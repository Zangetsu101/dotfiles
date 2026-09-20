import { readFile } from "node:fs/promises"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { BACKGROUND_ACTIVITY_FINISHED, BACKGROUND_ACTIVITY_STARTED, type BackgroundActivity } from "./lib/background-activity.ts"
import { BACKGROUND_TASK_CREATED, BACKGROUND_TASK_STATUS_CHANGED, BackgroundTasks, safeTaskLabel, type BackgroundTask } from "./lib/background-task.ts"
import { FAMILY_ENTRY, familyForContext, type TaskFamily } from "./lib/background-family.ts"

const MAX_OUTPUT_CHARS = 50_000
const POLL_MS = 100
const TASK_ENTRY = "background-task-record"

function persistedTask(data: unknown): BackgroundTask | undefined {
  if (!data || typeof data !== "object") return undefined
  const task = data as Partial<BackgroundTask>
  if (typeof task.id !== "string" || typeof task.familyId !== "string" || typeof task.status !== "string") return undefined
  if (task.kind !== "agent" && task.kind !== "monitor") return undefined
  return task as BackgroundTask
}

export function formatTaskTree(tasks: BackgroundTask[], rootId: string): string {
  const lines: string[] = []
  const visit = (children: BackgroundTask[], depth: number) => {
    for (const task of children) {
      lines.push(`${"  ".repeat(depth)}${task.displayName ?? task.label}  ${task.kind}  ${task.status}  ${task.id}`)
      visit(tasks.filter((candidate) => candidate.parentId === task.id), depth + 1)
    }
  }
  const roots = tasks.filter((task) => task.parentId === rootId)
  visit(roots.length ? roots : tasks.filter((task) => !tasks.some((candidate) => candidate.id === task.parentId)), 0)
  return lines.join("\n")
}

export function taskArgumentCompletions(tasks: BackgroundTask[], prefix: string) {
  const actions = ["list", "attach", "parent", "return", "terminate", "clean"]
  const normalized = prefix.trimStart()
  if (!normalized) return actions.map((value) => ({ value, label: value }))
  const words = normalized.split(/\s+/)
  if (words.length <= 1 && !prefix.endsWith(" ")) {
    return actions.filter((action) => action.startsWith(words[0] ?? "")).map((value) => ({ value, label: value }))
  }
  const action = words[0]
  if (action === "list" || action === "parent" || action === "return") return null
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
  subtreeRootId?: string
}

export default function (pi: ExtensionAPI, options: BackgroundMonitorOptions = {}) {
  const tasks = options.tasks ?? new BackgroundTasks()
  const pollMs = options.pollMs ?? POLL_MS
  const configuredSubtreeRootId = options.subtreeRootId
  const timers = new Map<string, NodeJS.Timeout>()
  const consumers = new Set<Promise<void>>()
  const activities = new Map<string, BackgroundActivity>()
  let shuttingDown = false
  let shutdown: Promise<void> | undefined
  let taskCache: BackgroundTask[] = []
  let family: TaskFamily | undefined

  const currentTask = (): BackgroundTask => ({
    id: family!.nodeId, familyId: family!.familyId, rootId: family!.rootId, kind: "agent", label: family!.nodeLabel,
    status: "running", target: process.env.TMUX_PANE ?? family!.rootPane, parent: process.env.PI_BACKGROUND_TASK_PARENT_ID ?? family!.rootId,
    parentId: process.env.PI_BACKGROUND_TASK_PARENT_ID, parentTarget: process.env.PI_BACKGROUND_TASK_PARENT, rootPane: family!.rootPane,
    cwd: "", statusFile: "", storageMode: "family",
  })
  const scope = () => configuredSubtreeRootId ?? family?.nodeId ?? process.env.TMUX_PANE ?? ""
  const refreshTasks = async () => (taskCache = await tasks.list({ subtreeRootId: scope() }))
  const ownedRunning = async () => (await tasks.list({ subtreeRootId: scope() })).filter((task) => task.status === "running" && (!family || configuredSubtreeRootId || task.parentId === family.nodeId))
  const restoreFamily = async (reason: string, ctx: ExtensionContext) => {
    family = familyForContext(reason, ctx, pi.getSessionName?.())
    const restored = new Map<string, BackgroundTask>()
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== TASK_ENTRY) continue
      const task = persistedTask(entry.data)
      if (task?.familyId === family.familyId) restored.set(task.id, task)
    }
    for (const task of restored.values()) tasks.remember?.(task)

    if (family.isRoot) {
      pi.appendEntry?.(FAMILY_ENTRY, { familyId: family.familyId, rootId: family.rootId })
      const exists = await tasks.familyExists?.(family.familyId)
      if (exists) await tasks.reconcileFamily?.(family)
      else for (const task of restored.values()) {
        if (task.status !== "running") continue
        task.status = "interrupted"
        tasks.remember?.(task)
        pi.appendEntry?.(TASK_ENTRY, task)
      }
    }
    await refreshTasks()
  }

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
      await tasks.setStatus(task, completion.status === "completed" ? "succeeded" : completion.status === "cancelled" ? "terminated" : "failed")
      pi.events.emit(BACKGROUND_TASK_STATUS_CHANGED, task)
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
    if (created.familyId === family?.familyId) pi.appendEntry?.(TASK_ENTRY, created)
    if ((configuredSubtreeRootId ? created.parentId === configuredSubtreeRootId : created.familyId === family?.familyId && created.parentId === family?.nodeId) && !taskCache.some((item) => item.id === created.id)) taskCache.push(created)
  })

  pi.events.on(BACKGROUND_TASK_STATUS_CHANGED, (task) => {
    const changed = task as BackgroundTask
    const cached = taskCache.find((item) => item.id === changed.id)
    if (cached) cached.status = changed.status
    if (changed.familyId === family?.familyId) pi.appendEntry?.(TASK_ENTRY, changed)
  })

  pi.on("session_start", async (event, ctx) => {
    await restoreFamily(event.reason, ctx)
    for (const task of taskCache) {
      if (task.kind === "monitor" && task.status === "running" && (configuredSubtreeRootId || task.parentId === family!.nodeId)) monitor(task, ctx)
    }
  })

  pi.on("session_tree", async (_event, ctx) => {
    for (const timer of timers.values()) clearInterval(timer)
    timers.clear()
    for (const activity of activities.values()) pi.events.emit(BACKGROUND_ACTIVITY_FINISHED, activity)
    activities.clear()
    await restoreFamily("tree", ctx)
    for (const task of taskCache) {
      if (task.kind === "monitor" && task.status === "running" && (configuredSubtreeRootId || task.parentId === family!.nodeId)) monitor(task, ctx)
    }
  })
  pi.on("session_info_changed", async (event) => {
    if (!family || !event.name) return
    family.nodeLabel = event.name
    if (family.isRoot) {
      family.familyName = event.name
      await tasks.renameFamily(family.familyId, event.name)
    } else {
      await tasks.renameNode(family.nodeId, event.name)
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
      if (!family) await restoreFamily("startup", ctx)
      try { task = await tasks.create({ kind: "monitor", label, cwd: ctx.cwd, parent: family!.nodeId, parentId: family!.nodeId, parentLabel: family!.nodeLabel, parentTarget: process.env.TMUX_PANE ?? family!.rootPane, familyId: family!.familyId, familyName: family!.familyName, rootId: family!.rootId, rootPane: family!.rootPane, command: "/bin/bash", args: ["-lc", params.command], remainOnExit: true }) }
      catch (error) { throw new Error(`background_monitor failed to start tmux task: ${error instanceof Error ? error.message : String(error)}`) }
      taskCache.push(task)
      pi.events.emit(BACKGROUND_TASK_CREATED, task)
      monitor(task, ctx)
      const attach = process.env.TMUX ? `/task attach ${task.id}` : `tmux attach -t ${task.target}`
      return { content: [{ type: "text", text: `Started background monitor: ${label}\nTask: ${task.id}\nTmux target: ${task.target}\nAttach with: ${attach}` }], details: { id: task.id, label, target: task.target, statusFile: task.statusFile } }
    },
  })


  pi.registerCommand("task", { description: "List, attach, navigate, terminate, or clean background tasks", getArgumentCompletions: (prefix: string) => taskArgumentCompletions(taskCache, prefix), handler: async (args, ctx) => {
    const [action, ...rest] = args.trim().split(/\s+/); const reference = rest.join(" ")
    if (action === "list") {
      const all = await tasks.list({ subtreeRootId: scope() })
      taskCache = all
      ctx.ui.notify(all.length ? `Background tasks:\n${formatTaskTree(all, family?.nodeId ?? scope())}` : "No background tasks found.", "info")
      return
    }
    if (action === "parent" || action === "return") {
      if (!family) { ctx.ui.notify("No task family is available.", "warning"); return }
      const result = action === "parent" ? await tasks.navigateParent(currentTask()) : await tasks.navigateReturn(currentTask())
      if (!result) ctx.ui.notify(action === "parent" ? "No parent task is available." : "No Root Pi pane is available.", "warning")
      else if (result !== "switched") ctx.ui.notify(`Run: ${result}`, "info")
      return
    }
    if (action === "clean" && !reference) { ctx.ui.notify(`Cleaned ${await tasks.cleanup(await tasks.list({ subtreeRootId: scope() }))} background task(s).`, "info"); return }
    const resolved = await tasks.resolveReference(reference, { subtreeRootId: scope() })
    if (resolved.kind === "unknown") { ctx.ui.notify(`Unknown background task: ${reference || "(missing reference)"}`, "error"); return }
    if (resolved.kind === "ambiguous") { ctx.ui.notify(`Ambiguous background task label: ${reference}. Use its ID or tmux target.`, "error"); return }
    const task = resolved.task
    if (action === "clean") { ctx.ui.notify(`Cleaned ${await tasks.cleanup([task])} background task(s).`, "info"); return }
    if (action === "attach") { const result = await tasks.attach(task); if (result !== "switched") ctx.ui.notify(`Run: ${result}`, "info"); return }
    if (action === "terminate") {
      const terminable = task.status === "running" || (task.kind === "agent" && task.status !== "terminated" && task.status !== "interrupted")
      if (!terminable) { ctx.ui.notify(`Task ${task.id} is already ${task.status}.`, "warning"); return }
      await tasks.terminate(task); ctx.ui.notify(`Terminated ${task.id}.`, "info"); return
    }
    ctx.ui.notify("Usage: /task list|attach|parent|return|terminate|clean [task]", "warning")
  } })

  pi.on("session_shutdown", async (event, ctx) => {
    if (shutdown) return shutdown
    shutdown = (async () => {
      shuttingDown = true
      for (const timer of timers.values()) clearInterval(timer)
      timers.clear()
      await Promise.allSettled([...consumers])
      if (event.reason === "quit" && family?.isRoot) {
        const running = await ownedRunning()
        const terminate = running.length && ctx.hasUI
          ? await ctx.ui.confirm("Running background tasks", `Terminate ${running.length} running task(s)? Choose Cancel to keep them running.`)
          : false
        if (terminate) for (const task of running) await tasks.terminate(task, "Root Pi quit")
      }
      for (const activity of activities.values()) pi.events.emit(BACKGROUND_ACTIVITY_FINISHED, activity)
      activities.clear()
    })()
    return shutdown
  })
}
