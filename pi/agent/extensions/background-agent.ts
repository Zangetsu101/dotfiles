import { execFile, spawn } from "node:child_process"
import { basename, dirname } from "node:path"
import { access, open } from "node:fs/promises"
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
  type AgentTaskCompletion,
  type TmuxProcessAdapter,
} from "./lib/background-task.ts"

const execFileAsync = promisify(execFile)
const STATUS_FILE_ENV = "PI_BACKGROUND_AGENT_STATUS_FILE"
const DEPTH_ENV = "PI_BACKGROUND_AGENT_DEPTH"
const AGENT_LABEL_ENV = "PI_BACKGROUND_AGENT_LABEL"
const MAX_AGENT_DEPTH = 2
const MAX_RESULT_CHARS = 50_000

type AgentSession = {
  id: string
  target: string
  label: string
  status: string
  model: string
  thinking: string
  expectedCompletionAt: number
  parent: string
  owner: string
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

async function listAgents(tasks: BackgroundTasks, tmux: TmuxProcessAdapter, owner?: string): Promise<AgentSession[]> {
  const generic = (await tasks.list(owner)).filter((task) => task.storageMode !== "legacy" && task.kind === "agent")
  let output = ""
  try { output = await tmux.run(["list-windows", "-a", "-F", "#{session_name}:#{window_name}\t#{@pi_agent_status}\t#{@pi_agent_model}\t#{@pi_agent_thinking}\t#{@pi_agent_expected_completion_at}"]) } catch {}
  const details = new Map(output.split("\n").filter(Boolean).map((line) => { const [target, status, model, thinking, expectedCompletionAt] = line.split("\t"); return [target, { status, model, thinking, expectedCompletionAt }] }))
  return generic.map((task) => {
    const detail = details.get(task.target)
    return { ...task, kind: "agent" as const, status: detail?.status || task.status, model: detail?.model || "", thinking: detail?.thinking || "", expectedCompletionAt: Number(detail?.expectedCompletionAt) || 0 }
  })
}

async function registerChildBridge(pi: ExtensionAPI, statusFile: string, tmux: TmuxProcessAdapter): Promise<void> {
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

  pi.on("agent_settled", async (_event, ctx) => {
    if (reported || activeBackgroundActivities.size > 0) return
    reported = true
    const result = finalAssistantOutput(ctx)
    await writeTaskCompletion(statusFile, {
      kind: "settled",
      output: result.output,
      stopReason: result.stopReason,
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
  const childStatusFile = process.env[STATUS_FILE_ENV]
  const parsedDepth = Number.parseInt(process.env[DEPTH_ENV] ?? "", 10)
  const depth = childStatusFile ? (Number.isFinite(parsedDepth) ? parsedDepth : 1) : 0
  if (childStatusFile) await registerChildBridge(pi, childStatusFile, tmux)
  if (depth >= MAX_AGENT_DEPTH) return

  const watchers = new Map<string, FSWatcher>()
  let agentsCache = await listAgents(tasks, tmux, currentTmuxPane())
  let shuttingDown = false

  const monitor = (agent: AgentSession) => {
    if (watchers.has(agent.id)) return

    const activity: BackgroundActivity = { id: `background-agent:${agent.id}`, source: "background_agent", label: agent.label }
    pi.events.emit(BACKGROUND_ACTIVITY_STARTED, activity)
    let completed = false
    let consuming = false
    let consumingOverrun = false
    const consumeOverrun = async () => {
      if (completed || consumingOverrun || shuttingDown) return
      consumingOverrun = true
      try {
        if (!(await claimOverrun(agent.statusFile))) return
        if (await tasks.completion(agent)) return
        const current = (await listAgents(tasks, tmux, agent.owner)).find((candidate) => candidate.id === agent.id)
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
      if (completed || consuming || shuttingDown) return
      consuming = true

      const completion = await tasks.claimCompletionRecord(agent) as AgentTaskCompletion | undefined
      if (!completion || !("kind" in completion)) {
        consuming = false
        return
      }

      completed = true
      watchers.get(agent.id)?.close()
      watchers.delete(agent.id)
      pi.events.emit(BACKGROUND_ACTIVITY_FINISHED, activity)
      const failed = completion.kind === "exit" || completion.stopReason === "error"
      const status = failed
        ? completion.kind === "exit"
          ? `failed with exit code ${completion.exitCode ?? "unknown"}`
          : "failed with a model error"
        : "finished its initial task"
      await Promise.all([
        tmux.run(["set-option", "-w", "-t", agent.target, "@pi_agent_status", failed ? "failed" : "settled"]),
        tmux.run(["set-option", "-w", "-t", agent.target, "@pi_task_status", failed ? "failed" : "completed"]),
      ]).catch(() => undefined)

      const summary = `Background agent ${agent.id} (${agent.label}) ${status}.`
      const taskStatus = failed ? "failed" : "completed"
      agent.status = taskStatus
      const cached = agentsCache.find((item) => item.id === agent.id)
      if (cached) cached.status = taskStatus
      pi.events.emit(BACKGROUND_TASK_STATUS_CHANGED, agent)
      const attach = process.env.TMUX
        ? `/task attach ${agent.id}`
        : `tmux attach -t ${agent.target}`
      const output = completion.output?.trim() || "(no final output)"

      pi.sendMessage(
        {
          customType: "background-agent",
          content: `${summary}\nAttach with: ${attach}\n\nFinal output:\n${output}\n\nReview the result and report it to the user.`,
          display: true,
        },
        { deliverAs: "followUp", triggerTurn: true },
      )
    }

    const watcher = watch(dirname(agent.statusFile), (_event, filename) => {
      if (!filename) {
        void consume()
        void consumeOverrun()
        return
      }
      const changed = filename.toString()
      if (changed === basename(agent.statusFile)) void consume()
      if (changed === basename(overrunFile(agent.statusFile))) void consumeOverrun()
    })
    watchers.set(agent.id, watcher)
    void consume()
    void consumeOverrun()
  }

  for (const agent of agentsCache) {
    if (agent.status === "running" && agent.statusFile) monitor(agent)
  }

  pi.registerTool({
    name: "background_agent",
    label: "Background agent",
    description:
      "Delegate a task to an inspectable Pi agent in its own tmux session. Returns immediately; the parent automatically receives a completion notification when the initial task settles.",
    promptSnippet: "Delegate work to an inspectable Pi agent running in tmux",
    promptGuidelines: [
      "Delegated Pi work: use background_agent so the user can inspect it.",
      "After background_agent starts, continue independent work. When only delegated work remains, yield the turn; the automatic completion or overrun notification will resume you.",
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
      const parent = (await currentTmuxSession(tmux)) ?? ""
      const owner = currentTmuxPane()
      const invocation = piInvocation()
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "default"
      const thinking = pi.getThinkingLevel()
      const expectedCompletionAt = Date.now() + params.expectedCompletionMinutes * millisecondsPerMinute
      const piArgs = [...invocation.args, "--name", `agent: ${label}`]

      if (ctx.model) piArgs.push("--model", model)
      piArgs.push("--thinking", thinking, params.task)

      const task = await tasks.create({
        kind: "agent", label, cwd: params.cwd ?? ctx.cwd, parent, owner,
        command: invocation.command, args: piArgs, interactiveAfterExit: true,
        statusFileEnv: STATUS_FILE_ENV,
        env: { [AGENT_LABEL_ENV]: label, [DEPTH_ENV]: String(depth + 1), PI_BACKGROUND_AGENT_PARENT: parent },
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
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
  })
}
