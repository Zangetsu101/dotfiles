import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { basename, dirname, join } from "node:path"
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { existsSync, watch, type FSWatcher } from "node:fs"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import {
  BACKGROUND_ACTIVITY_FINISHED,
  BACKGROUND_ACTIVITY_STARTED,
  type BackgroundActivity,
} from "./lib/background-activity.ts"
import {
  BACKGROUND_TASK_CREATED,
  BACKGROUND_TASK_REMOVED,
  BACKGROUND_TASK_STATUS_CHANGED,
  BackgroundTasks,
  systemTmux,
  writeTaskCompletion,
  taskCompletionStatus,
  type BackgroundTask,
  type TaskStatus,
  type TmuxProcessAdapter,
} from "./lib/background-task.ts"
import { familyForContext, familyTaskParent, type TaskFamily } from "./lib/background-family.ts"
import { taskCheckIns } from "./lib/task-check-in.ts"
import { backgroundLifecycleGuidelines, backgroundCompletionGuidance } from "./lib/background-prompts.ts"
import { notifyRunningTask } from "./lib/background-task-check-in.ts"
import { backgroundAttachCommand } from "./lib/background-attach.ts"
import { backgroundToolRenderers, registerBackgroundMessages } from "./lib/background-rendering.ts"

import { reportAgentProgress, readAgentProgress, describeAgentProgress, type AgentReport } from "./lib/background-progress.ts"
import { canMessageBackgroundAgent, setBackgroundToolActive } from "./lib/background-tool-availability.ts"

const execFileAsync = promisify(execFile)
const STATUS_FILE_ENV = "PI_BACKGROUND_AGENT_STATUS_FILE"
const DEPTH_ENV = "PI_BACKGROUND_AGENT_DEPTH"
const MAX_DEPTH_ENV = "PI_BACKGROUND_AGENT_MAX_DEPTH"
const ALLOW_DELEGATION_ENV = "PI_BACKGROUND_AGENT_ALLOW_DELEGATION"
const AGENT_LABEL_ENV = "PI_BACKGROUND_AGENT_LABEL"
const DEFAULT_MAX_AGENT_DEPTH = 3
const MAX_RESULT_CHARS = 50_000
const POLL_MS = 100
const SETTLED_POLL_MS = 2_000
const STALE_REPORT_MS = 5 * 60_000

type AgentSession = {
  id: string
  target: string
  label: string
  status: TaskStatus
  model: string
  thinking: string
  expectedCompletionAt: number
  parent: string
  parentId?: string
  parentTarget?: string
  familyId?: string
  rootId?: string
  rootPane?: string
  statusFile: string
  outputFile?: string
  kind: "agent"
  cwd: string
}

function truncateTail(text: string): string {
  return text.length <= MAX_RESULT_CHARS ? text : text.slice(-MAX_RESULT_CHARS)
}

function finalAssistantOutput(ctx: ExtensionContext): {
  output: string
  stopReason?: string
} {
  const entries = ctx.sessionManager.getBranch() as Array<{
    type?: string
    message?: {
      role?: string
      stopReason?: string
      content?: Array<{ type?: string; text?: string }>
    }
  }>

  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index].message
    if (entries[index].type !== "message" || message?.role !== "assistant") continue

    const output = (message.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")

    return { output: truncateTail(output), stopReason: message.stopReason }
  }

  return { output: "" }
}

const directTmux: TmuxProcessAdapter = {
  async run(args) {
    const result = await execFileAsync("tmux", args, { encoding: "utf8" })
    return result.stdout.trim()
  },
}

type BackgroundAgentOptions = {
  tasks?: BackgroundTasks
  tmux?: TmuxProcessAdapter
  millisecondsPerMinute?: number
  checkIns?: ReturnType<typeof taskCheckIns>
  now?: () => number
  pollMs?: number
  settledPollMs?: number
}

function piInvocation(): { command: string; args: string[] } {
  const currentScript = process.argv[1]
  if (currentScript && !currentScript.startsWith("/$bunfs/root/")) {
    return { command: process.execPath, args: [currentScript] }
  }
  return { command: "pi", args: [] }
}

async function currentTmuxSession(tmux: TmuxProcessAdapter): Promise<string | undefined> {
  if (!process.env.TMUX) return undefined
  try {
    return await tmux.run(["display-message", "-p", "#{session_name}"])
  } catch {
    return undefined
  }
}

function currentTmuxPane(): string {
  return process.env.TMUX_PANE ?? ""
}

async function listAgents(tasks: BackgroundTasks, tmux: TmuxProcessAdapter, subtreeRootId: string): Promise<AgentSession[]> {
  const generic = (await tasks.list({ subtreeRootId })).filter((task) => task.kind === "agent")
  let output = ""
  try { output = await tmux.run(["list-windows", "-a", "-F", "#{session_name}:#{window_name}\t#{@pi_agent_status}\t#{@pi_agent_model}\t#{@pi_agent_thinking}\t#{@pi_agent_expected_completion_at}"]) } catch {}
  const details = new Map(output.split("\n").filter(Boolean).map((line) => { const [target, status, model, thinking, expectedCompletionAt] = line.split("\t"); return [target, { status, model, thinking, expectedCompletionAt }] }))
  return generic.map((task) => {
    const detail = details.get(task.target)
    return { ...task, kind: "agent" as const, status: task.status, model: detail?.model || "", thinking: detail?.thinking || "", expectedCompletionAt: Number(detail?.expectedCompletionAt) || 0 }
  })
}

async function withMailboxLock<T>(statusFile: string, operation: () => Promise<T>): Promise<T> {
  const lock = `${statusFile}.message-lock`
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 100) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  try { return await operation() } finally { await rm(lock, { recursive: true, force: true }) }
}

async function registerChildBridge(pi: ExtensionAPI, statusFile: string, tmux: TmuxProcessAdapter, pollMs: number, now: () => number): Promise<void> {
  const pane = process.env.TMUX_PANE
  const setWindowOption = async (key: string, value: string) => {
    if (pane) await tmux.run(["set-option", "-w", "-t", pane, key, value]).catch(() => undefined)
  }
  let hasReport = false
  let latestReport: AgentReport | undefined
  let reminded = false
  pi.on("tool_call", (event) => {
    if (!hasReport && event.toolName !== "background_agent_report") {
      return { block: true, reason: "Call background_agent_report successfully before starting assignment work." }
    }
  })
  pi.registerTool({
    name: "background_agent_report",
    label: "Report assignment progress",
    description: "Report current activity, a blocker and needed help, or your assignment outcome. Routine reports do not interrupt the parent. Set attention for a blocker needing parent help. Completion is your report, not verification.",
    promptGuidelines: [
      "Call background_agent_report before starting assignment work with state working and a short description of your first activity. Call it again when your activity changes so the parent statusline stays current.",
      "For working or blocked reports, write activity as a short status phrase of at most 50 characters, such as 'Checking category interfaces' or 'Waiting for credentials'. Put blocker details and the requested action in help. The 50-character guidance does not apply to completed or failed reports.",
      "Chat updates alone do not update the parent statusline. Use state blocked with help and attention when you need the parent to intervene. Report completed or failed with the result and caveats when your assignment ends.",
    ],
    parameters: Type.Object({
      activity: Type.String({ minLength: 1, maxLength: 2000 }),
      state: Type.Optional(Type.Union([Type.Literal("working"), Type.Literal("blocked"), Type.Literal("completed"), Type.Literal("failed")], { description: "Assignment state. Defaults to working." })),
      help: Type.Optional(Type.String({ maxLength: 2000 })),
      attention: Type.Optional(Type.Boolean({ description: "Set true with state blocked and help to request parent intervention." })),
    }),
    async execute(_id, params) {
      if (!params.activity.trim()) throw new Error("Activity must not be empty")
      const progress = await withMailboxLock(statusFile, async () => {
        if (reported) throw new Error("Assignment already completed; wait for follow-up work")
        const progress = await reportAgentProgress(statusFile, { ...params, activity: params.activity.trim(), state: params.state ?? "working", at: now() })
        if (progress.latest.state === "completed" || progress.latest.state === "failed") {
          await writeTaskCompletion(statusFile, { kind: "reported", outcome: progress.latest.state, assignment: progress.assignment, output: progress.latest.activity })
          reported = true
        }
        return progress
      })
      hasReport = true
      latestReport = progress.latest
      reminded = false
      return { content: [{ type: "text", text: "Progress recorded" }], details: { progress } }
    },
  })
  const mailbox = `${statusFile}.messages`
  const operationFile = `${statusFile}.operation`
  type Operation = { id: string; ctx: ExtensionContext; signal: AbortSignal | undefined }
  let operation: Operation | undefined
  let finishingOperation: Operation | undefined
  let interrupted: { resolve: () => void } | undefined
  let processing = false
  let busy = false
  let closed = false
  let timer: NodeJS.Timeout | undefined
  const remindIfStale = () => {
    if (closed || !processing || reported || reminded || !latestReport) return
    if (latestReport.state === "blocked" && latestReport.help?.trim()) return
    if (now() - latestReport.at < STALE_REPORT_MS) return
    pi.sendMessage({
      customType: "background-agent-report-reminder",
      content: "Your last progress report is at least 5 minutes old. Call background_agent_report with your current activity or blocker.",
      display: true,
    }, { deliverAs: "steer", triggerTurn: false })
    reminded = true
  }
  const receive = async () => {
    if (busy || closed) return
    busy = true
    try {
      for (const name of (await readdir(mailbox).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [] as string[]
        throw error
      })).filter((name) => name.endsWith(".request"))) {
        const id = name.slice(0, -8)
        const request = join(mailbox, name)
        const ack = join(mailbox, `${id}.ack`)
        let accepted = false
        let interruption = "unconfirmed"
        let isForce = false
        try {
          const raw = await readFile(request, "utf8")
          const force = raw.startsWith("\u0000force:") ? JSON.parse(raw.slice(7)) as { message: string; operation: string | null } : undefined
          const message = force?.message ?? raw
          isForce = Boolean(force)
          interruption = "not_needed"
          if (force?.operation && operation?.id === force.operation) {
            const targeted = operation
            if (targeted.signal && targeted.ctx.signal === targeted.signal && !targeted.signal.aborted) {
              try {
                const settled = new Promise<void>((resolve) => { interrupted = { resolve } })
                targeted.ctx.abort()
                interruption = "requested"
                await writeFile(join(mailbox, `${id}.interrupt`), interruption, { mode: 0o600 }).catch(() => undefined)
                await settled
                interruption = targeted.signal.aborted ? "confirmed" : "unconfirmed"
              } catch {
                interrupted = undefined
                interruption = "failed"
              }
            } else if (targeted.signal?.aborted) {
              interruption = "unconfirmed"
              await new Promise<void>((resolve) => { interrupted = { resolve } })
            } else {
              interruption = "failed"
            }
          }
          if (force && finishingOperation?.signal?.aborted && (!force.operation || finishingOperation.id === force.operation)) {
            interruption = "unconfirmed"
            await new Promise<void>((resolve) => { interrupted = { resolve } })
          }
          if (closed) return
          if (reported) await resetAssignment()
          pi.sendUserMessage(message, processing ? { deliverAs: "steer" } : undefined)
          accepted = true
          await writeFile(ack, force ? JSON.stringify({ status: "delivered", interruption }) : "delivered", { flag: "wx", mode: 0o600 })
        } catch (error) {
          const response = isForce ? JSON.stringify({ status: "error", interruption, error: String(error) }) : `error: ${String(error)}`
          await writeFile(ack, response, { flag: "wx", mode: 0o600 }).catch(() => undefined)
        }
        if (accepted || (!isForce && await readFile(ack, "utf8").catch(() => undefined))) await rm(request, { force: true })
      }
    } finally { busy = false }
  }
  pi.on("session_start", async () => {
    await mkdir(mailbox, { recursive: true, mode: 0o700 })
    closed = false
    if (timer) clearInterval(timer)
    timer = setInterval(() => { remindIfStale(); void receive().catch((error) => console.error("background agent mailbox:", error)) }, pollMs)
    await receive()
  })
  pi.on("session_shutdown", async () => { closed = true; if (timer) clearInterval(timer); await rm(operationFile, { force: true }); interrupted?.resolve() })
  pi.on("agent_start", async (_event, ctx) => {
    processing = true
    finishingOperation = undefined
    operation = { id: randomUUID(), ctx, signal: ctx.signal }
    const temporary = `${operationFile}.${operation.id}`
    await writeFile(temporary, operation.id, { mode: 0o600 })
    await rename(temporary, operationFile)
  })
  pi.on("agent_end", async () => {
    processing = false
    finishingOperation = operation
    operation = undefined
    await rm(operationFile, { force: true })
  })
  const activeBackgroundActivities = new Set<string>()
  let reported = existsSync(statusFile)
  const resetAssignment = () => withMailboxLock(statusFile, async () => {
    await Promise.all([
      rm(statusFile, { force: true }),
      rm(`${statusFile}.notified`, { force: true }),
      rm(`${statusFile}.progress`, { force: true }),
      rm(`${statusFile}.check-in`, { force: true }),
      setWindowOption("@pi_agent_status", "running"),
      setWindowOption("@pi_task_status", "running"),
    ])
    reported = false
    hasReport = false
    latestReport = undefined
    reminded = false
  })

  pi.events.on(BACKGROUND_ACTIVITY_STARTED, (data) => {
    const activity = data as BackgroundActivity
    if (activity?.id) activeBackgroundActivities.add(activity.id)
  })

  pi.events.on(BACKGROUND_ACTIVITY_FINISHED, (data) => {
    const activity = data as BackgroundActivity
    if (activity?.id) activeBackgroundActivities.delete(activity.id)
  })

  pi.on("agent_start", async () => {
    if (reported) await resetAssignment()
  })

  pi.on("agent_settled", async (_event, ctx) => {
    interrupted?.resolve()
    interrupted = undefined
    finishingOperation = undefined
    if (reported || activeBackgroundActivities.size > 0) return
    await receive()
    await withMailboxLock(statusFile, async () => {
      if ((await readdir(mailbox).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [] as string[]
        throw error
      })).some((name) => name.endsWith(".request"))) return
      reported = true
      const result = finalAssistantOutput(ctx)
      await writeTaskCompletion(statusFile, {
        kind: "settled",
        assignment: (await readAgentProgress(statusFile))?.assignment ?? randomUUID(),
        output: result.output,
        stopReason: result.stopReason,
      })
    })
  })

  pi.on("model_select", async (event) => {
    await setWindowOption("@pi_agent_model", `${event.model.provider}/${event.model.id}`)
  })

  pi.on("thinking_level_select", async (event) => {
    await setWindowOption("@pi_agent_thinking", event.level)
  })
}

export default async function (pi: ExtensionAPI, options: BackgroundAgentOptions = {}) {
  registerBackgroundMessages(pi, "agent")
  const tasks = options.tasks ?? new BackgroundTasks(options.tmux ?? systemTmux)
  const tmux = options.tmux ?? directTmux
  const millisecondsPerMinute = options.millisecondsPerMinute ?? 60_000
  const checkIns = options.checkIns ?? taskCheckIns(pi.events)
  const now = options.now ?? Date.now
  const pollMs = options.pollMs ?? POLL_MS
  const settledPollMs = options.settledPollMs ?? SETTLED_POLL_MS
  const childStatusFile = process.env[STATUS_FILE_ENV]
  const parsedDepth = Number.parseInt(process.env[DEPTH_ENV] ?? "", 10)
  const depth = childStatusFile ? (Number.isFinite(parsedDepth) ? parsedDepth : 1) : 0
  const configuredMaxDepth = Number.parseInt(process.env[MAX_DEPTH_ENV] ?? "", 10)
  const maxDepth = Number.isFinite(configuredMaxDepth) ? configuredMaxDepth : DEFAULT_MAX_AGENT_DEPTH
  if (childStatusFile) await registerChildBridge(pi, childStatusFile, tmux, pollMs, now)

  const watchers = new Map<string, FSWatcher>()
  const reconciliationTimers = new Map<string, NodeJS.Timeout>()
  let agentsCache: AgentSession[] = []
  let family: TaskFamily | undefined
  let shuttingDown = false

  const availabilityWatchers = new Map<string, FSWatcher>()
  const stopAvailabilityWatchers = () => {
    for (const watcher of availabilityWatchers.values()) watcher.close()
    availabilityWatchers.clear()
  }
  let stopMetadata: (() => void) | undefined
  let generation = 0
  let availabilityRevision = 0
  const updateAvailability = async (visible: BackgroundTask[], revision = ++availabilityRevision) => {
    if (shuttingDown || revision !== availabilityRevision) return
    const descendants = visible.filter((task) => task.kind === "agent" && task.id !== family?.nodeId)
    const ids = new Set(descendants.map((agent) => agent.id))
    for (const [id, watcher] of availabilityWatchers) {
      if (!ids.has(id)) { watcher.close(); availabilityWatchers.delete(id) }
    }
    for (const agent of descendants) {
      if (availabilityWatchers.has(agent.id)) continue
      try {
        const watcher = watch(dirname(agent.statusFile), (_event, filename) => {
          if (!filename || filename.toString() === basename(agent.statusFile)) refreshAvailability()
        })
        availabilityWatchers.set(agent.id, watcher)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    const messageable = await Promise.all(descendants.map((agent) => canMessageBackgroundAgent(tasks, agent)))
    if (shuttingDown || revision !== availabilityRevision) return
    setBackgroundToolActive(pi, "background_agent_message", messageable.some(Boolean))
  }
  const refreshAvailability = () => {
    if (!family || shuttingDown) return
    const current = generation
    const revision = ++availabilityRevision
    void tasks.list({ subtreeRootId: family.nodeId }).then((visible) => {
      if (current === generation && !shuttingDown) return updateAvailability(visible, revision)
    }).catch((error) => console.error("background agent availability:", error))
  }
  for (const event of [BACKGROUND_TASK_CREATED, BACKGROUND_TASK_REMOVED, BACKGROUND_TASK_STATUS_CHANGED]) pi.events.on(event, refreshAvailability)

  const restoreFamily = async (reason: string, ctx: ExtensionContext) => {
    const restoring = ++generation
    const revision = ++availabilityRevision
    stopAvailabilityWatchers()
    stopMetadata?.()
    stopMetadata = undefined
    family = familyForContext(reason, ctx, pi.getSessionName?.())
    const visible = await listAgents(tasks, tmux, family.nodeId)
    if (shuttingDown || restoring !== generation) return false
    agentsCache = visible.filter((agent) => agent.parentId === family!.nodeId)
    await updateAvailability(visible, revision)
    if (shuttingDown || restoring !== generation) return false
    let pendingAvailability = Promise.resolve()
    const stop = await tasks.watchMetadata({ subtreeRootId: family.nodeId }, (snapshot) => {
      if (restoring === generation && !shuttingDown) pendingAvailability = updateAvailability(snapshot).catch((error) => console.error("background agent availability:", error))
    })
    await pendingAvailability
    if (shuttingDown || restoring !== generation) { stop(); return false }
    stopMetadata = stop
    return true
  }

  const stopMonitoring = (id: string) => {
    const agent = agentsCache.find((item) => item.id === id)
    if (agent) checkIns.stop(agent.statusFile)
    watchers.get(id)?.close()
    watchers.delete(id)
    const timer = reconciliationTimers.get(id)
    if (timer) clearInterval(timer)
    reconciliationTimers.delete(id)
  }

  const stopAllMonitoring = () => {
    for (const id of watchers.keys()) stopMonitoring(id)
  }

  pi.events.on(BACKGROUND_TASK_REMOVED, (task) => {
    stopMonitoring((task as { id: string }).id)
  })

  const monitor = (agent: AgentSession) => {
    if (watchers.has(agent.id)) return

    const activity: BackgroundActivity = { id: `background-agent:${agent.id}`, source: "background_agent", label: agent.label }
    if (agent.status === "running") pi.events.emit(BACKGROUND_ACTIVITY_STARTED, activity)
    let settled = agent.status !== "running"
    let consuming = false
    let checkingSettled = false
    let runtimeExit = false
    let watcher: FSWatcher
    const reconcile = (operation: () => Promise<void>) => { void operation().catch((error) => console.error("background agent reconciliation:", error)) }
    const setPoll = (callback: () => void, interval: number) => {
      if (shuttingDown || watchers.get(agent.id) !== watcher) return
      const previous = reconciliationTimers.get(agent.id)
      if (previous) clearInterval(previous)
      reconciliationTimers.set(agent.id, setInterval(callback, interval))
    }
    const checkSettled = async () => {
      if (!settled || shuttingDown || checkingSettled) return
      checkingSettled = true
      try {
        if (await tasks.pendingAssignmentCompletionPath(agent)) {
          await consume(true)
          return
        }
        let completion = await tasks.completion(agent)
        if (completion && "kind" in completion && completion.kind !== "exit" && !await tasks.isPresent(agent)) {
          completion = { kind: "exit", reason: "agent session disappeared after reporting assignment completion" }
          await writeTaskCompletion(agent.statusFile, completion)
        }
        if (watchers.get(agent.id) !== watcher) return
        if (completion) {
          if ("kind" in completion && completion.kind === "exit" && !runtimeExit) {
            runtimeExit = true
            settled = false
            await consume()
            settled = true
          }
          return
        }
        settled = false
        agent.status = "running"
        await tasks.setStatus(agent, "running")
        await checkIns.watch(agent.statusFile, () => notifyRunningTask(pi, tasks, agent, () => !settled && !shuttingDown))
        pi.events.emit(BACKGROUND_ACTIVITY_STARTED, activity)
        setPoll(() => reconcile(consume), pollMs)
        reconcile(consume)
      } finally {
        checkingSettled = false
      }
    }
    void checkIns.watch(agent.statusFile, () => notifyRunningTask(pi, tasks, agent, () => !settled && !shuttingDown))
    const consumeCompletion = async () => {
      const completion = await tasks.claimCompletionOrReconcile(agent)
      if (watchers.get(agent.id) !== watcher) return
      const progress = completion ? undefined : await readAgentProgress(agent.statusFile).catch((error) => { console.error("background agent progress:", error); return undefined })
      if (progress?.latest.state === "blocked" && progress.latest.attention && !await tasks.completion(agent)) {
        await withMailboxLock(agent.statusFile, async () => {
          const marker = `${agent.statusFile}.attention`
          if (await readFile(marker, "utf8").catch(() => undefined) === progress.latest.id) return
          if (shuttingDown || watchers.get(agent.id) !== watcher || await tasks.completion(agent)) return
          await writeFile(marker, progress.latest.id, { mode: 0o600 })
          pi.sendMessage({
            customType: "background-agent-check-in",
            details: { id: agent.id, label: agent.label, target: agent.target, status: "blocked", progress, summary: describeAgentProgress(progress), attach: backgroundAttachCommand(agent) },
            content: `Background agent ${agent.id} (${agent.label}) requests attention.\nReported progress: ${describeAgentProgress(progress)}\nUse background_task to inspect it or background_agent_message to help.`,
            display: true,
          }, { deliverAs: "steer", triggerTurn: true })
        })
      }

      if (!completion) return

      const agentCompletion = "kind" in completion
      const currentCompletion = await tasks.completion(agent)
      settled = !agentCompletion || !completion.assignment || Boolean(currentCompletion && "kind" in currentCompletion && currentCompletion.assignment === completion.assignment)
      runtimeExit = agentCompletion && completion.kind === "exit"
      if (settled) {
        checkIns.stop(agent.statusFile)
        pi.events.emit(BACKGROUND_ACTIVITY_FINISHED, activity)
      }
      const taskStatus = taskCompletionStatus(completion)
      const failed = taskStatus === "failed"
      const terminated = taskStatus === "terminated"
      let status = "finished its initial task"
      if (terminated) status = `was terminated${completion.reason ? `: ${completion.reason}` : ""}`
      else if (agentCompletion && completion.kind === "reported") status = failed ? "reported it could not finish its assignment" : "reported its assignment completed"
      else if (failed) status = agentCompletion && completion.kind !== "exit" ? "failed with a model error" : agentCompletion && completion.reason ? `runtime failed: ${completion.reason}` : `failed with exit code ${completion.exitCode ?? "unknown"}`
      if (settled) await Promise.all([
        tmux.run(["set-option", "-w", "-t", agent.target, "@pi_agent_status", terminated ? "terminated" : failed ? "failed" : "settled"]),
        tmux.run(["set-option", "-w", "-t", agent.target, "@pi_task_status", taskStatus]),
      ]).catch(() => undefined)

      if (watchers.get(agent.id) !== watcher) return
      const summary = `Background agent ${agent.id} (${agent.label}) ${status}.`
      if (settled) {
        agent.status = taskStatus
        const cached = agentsCache.find((item) => item.id === agent.id)
        if (cached) cached.status = taskStatus
        pi.events.emit(BACKGROUND_TASK_STATUS_CHANGED, agent)
      }
      const attach = backgroundAttachCommand(agent)
      const output = "output" in completion ? completion.output?.trim() || "(no final output)" : "(no final output)"

      if (watchers.get(agent.id) !== watcher) return
      pi.sendMessage(
        {
          customType: "background-agent",
          details: { summary, label: agent.label, status: taskStatus === "succeeded" ? "completed" : taskStatus, id: agent.id, target: agent.target, output, attach, exitCode: completion.exitCode },
          content: `${summary}\nAttach with: ${attach}\n\nFinal output:\n${output}\n\n${backgroundCompletionGuidance}`,
          display: true,
        },
        { deliverAs: "steer", triggerTurn: true },
      )
      setPoll(() => reconcile(consume), settled ? settledPollMs : pollMs)
    }
    const consume = async (includeSettled = false) => {
      if (settled && !includeSettled) return checkSettled()
      if (consuming || shuttingDown) return
      consuming = true
      try { await consumeCompletion() } finally { consuming = false }
    }

    watcher = watch(dirname(agent.statusFile), (_event, filename) => {
      const changed = filename?.toString()
      if (!changed || changed === basename(agent.statusFile) || changed === `${basename(agent.statusFile)}.progress`) reconcile(consume)
    })
    watchers.set(agent.id, watcher)
    setPoll(() => reconcile(consume), settled ? settledPollMs : pollMs)
    reconcile(consume)
  }

  pi.on("session_start", async (event, ctx) => {
    if (!await restoreFamily(event.reason, ctx)) return
    for (const agent of agentsCache) if (agent.statusFile) monitor(agent)
  })
  pi.on("session_tree", async (_event, ctx) => {
    stopAllMonitoring()
    if (!await restoreFamily("tree", ctx)) return
    for (const agent of agentsCache) if (agent.statusFile) monitor(agent)
  })

  pi.registerTool({
    name: "background_agent_message",
    ...backgroundToolRenderers("background_agent_message"),
    label: "Message background agent",
    description: "Send a message to a live background agent, including follow-up work after assignment completion. Steers its active turn or starts a new turn if idle; waits for delivery acknowledgement. With force, request cancellation of the targeted active operation before delivering recovery instructions. Cancellation cannot undo partial work and depends on the active tool honoring abort.",
    promptGuidelines: [
      "Use background_agent_message to steer an active assignment or send follow-up work to an idle agent in your task subtree. Wait for its delivery acknowledgement before treating the message as received.",
    ],
    parameters: Type.Object({ id: Type.String(), message: Type.String(), force: Type.Optional(Type.Boolean({ description: "Request cancellation of the active operation before delivering recovery instructions. Work already performed cannot be rolled back." })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!family) await restoreFamily("startup", ctx)
      const agent = (await listAgents(tasks, tmux, family!.nodeId)).find((item) => item.id === params.id)
      const metadata = agent ? { id: agent.id, label: agent.label, target: agent.target, attach: backgroundAttachCommand(agent) } : {}
      if (!params.message.trim()) return { content: [{ type: "text" as const, text: "Message must not be empty" }], details: { ...metadata, status: "error" } }
      if (!agent) return { content: [{ type: "text" as const, text: "Agent not found in this task subtree. Check the agent ID from the background_agent result." }], details: { status: "not_found" } }
      const canReceive = () => canMessageBackgroundAgent(tasks, agent)
      if (!await canReceive()) return { content: [{ type: "text" as const, text: "Agent is no longer running" }], details: { ...metadata, status: "not_running" } }
      const mailbox = `${agent.statusFile}.messages`
      const id = randomUUID()
      const request = join(mailbox, `${id}.request`)
      const ack = join(mailbox, `${id}.ack`)
      const interruptFile = join(mailbox, `${id}.interrupt`)
      const acknowledged = async () => {
        const response = await readFile(ack, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (!response) return undefined
        await rm(ack, { force: true })
        if (params.force && response.startsWith("{")) {
          const result = JSON.parse(response) as { status: string; interruption: string; error?: string }
          await rm(interruptFile, { force: true })
          return { content: [{ type: "text" as const, text: `Message ${result.status}; interruption ${result.interruption}.${result.error ? ` ${result.error}; message may still be pending.` : " Delivery means submitted to Pi, not acted on."}` }], details: { ...metadata, ...result } }
        }
        return { content: [{ type: "text" as const, text: response }], details: { ...metadata, status: response === "delivered" ? "delivered" : "error", ...(params.force ? { interruption: "unconfirmed" } : {}) } }
      }
      try {
        await mkdir(mailbox, { recursive: true, mode: 0o700 })
        const temporary = join(mailbox, `${id}.tmp`)
        const target = params.force ? await readFile(`${agent.statusFile}.operation`, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null
          throw error
        }) : null
        await writeFile(temporary, params.force ? `\u0000force:${JSON.stringify({ message: params.message, operation: target })}` : params.message, { mode: 0o600 })
        const queued = await withMailboxLock(agent.statusFile, async () => {
          if (!await canReceive()) return false
          await rename(temporary, request)
          return true
        })
        if (!queued) {
          await rm(temporary, { force: true })
          return { content: [{ type: "text" as const, text: "Agent is no longer running" }], details: { ...metadata, status: "not_running" } }
        }
        for (let attempt = 0; attempt < 100; attempt++) {
          const response = await acknowledged()
          if (response) return response
          const current = (await listAgents(tasks, tmux, family!.nodeId)).find((item) => item.id === agent.id)
          if (!current || !await canReceive()) {
            const lateAck = await acknowledged()
            if (lateAck) return lateAck
            await rm(request, { force: true })
            return { content: [{ type: "text" as const, text: "Agent is no longer running" }], details: { ...metadata, status: "not_running" } }
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs))
        }
        const interruption = params.force ? await readFile(interruptFile, "utf8").catch(() => "unconfirmed") : undefined
        return { content: [{ type: "text" as const, text: `Acknowledgement timed out; delivery is unconfirmed and message may still be pending${interruption ? `; interruption ${interruption}` : ""}` }], details: { ...metadata, status: "error", ...(interruption ? { interruption } : {}) } }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `${String(error)}; message may still be pending` }], details: { ...metadata, status: "error" } }
      }
    },
  })

  if ((!childStatusFile || process.env[ALLOW_DELEGATION_ENV] === "1") && depth < maxDepth) pi.registerTool({
    name: "background_agent",
    ...backgroundToolRenderers("background_agent"),
    label: "Background agent",
    description:
      "Delegate a task to an inspectable Pi agent in its own tmux session. Returns immediately; the parent automatically receives a completion notification when the initial task settles.",
    promptSnippet: "Delegate work to an inspectable Pi agent running in tmux",
    promptGuidelines: [
      "Delegated Pi work: use background_agent so the user can inspect it.",
      "Set allowDelegation: true when the child's assignment requires it to spawn agents.",
      ...backgroundLifecycleGuidelines,
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Task for the background Pi agent" }),
      label: Type.Optional(Type.String({ description: "Short human-readable label" })),
      cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the current directory" })),
      model: Type.Optional(Type.String({ minLength: 1, description: "Model for the child, such as provider/model-id. Defaults to the parent's model." })),
      allowDelegation: Type.Optional(Type.Boolean({ description: "Allow this child to delegate to agents within the depth ceiling. Defaults to false; each spawn requires an explicit grant." })),
      expectedCompletionMinutes: Type.Number({ minimum: 1, description: "Expected task duration in minutes; triggers a check-in if the agent exceeds it" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!(await tasks.available())) throw new Error("background_agent requires tmux on PATH")

      const label = params.label?.trim() || params.task.split("\n", 1)[0].slice(0, 60) || "task"
      if (!family) await restoreFamily("startup", ctx)
      const parentTarget = currentTmuxPane() || (await currentTmuxSession(tmux)) || family!.rootPane
      const invocation = piInvocation()
      const selectedModel = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined)
      const model = selectedModel ?? "default"
      const thinking = pi.getThinkingLevel()
      const expectedCompletionAt = now() + params.expectedCompletionMinutes * millisecondsPerMinute
      const piArgs = [...invocation.args, "--name", label]

      if (selectedModel) piArgs.push("--model", selectedModel)
      piArgs.push("--thinking", thinking, params.task)

      const task = await tasks.create({
        kind: "agent", label, cwd: params.cwd ?? ctx.cwd, ...familyTaskParent(family!, parentTarget),
        command: invocation.command, args: piArgs, interactiveAfterExit: true,
        statusFileEnv: STATUS_FILE_ENV,
        env: { [AGENT_LABEL_ENV]: label, [DEPTH_ENV]: String(depth + 1), [MAX_DEPTH_ENV]: String(maxDepth), [ALLOW_DELEGATION_ENV]: params.allowDelegation === true ? "1" : "0", PI_BACKGROUND_AGENT_PARENT: parentTarget },
        metadata: { "@pi_agent_status": "running", "@pi_agent_model": model, "@pi_agent_thinking": thinking, "@pi_agent_expected_completion_at": String(expectedCompletionAt) },
      })
      const { id, target, statusFile } = task
      const agent: AgentSession = { ...task, kind: "agent", model, thinking, expectedCompletionAt }
      agentsCache.push(agent)
      pi.events.emit(BACKGROUND_TASK_CREATED, task)
      await checkIns.schedule(statusFile, expectedCompletionAt)
      monitor(agent)
      const revision = ++availabilityRevision
      await updateAvailability(await tasks.list({ subtreeRootId: family!.nodeId }), revision)

      return {
        content: [
          {
            type: "text",
            text: `Started background agent: ${label}\nAgent ID: ${id}\nModel: ${model} (${thinking})\nExpected completion: ${params.expectedCompletionMinutes} minutes`,
          },
        ],
        details: { id, label, target, attach: backgroundAttachCommand({ id, target }), statusFile, expectedCompletionAt },
      }
    },
  })

  pi.on("session_shutdown", () => {
    shuttingDown = true
    ++generation
    ++availabilityRevision
    stopAvailabilityWatchers()
    stopMetadata?.()
    stopMetadata = undefined
    stopAllMonitoring()
  })
}
