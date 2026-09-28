import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { basename, dirname, join } from "node:path"
import { access, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { watch, type FSWatcher } from "node:fs"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import {
  BACKGROUND_ACTIVITY_FINISHED,
  BACKGROUND_ACTIVITY_STARTED,
  type BackgroundActivity,
} from "./lib/background-activity.ts"
import {
  BACKGROUND_TASK_CREATED,
  BACKGROUND_TASK_STATUS_CHANGED,
  BackgroundTasks,
  systemTmux,
  writeTaskCompletion,
  type TaskStatus,
  type TmuxProcessAdapter,
} from "./lib/background-task.ts"
import { familyForContext, familyTaskParent, type TaskFamily } from "./lib/background-family.ts"

const execFileAsync = promisify(execFile)
const STATUS_FILE_ENV = "PI_BACKGROUND_AGENT_STATUS_FILE"
const DEPTH_ENV = "PI_BACKGROUND_AGENT_DEPTH"
const MAX_DEPTH_ENV = "PI_BACKGROUND_AGENT_MAX_DEPTH"
const AGENT_LABEL_ENV = "PI_BACKGROUND_AGENT_LABEL"
const DEFAULT_MAX_AGENT_DEPTH = 2
const MAX_RESULT_CHARS = 50_000
const POLL_MS = 100
const SETTLED_POLL_MS = 2_000

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

function overrunFile(statusFile: string): string {
  return `${statusFile}.overrun`
}

function scheduleDeadline(statusFile: string, expectedCompletionAt: number): void {
  const script = `
const fs = require("node:fs")
const [statusFile, markerFile, deadline] = process.argv.slice(1)
setTimeout(() => {
  if (fs.existsSync(statusFile)) return
  try { fs.writeFileSync(markerFile, deadline, { flag: "wx", mode: 0o600 }) } catch (error) {
    if (error.code !== "EEXIST") throw error
  }
}, Math.max(0, Number(deadline) - Date.now()))
`
  const child = spawn(process.execPath, ["-e", script, statusFile, overrunFile(statusFile), String(expectedCompletionAt)], {
    detached: true,
    stdio: "ignore",
  })
  child.unref()
}

async function claimOverrun(statusFile: string): Promise<boolean> {
  try {
    await access(overrunFile(statusFile))
    const claim = await open(`${overrunFile(statusFile)}.notified`, "wx", 0o600)
    await claim.close()
    return true
  } catch {
    return false
  }
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

async function registerChildBridge(pi: ExtensionAPI, statusFile: string, tmux: TmuxProcessAdapter, pollMs: number): Promise<void> {
  const mailbox = `${statusFile}.messages`
  let processing = false
  let busy = false
  let closed = false
  let timer: NodeJS.Timeout | undefined
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
        try {
          const message = await readFile(request, "utf8")
          pi.sendUserMessage(message, processing ? { deliverAs: "steer" } : undefined)
          await writeFile(ack, "delivered", { flag: "wx", mode: 0o600 })
        } catch (error) {
          await writeFile(ack, `error: ${String(error)}`, { flag: "wx", mode: 0o600 }).catch(() => undefined)
        }
        if (await readFile(ack, "utf8").catch(() => undefined)) await rm(request, { force: true })
      }
    } finally { busy = false }
  }
  pi.on("session_start", async () => {
    await mkdir(mailbox, { recursive: true, mode: 0o700 })
    closed = false
    if (timer) clearInterval(timer)
    timer = setInterval(() => { void receive().catch((error) => console.error("background agent mailbox:", error)) }, pollMs)
    await receive()
  })
  pi.on("session_shutdown", () => { closed = true; if (timer) clearInterval(timer) })
  pi.on("agent_start", () => { processing = true })
  pi.on("agent_end", () => { processing = false })
  const activeBackgroundActivities = new Set<string>()
  let reported = false

  pi.events.on(BACKGROUND_ACTIVITY_STARTED, (data) => {
    const activity = data as BackgroundActivity
    if (activity?.id) activeBackgroundActivities.add(activity.id)
  })

  pi.events.on(BACKGROUND_ACTIVITY_FINISHED, (data) => {
    const activity = data as BackgroundActivity
    if (activity?.id) activeBackgroundActivities.delete(activity.id)
  })

  pi.on("agent_start", async () => {
    if (!reported) return
    reported = false
    await Promise.all([
      rm(statusFile, { force: true }),
      rm(`${statusFile}.notified`, { force: true }),
      rm(overrunFile(statusFile), { force: true }),
      rm(`${overrunFile(statusFile)}.notified`, { force: true }),
      tmux.run(["set-option", "-w", "@pi_agent_status", "running"]).catch(() => undefined),
      tmux.run(["set-option", "-w", "@pi_task_status", "running"]).catch(() => undefined),
    ])
  })

  pi.on("agent_settled", async (_event, ctx) => {
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
        output: result.output,
        stopReason: result.stopReason,
      })
    })
  })

  pi.on("model_select", async (event) => {
    await tmux.run(["set-option", "@pi_agent_model", `${event.model.provider}/${event.model.id}`]).catch(() => undefined)
  })

  pi.on("thinking_level_select", async (event) => {
    await tmux.run(["set-option", "@pi_agent_thinking", event.level]).catch(() => undefined)
  })
}

export default async function (pi: ExtensionAPI, options: BackgroundAgentOptions = {}) {
  const tasks = options.tasks ?? new BackgroundTasks(options.tmux ?? systemTmux)
  const tmux = options.tmux ?? directTmux
  const millisecondsPerMinute = options.millisecondsPerMinute ?? 60_000
  const pollMs = options.pollMs ?? POLL_MS
  const settledPollMs = options.settledPollMs ?? SETTLED_POLL_MS
  const childStatusFile = process.env[STATUS_FILE_ENV]
  const parsedDepth = Number.parseInt(process.env[DEPTH_ENV] ?? "", 10)
  const depth = childStatusFile ? (Number.isFinite(parsedDepth) ? parsedDepth : 1) : 0
  const configuredMaxDepth = Number.parseInt(process.env[MAX_DEPTH_ENV] ?? "", 10)
  const maxDepth = Number.isFinite(configuredMaxDepth) ? configuredMaxDepth : DEFAULT_MAX_AGENT_DEPTH
  if (childStatusFile) await registerChildBridge(pi, childStatusFile, tmux, pollMs)
  if (depth >= maxDepth) return

  const watchers = new Map<string, FSWatcher>()
  const reconciliationTimers = new Map<string, NodeJS.Timeout>()
  let agentsCache: AgentSession[] = []
  let family: TaskFamily | undefined
  let shuttingDown = false

  const restoreFamily = async (reason: string, ctx: ExtensionContext) => {
    family = familyForContext(reason, ctx, pi.getSessionName?.())
    agentsCache = (await listAgents(tasks, tmux, family.nodeId)).filter((agent) => agent.parentId === family!.nodeId)
  }

  const stopMonitoring = (id: string) => {
    watchers.get(id)?.close()
    watchers.delete(id)
    const timer = reconciliationTimers.get(id)
    if (timer) clearInterval(timer)
    reconciliationTimers.delete(id)
  }

  const stopAllMonitoring = () => {
    for (const id of watchers.keys()) stopMonitoring(id)
  }

  const monitor = (agent: AgentSession) => {
    if (watchers.has(agent.id)) return

    const activity: BackgroundActivity = { id: `background-agent:${agent.id}`, source: "background_agent", label: agent.label }
    if (agent.status === "running") pi.events.emit(BACKGROUND_ACTIVITY_STARTED, activity)
    let settled = agent.status !== "running"
    let consuming = false
    let checkingSettled = false
    let consumingOverrun = false
    let watcher: FSWatcher
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
        if (await tasks.completion(agent)) return
        settled = false
        agent.status = "running"
        await tasks.setStatus(agent, "running")
        pi.events.emit(BACKGROUND_ACTIVITY_STARTED, activity)
        setPoll(() => void consume(), pollMs)
        void consume()
      } finally {
        checkingSettled = false
      }
    }
    const consumeOverrun = async () => {
      if (settled || consumingOverrun || shuttingDown) return
      consumingOverrun = true
      try {
        if (!(await claimOverrun(agent.statusFile))) return
        if (await tasks.completion(agent)) return
        const current = (await listAgents(tasks, tmux, agent.parentId ?? agent.id)).find((candidate) => candidate.id === agent.id)
        if (!current || current.status !== "running") return
        pi.sendMessage(
          {
            customType: "background-agent-check-in",
            content: `Background agent ${agent.id} (${agent.label}) has worked past its expected completion time.`,
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true },
        )
      } finally {
        consumingOverrun = false
      }
    }
    const consume = async () => {
      if (settled) return void checkSettled()
      if (consuming || shuttingDown) return
      consuming = true

      const completion = await tasks.claimCompletionOrReconcile(agent)
      if (!completion) {
        consuming = false
        return
      }

      settled = true
      pi.events.emit(BACKGROUND_ACTIVITY_FINISHED, activity)
      const agentCompletion = "kind" in completion
      const failed = agentCompletion ? completion.kind === "exit" || completion.stopReason === "error" : completion.status === "failed"
      const terminated = !agentCompletion && completion.status === "cancelled"
      const status = terminated
        ? `was terminated${completion.reason ? `: ${completion.reason}` : ""}`
        : failed
          ? agentCompletion && completion.kind !== "exit" ? "failed with a model error" : `failed with exit code ${completion.exitCode ?? "unknown"}`
          : "finished its initial task"
      const taskStatus: TaskStatus = terminated ? "terminated" : failed ? "failed" : "succeeded"
      await Promise.all([
        tmux.run(["set-option", "-w", "-t", agent.target, "@pi_agent_status", terminated ? "terminated" : failed ? "failed" : "settled"]),
        tmux.run(["set-option", "-w", "-t", agent.target, "@pi_task_status", taskStatus]),
      ]).catch(() => undefined)

      const summary = `Background agent ${agent.id} (${agent.label}) ${status}.`
      agent.status = taskStatus
      const cached = agentsCache.find((item) => item.id === agent.id)
      if (cached) cached.status = taskStatus
      pi.events.emit(BACKGROUND_TASK_STATUS_CHANGED, agent)
      const attach = process.env.TMUX
        ? `/task attach ${agent.id}`
        : `tmux attach -t ${agent.target}`
      const output = "output" in completion ? completion.output?.trim() || "(no final output)" : "(no final output)"

      pi.sendMessage(
        {
          customType: "background-agent",
          content: `${summary}\nAttach with: ${attach}\n\nFinal output:\n${output}\n\nReview the result and report it to the user.`,
          display: true,
        },
        { deliverAs: "followUp", triggerTurn: true },
      )
      setPoll(() => void checkSettled(), settledPollMs)
      consuming = false
    }

    watcher = watch(dirname(agent.statusFile), (_event, filename) => {
      if (!filename) {
        if (settled) void checkSettled()
        else void consume()
        void consumeOverrun()
        return
      }
      const changed = filename.toString()
      if (changed === basename(agent.statusFile)) {
        if (settled) void checkSettled()
        else void consume()
      }
      if (changed === basename(overrunFile(agent.statusFile))) void consumeOverrun()
    })
    watchers.set(agent.id, watcher)
    setPoll(() => settled ? void checkSettled() : void consume(), settled ? settledPollMs : pollMs)
    if (settled) void checkSettled()
    else void consume()
    void consumeOverrun()
  }

  pi.on("session_start", async (event, ctx) => {
    await restoreFamily(event.reason, ctx)
    for (const agent of agentsCache) if (agent.statusFile) monitor(agent)
  })
  pi.on("session_tree", async (_event, ctx) => {
    stopAllMonitoring()
    await restoreFamily("tree", ctx)
    for (const agent of agentsCache) if (agent.statusFile) monitor(agent)
  })

  pi.registerTool({
    name: "background_agent_message",
    label: "Message background agent",
    description: "Send a message to an unfinished background agent. Steers its active turn or starts a new turn if idle; waits for delivery acknowledgement.",
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!family) await restoreFamily("startup", ctx)
      const agent = (await listAgents(tasks, tmux, family!.nodeId)).find((item) => item.id === params.id)
      if (!params.message.trim()) return { content: [{ type: "text" as const, text: "Message must not be empty" }], details: { status: "error" } }
      if (!agent || agent.status !== "running" || await tasks.completion(agent)) return { content: [{ type: "text" as const, text: "Agent is not running in this task subtree" }], details: { status: "not_running" } }
      const mailbox = `${agent.statusFile}.messages`
      const id = randomUUID()
      const request = join(mailbox, `${id}.request`)
      const ack = join(mailbox, `${id}.ack`)
      const acknowledged = async () => {
        const response = await readFile(ack, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (!response) return undefined
        await rm(ack, { force: true })
        return { content: [{ type: "text" as const, text: response }], details: { status: response === "delivered" ? "delivered" : "error" } }
      }
      try {
        await mkdir(mailbox, { recursive: true, mode: 0o700 })
        const temporary = join(mailbox, `${id}.tmp`)
        await writeFile(temporary, params.message, { mode: 0o600 })
        const queued = await withMailboxLock(agent.statusFile, async () => {
          if (await tasks.completion(agent)) return false
          await rename(temporary, request)
          return true
        })
        if (!queued) {
          await rm(temporary, { force: true })
          return { content: [{ type: "text" as const, text: "Agent is no longer running" }], details: { status: "not_running" } }
        }
        for (let attempt = 0; attempt < 100; attempt++) {
          const response = await acknowledged()
          if (response) return response
          const current = (await listAgents(tasks, tmux, family!.nodeId)).find((item) => item.id === agent.id)
          if (!current || current.status !== "running" || await tasks.completion(agent)) {
            const lateAck = await acknowledged()
            if (lateAck) return lateAck
            await rm(request, { force: true })
            return { content: [{ type: "text" as const, text: "Agent is no longer running" }], details: { status: "not_running" } }
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs))
        }
        return { content: [{ type: "text" as const, text: "Acknowledgement timed out; delivery is unconfirmed and message may still be queued" }], details: { status: "error" } }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `${String(error)}; message may still be pending` }], details: { status: "error" } }
      }
    },
  })

  pi.registerTool({
    name: "background_agent",
    label: "Background agent",
    description:
      "Delegate a task to an inspectable Pi agent in its own tmux session. Returns immediately; the parent automatically receives a completion notification when the initial task settles.",
    promptSnippet: "Delegate work to an inspectable Pi agent running in tmux",
    promptGuidelines: [
      "Delegated Pi work: use background_agent so the user can inspect it.",
      "After background_agent starts, continue independent work. When only delegated work remains, yield the turn; the automatic completion or overrun notification will resume you.",
      "While delegated work is active, report progress rather than claiming a final result. After it's finished, handle its result and return to the conversation's pending work. If the user was waiting to answer a question or make a decision, reconsider it in light of the result and restate the question. If no user input is pending and the work is complete, provide a standalone final result.",
      "Use background_agent_message to steer a running agent in your task subtree; wait for its delivery acknowledgement before treating the message as received.",
      "Monitor a background agent's session after an overrun notification or other concrete evidence of a stall; follow up until it completes or needs intervention."
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Task for the background Pi agent" }),
      label: Type.Optional(Type.String({ description: "Short human-readable label" })),
      cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the current directory" })),
      expectedCompletionMinutes: Type.Number({ minimum: 1, description: "Expected task duration in minutes; triggers a check-in if the agent exceeds it" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!(await tasks.available())) throw new Error("background_agent requires tmux on PATH")

      const label = params.label?.trim() || params.task.split("\n", 1)[0].slice(0, 60) || "task"
      if (!family) await restoreFamily("startup", ctx)
      const parentTarget = currentTmuxPane() || (await currentTmuxSession(tmux)) || family!.rootPane
      const invocation = piInvocation()
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "default"
      const thinking = pi.getThinkingLevel()
      const expectedCompletionAt = Date.now() + params.expectedCompletionMinutes * millisecondsPerMinute
      const piArgs = [...invocation.args, "--name", label]

      if (ctx.model) piArgs.push("--model", model)
      piArgs.push("--thinking", thinking, params.task)

      const task = await tasks.create({
        kind: "agent", label, cwd: params.cwd ?? ctx.cwd, ...familyTaskParent(family!, parentTarget),
        command: invocation.command, args: piArgs, interactiveAfterExit: true,
        statusFileEnv: STATUS_FILE_ENV,
        env: { [AGENT_LABEL_ENV]: label, [DEPTH_ENV]: String(depth + 1), [MAX_DEPTH_ENV]: String(maxDepth), PI_BACKGROUND_AGENT_PARENT: parentTarget },
        metadata: { "@pi_agent_status": "running", "@pi_agent_model": model, "@pi_agent_thinking": thinking, "@pi_agent_expected_completion_at": String(expectedCompletionAt) },
      })
      const { id, target, statusFile } = task
      const agent: AgentSession = { ...task, kind: "agent", model, thinking, expectedCompletionAt }
      agentsCache.push(agent)
      pi.events.emit(BACKGROUND_TASK_CREATED, task)
      scheduleDeadline(statusFile, expectedCompletionAt)
      monitor(agent)

      return {
        content: [
          {
            type: "text",
            text: `Started background agent: ${label}\nModel: ${model} (${thinking})\nExpected completion: ${params.expectedCompletionMinutes} minutes`,
          },
        ],
        details: { id, label, target, statusFile, expectedCompletionAt },
      }
    },
  })

  pi.on("session_shutdown", () => {
    shuttingDown = true
    stopAllMonitoring()
  })
}
