import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { BACKGROUND_ACTIVITY_FINISHED, BACKGROUND_ACTIVITY_STARTED, type BackgroundActivity } from "./lib/background-activity.ts"
import { BACKGROUND_TASK_CREATED, BACKGROUND_TASK_REMOVED, BACKGROUND_TASK_STATUS_CHANGED, BackgroundTasks, safeTaskLabel, type BackgroundTask } from "./lib/background-task.ts"
import { FAMILY_ENTRY, familyForContext, familyTaskParent, type TaskFamily } from "./lib/background-family.ts"
import { taskCheckIns } from "./lib/task-check-in.ts"
import { notifyRunningTask, readOutputTail } from "./lib/background-task-check-in.ts"
import { backgroundAttachCommand } from "./lib/background-attach.ts"
import { backgroundToolRenderers, registerBackgroundMessages } from "./lib/background-rendering.ts"

const MAX_OUTPUT_CHARS = 50_000
const POLL_MS = 100
const TASK_ENTRY = "background-task-record"
const TASK_REMOVED_ENTRY = "background-task-removed"

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

export function taskArgumentCompletions(tasks: BackgroundTask[], prefix: string, currentTaskId?: string) {
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
    (action !== "attach" || task.id !== currentTaskId) &&
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
  checkIns?: typeof taskCheckIns
  now?: () => number
  millisecondsPerMinute?: number
}

export default function (pi: ExtensionAPI, options: BackgroundMonitorOptions = {}) {
  registerBackgroundMessages(pi, "monitor")
  const tasks = options.tasks ?? new BackgroundTasks()
  const pollMs = options.pollMs ?? POLL_MS
  const checkIns = options.checkIns ?? taskCheckIns
  const now = options.now ?? Date.now
  const millisecondsPerMinute = options.millisecondsPerMinute ?? 60_000
  const configuredSubtreeRootId = options.subtreeRootId
  const timers = new Map<string, NodeJS.Timeout>()
  const consumers = new Set<Promise<void>>()
  const removedTasks = new Set<string>()
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
  const restoreFamily = async (reason: string, ctx: ExtensionContext) => {
    family = familyForContext(reason, ctx, pi.getSessionName?.())
    const restored = new Map<string, BackgroundTask>()
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue
      if (entry.customType === TASK_ENTRY) {
        const task = persistedTask(entry.data)
        if (task?.familyId === family.familyId) restored.set(task.id, task)
      } else if (entry.customType === TASK_REMOVED_ENTRY && entry.data && typeof entry.data === "object") {
        const removed = entry.data as { id?: unknown; familyId?: unknown }
        if (removed.familyId === family.familyId && typeof removed.id === "string") restored.delete(removed.id)
      }
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

  const stopMonitoring = (id: string, finishActivity = true) => {
    const task = taskCache.find((item) => item.id === id)
    if (task) checkIns.stop(task.statusFile)
    const timer = timers.get(id)
    if (timer) clearInterval(timer)
    timers.delete(id)
    const activity = activities.get(id)
    if (activity && finishActivity) pi.events.emit(BACKGROUND_ACTIVITY_FINISHED, activity)
    activities.delete(id)
  }

  const monitor = (task: BackgroundTask, ctx: ExtensionContext) => {
    if (timers.has(task.id)) return
    void checkIns.watch(task.statusFile, () => notifyRunningTask(pi, tasks, task, () => !shuttingDown && !removedTasks.has(task.id)))
    const activity = { id: `background-monitor:${task.id}`, source: "background_monitor", label: task.label }
    activities.set(task.id, activity)
    pi.events.emit(BACKGROUND_ACTIVITY_STARTED, activity)
    const consume = async () => {
      if (shuttingDown || removedTasks.has(task.id)) return
      const completion = await tasks.claimCompletionOrReconcile(task)
      if (removedTasks.has(task.id) || !completion || !("status" in completion)) return
      stopMonitoring(task.id, false)
      await tasks.setStatus(task, completion.status === "completed" ? "succeeded" : completion.status === "cancelled" ? "terminated" : "failed")
      if (removedTasks.has(task.id)) return
      pi.events.emit(BACKGROUND_TASK_STATUS_CHANGED, task)
      pi.events.emit(BACKGROUND_ACTIVITY_FINISHED, activity)
      const output = await readOutputTail(task.outputFile, MAX_OUTPUT_CHARS)
      const failed = completion.status !== "completed"
      const status = completion.status === "cancelled"
        ? `was cancelled${completion.reason ? `: ${completion.reason}` : ""}`
        : completion.status === "failed"
          ? `failed with exit code ${completion.exitCode ?? "unknown"}`
          : `finished with exit code ${completion.exitCode ?? 0}`
      const summary = `Background monitor ${task.id} (${task.label}) ${status}.`
      const attach = backgroundAttachCommand(task)
      if (removedTasks.has(task.id)) return
      if (ctx.hasUI) ctx.ui.notify(summary, failed ? "error" : "info")
      pi.sendMessage({ customType: "background-monitor", details: { summary, label: task.label, status: completion.status === "cancelled" ? "terminated" : completion.status, id: task.id, target: task.target, output: output.trim() || "(no output)", attach, exitCode: completion.exitCode }, content: `${summary}\nAttach with: ${attach}\n\nOutput:\n${output.trim() || "(no output)"}\n\nReview the result. When all background work has returned, provide the complete standalone result in your final turn, including any conclusions that remain unchanged.`, display: true }, { deliverAs: "followUp", triggerTurn: true })
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
    for (const task of taskCache) if (task.kind === "monitor") checkIns.stop(task.statusFile)
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
    ...backgroundToolRenderers("background_monitor"),
    label: "Background monitor",
    description: "Run a slow, finite shell command asynchronously in an inspectable tmux task. Wake the parent at the expected duration if still running, and on exit with status and bounded output.",
    promptSnippet: "Run slow, finite shell commands asynchronously in inspectable tmux tasks",
    promptGuidelines: ["Monitor slow, finite commands requiring follow-up with background_monitor.", "After a check-in, use background_task to inspect the task and schedule another check-in if needed.", "Keep monitor output visible in its tmux pane; the tool already captures pane output. If you also need a separate log, use set -o pipefail; command 2>&1 | tee /path/to/log.", "Run short commands requiring immediate results with bash."],
    parameters: Type.Object({ command: Type.String({ description: "Slow, finite shell command to run asynchronously until it exits" }), label: Type.Optional(Type.String({ description: "Short description shown on completion" })), expectedRunningMinutes: Type.Number({ minimum: 1, description: "Minutes until the parent agent receives a check-in if the command is still running" }) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!(await tasks.available())) throw new Error("background_monitor requires tmux on PATH")
      const label = params.label?.trim() || params.command
      let task: BackgroundTask
      if (!family) await restoreFamily("startup", ctx)
      try { task = await tasks.create({ kind: "monitor", label, cwd: ctx.cwd, ...familyTaskParent(family!, process.env.TMUX_PANE ?? family!.rootPane), command: "/bin/bash", args: ["-lc", params.command], remainOnExit: true }) }
      catch (error) { throw new Error(`background_monitor failed to start tmux task: ${error instanceof Error ? error.message : String(error)}`) }
      taskCache.push(task)
      pi.events.emit(BACKGROUND_TASK_CREATED, task)
      await checkIns.schedule(task.statusFile, now() + params.expectedRunningMinutes * millisecondsPerMinute)
      monitor(task, ctx)
      const attach = backgroundAttachCommand(task)
      return { content: [{ type: "text", text: `Started background monitor: ${label}\nTask: ${task.id}\nExpected running time: ${params.expectedRunningMinutes} minutes\nTmux target: ${task.target}\nAttach with: ${attach}` }], details: { id: task.id, label, target: task.target, attach, statusFile: task.statusFile } }
    },
  })

  pi.registerTool({
    name: "background_task",
    ...backgroundToolRenderers("background_task"),
    label: "Background task",
    description: "List, inspect, schedule another check-in for, or terminate a task in your subtree.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("inspect"), Type.Literal("check-in"), Type.Literal("terminate")]),
      id: Type.Optional(Type.String()),
      afterMinutes: Type.Optional(Type.Number({ minimum: 1 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!family) await restoreFamily("startup", ctx)
      const visible = await tasks.list({ subtreeRootId: scope() })
      if (params.action === "list") {
        const lines = visible.map((task) => `${task.id}  ${task.kind}  ${task.status}  ${task.label}`)
        return { content: [{ type: "text" as const, text: lines.join("\n") || "No background tasks in this subtree." }], details: { status: "listed" } }
      }
      if (!params.id) return { content: [{ type: "text" as const, text: "Task ID is required." }], details: { status: "error" } }
      const task = visible.find((candidate) => candidate.id === params.id)
      if (!task) {
        const elsewhere = (await tasks.list({ familyId: family!.familyId })).some((candidate) => candidate.id === params.id)
        return { content: [{ type: "text" as const, text: elsewhere ? "Task is outside your subtree." : "Task not found. Use background_task with action list to see available tasks." }], details: { status: elsewhere ? "out_of_scope" : "not_found" } }
      }
      const metadata = { id: task.id, label: task.label, target: task.target, attach: backgroundAttachCommand(task) }
      if (params.action === "inspect") {
        const output = await readOutputTail(task.outputFile)
        const completion = await tasks.completion(task)
        const status = completion ? "status" in completion ? completion.status : completion.kind === "exit" ? "failed" : "succeeded" : task.status
        const attach = backgroundAttachCommand(task)
        return { content: [{ type: "text" as const, text: `${task.kind} ${task.id} (${task.label}): ${status}\nRecent output:\n${output.trim() || "(no output)"}` }], details: { status, id: task.id, label: task.label, target: task.target, attach, output: output.trim() || "(no output)" } }
      }
      if (task.status !== "running" || await tasks.completion(task)) return { content: [{ type: "text" as const, text: `Task ${task.id} is no longer running.` }], details: { ...metadata, status: "not_running" } }
      if (params.action === "terminate") {
        await terminateTask(task, "Terminated by parent agent")
        return { content: [{ type: "text" as const, text: `Terminated task ${task.id}.` }], details: { ...metadata, status: "terminated" } }
      }
      if (task.parentId !== family!.nodeId) return { content: [{ type: "text" as const, text: "Only the agent that spawned this task can schedule its check-ins." }], details: { ...metadata, status: "out_of_scope" } }
      if (!params.afterMinutes) return { content: [{ type: "text" as const, text: "afterMinutes is required to schedule a check-in." }], details: { ...metadata, status: "error" } }
      await checkIns.schedule(task.statusFile, now() + params.afterMinutes * millisecondsPerMinute)
      return { content: [{ type: "text" as const, text: `Scheduled a check-in for ${task.id} in ${params.afterMinutes} minutes.` }], details: { ...metadata, status: "scheduled" } }
    },
  })

  const terminateTask = async (selected: BackgroundTask, reason?: string): Promise<void> => {
    for (const task of await tasks.terminate(selected, reason)) pi.events.emit(BACKGROUND_TASK_STATUS_CHANGED, task)
  }

  const cleanTasks = async (selected: BackgroundTask[]): Promise<number> => {
    const all = await tasks.list({ subtreeRootId: scope() })
    const candidates = selected.flatMap((task) => tasks.subtree(task, all))
    const removed = await tasks.cleanup(selected)
    if (!removed) return 0
    const remaining = new Set((await tasks.list({ subtreeRootId: scope() })).map((task) => task.id))
    for (const task of candidates) {
      if (!remaining.has(task.id)) {
        removedTasks.add(task.id)
        pi.appendEntry?.(TASK_REMOVED_ENTRY, { id: task.id, familyId: task.familyId })
        stopMonitoring(task.id)
        pi.events.emit(BACKGROUND_TASK_REMOVED, task)
      }
    }
    taskCache = taskCache.filter((task) => remaining.has(task.id))
    return removed
  }

  pi.registerCommand("task", { description: "List, attach, navigate, terminate, or clean background tasks", getArgumentCompletions: (prefix: string) => taskArgumentCompletions(taskCache, prefix, family?.nodeId), handler: async (args, ctx) => {
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
    if (action === "clean" && !reference) { ctx.ui.notify(`Cleaned ${await cleanTasks(await tasks.list({ subtreeRootId: scope() }))} background task(s).`, "info"); return }
    const resolved = await tasks.resolveReference(reference, { subtreeRootId: scope() })
    if (resolved.kind === "unknown") { ctx.ui.notify(`Unknown background task: ${reference || "(missing reference)"}`, "error"); return }
    if (resolved.kind === "ambiguous") { ctx.ui.notify(`Ambiguous background task label: ${reference}. Use its ID or tmux target.`, "error"); return }
    const task = resolved.task
    if (action === "clean") { ctx.ui.notify(`Cleaned ${await cleanTasks([task])} background task(s).`, "info"); return }
    if (action === "attach") { if (task.id === family?.nodeId) { ctx.ui.notify("Already attached to this task.", "info"); return } const result = await tasks.attach(task); if (result !== "switched") ctx.ui.notify(`Run: ${result}`, "info"); return }
    if (action === "terminate") {
      const terminable = task.status === "running" || (task.kind === "agent" && task.status !== "terminated" && task.status !== "interrupted")
      if (!terminable) { ctx.ui.notify(`Task ${task.id} is already ${task.status}.`, "warning"); return }
      await terminateTask(task); ctx.ui.notify(`Terminated ${task.id}.`, "info"); return
    }
    ctx.ui.notify("Usage: /task list|attach|parent|return|terminate|clean [task]", "warning")
  } })

  pi.on("session_shutdown", async (event, ctx) => {
    if (shutdown) return shutdown
    shutdown = (async () => {
      shuttingDown = true
      for (const task of taskCache) if (task.kind === "monitor") checkIns.stop(task.statusFile)
      for (const timer of timers.values()) clearInterval(timer)
      timers.clear()
      await Promise.allSettled([...consumers])
      if (event.reason === "quit" && family?.isRoot) {
        const all = await tasks.list({ subtreeRootId: scope() })
        const running = all.filter((task) => task.status === "running")
        const terminate = running.length && ctx.hasUI
          ? await ctx.ui.confirm("Running background tasks", `Terminate ${running.length} running task(s)? Choose Cancel to keep them running.`)
          : false
        if (terminate) {
          const byId = new Map(all.map((task) => [task.id, task]))
          const runningIds = new Set(running.map((task) => task.id))
          const roots = running.filter((candidate) => {
            let ancestor = candidate.parentId ? byId.get(candidate.parentId) : undefined
            while (ancestor) {
              if (runningIds.has(ancestor.id)) return false
              ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined
            }
            return true
          })
          for (const task of roots) await terminateTask(task, "Root Pi quit")
        }
      }
      for (const activity of activities.values()) pi.events.emit(BACKGROUND_ACTIVITY_FINISHED, activity)
      activities.clear()
    })()
    return shutdown
  })
}
