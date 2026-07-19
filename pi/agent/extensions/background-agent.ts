import { execFile } from "node:child_process"
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"
import { watch, type FSWatcher } from "node:fs"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import {
  BACKGROUND_ACTIVITY_FINISHED,
  BACKGROUND_ACTIVITY_STARTED,
  type BackgroundActivity,
} from "./lib/background-activity.ts"

const execFileAsync = promisify(execFile)
const STATUS_FILE_ENV = "PI_BACKGROUND_AGENT_STATUS_FILE"
const AGENT_ID_ENV = "PI_BACKGROUND_AGENT_ID"
const AGENT_LABEL_ENV = "PI_BACKGROUND_AGENT_LABEL"
const MAX_RESULT_CHARS = 50_000
const DELEGATED_TASK_INSTRUCTION =
  "Delegated task: Complete all work—including skill delegation steps—in this session."

export function delegatedTaskPrompt(task: string): string {
  return `${DELEGATED_TASK_INSTRUCTION}\n\n${task}`
}

type Completion = {
  kind: "settled" | "exit"
  output?: string
  exitCode?: number
  stopReason?: string
}

type AgentSession = {
  id: string
  target: string
  label: string
  status: string
  model: string
  thinking: string
  parent: string
  owner: string
  statusFile: string
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

async function writeCompletion(path: string, completion: Completion): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, JSON.stringify(completion), { encoding: "utf8", mode: 0o600 })
  await rename(temporaryPath, path)
}

async function tmux(args: string[]): Promise<string> {
  const result = await execFileAsync("tmux", args, { encoding: "utf8" })
  return result.stdout.trim()
}

function piInvocation(): { command: string; args: string[] } {
  const currentScript = process.argv[1]
  if (currentScript && !currentScript.startsWith("/$bunfs/root/")) {
    return { command: process.execPath, args: [currentScript] }
  }
  return { command: "pi", args: [] }
}

function safeLabel(label: string): string {
  const value = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
  return value || "task"
}

function agentReference(agent: AgentSession, agents: AgentSession[]): string {
  const reference = safeLabel(agent.label)
  const matches = agents.filter((item) => safeLabel(item.label) === reference)
  return matches.length === 1 ? reference : `${reference}-${agent.id.slice(-4)}`
}

async function currentTmuxSession(): Promise<string | undefined> {
  if (!process.env.TMUX) return undefined
  try {
    return await tmux(["display-message", "-p", "#{session_name}"])
  } catch {
    return undefined
  }
}

function currentTmuxPane(): string {
  return process.env.TMUX_PANE ?? ""
}

async function listAgents(): Promise<AgentSession[]> {
  let output: string
  try {
    output = await tmux([
      "list-sessions",
      "-F",
      "#{session_name}\t#{@pi_agent_id}\t#{@pi_agent_label}\t#{@pi_agent_status}\t#{@pi_agent_model}\t#{@pi_agent_thinking}\t#{@pi_agent_parent}\t#{@pi_agent_owner}\t#{@pi_agent_status_file}",
    ])
  } catch {
    return []
  }

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [target, id, label, status, model, thinking, parent, owner, statusFile] = line.split("\t")
      return { target, id, label, status, model, thinking, parent, owner, statusFile }
    })
    .filter((agent) => Boolean(agent.id))
}

async function registerChildBridge(pi: ExtensionAPI, statusFile: string): Promise<void> {
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
    await writeCompletion(statusFile, {
      kind: "settled",
      output: result.output,
      stopReason: result.stopReason,
    })
  })

  pi.on("model_select", async (event) => {
    await tmux(["set-option", "@pi_agent_model", `${event.model.provider}/${event.model.id}`]).catch(() => undefined)
  })

  pi.on("thinking_level_select", async (event) => {
    await tmux(["set-option", "@pi_agent_thinking", event.level]).catch(() => undefined)
  })

  pi.registerCommand("agent-return", {
    description: "Return to the tmux session that launched this background agent",
    handler: async (_args, ctx) => {
      const parent = process.env.PI_BACKGROUND_AGENT_PARENT
      if (!process.env.TMUX || !parent) {
        ctx.ui.notify("No parent tmux session is available.", "warning")
        return
      }
      await tmux(["switch-client", "-t", parent])
    },
  })
}

export default async function (pi: ExtensionAPI) {
  const childStatusFile = process.env[STATUS_FILE_ENV]
  if (childStatusFile) {
    await registerChildBridge(pi, childStatusFile)
    return
  }

  const watchers = new Map<string, FSWatcher>()
  let agentsCache = await listAgents()
  let shuttingDown = false

  const monitor = (agent: AgentSession) => {
    if (watchers.has(agent.id)) return

    let completed = false
    const consume = async () => {
      if (completed || shuttingDown) return

      let completion: Completion
      try {
        completion = JSON.parse(await readFile(agent.statusFile, "utf8")) as Completion
      } catch {
        return
      }

      completed = true
      watchers.get(agent.id)?.close()
      watchers.delete(agent.id)
      const failed = completion.kind === "exit"
      const status = failed ? `failed with exit code ${completion.exitCode ?? "unknown"}` : "finished its initial task"
      await tmux(["set-option", "-t", agent.target, "@pi_agent_status", failed ? "failed" : "settled"]).catch(
        () => undefined,
      )

      const summary = `Background agent ${agent.id} (${agent.label}) ${status}.`
      const cached = agentsCache.find((item) => item.id === agent.id)
      if (cached) cached.status = failed ? "failed" : "settled"
      const attach = process.env.TMUX
        ? `/agent-attach ${agentReference(agent, agentsCache)}`
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
      if (!filename || filename.toString() === basename(agent.statusFile)) void consume()
    })
    watchers.set(agent.id, watcher)
    void consume()
  }

  const ownerPane = currentTmuxPane()
  for (const agent of agentsCache) {
    if (agent.owner === ownerPane && agent.status === "running" && agent.statusFile) monitor(agent)
  }

  pi.registerTool({
    name: "background_agent",
    label: "Background agent",
    description:
      "Delegate a task to an inspectable Pi agent in its own tmux session. Returns immediately; the parent is notified when the initial task settles.",
    promptSnippet: "Delegate work to an inspectable Pi agent running in tmux",
    promptGuidelines: [
      "Use background_agent instead of background_monitor when delegating a task to another Pi agent, so the user can inspect it while it works.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Task for the background Pi agent" }),
      label: Type.Optional(Type.String({ description: "Short human-readable label" })),
      cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the current directory" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        await tmux(["-V"])
      } catch {
        throw new Error("background_agent requires tmux on PATH")
      }

      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const label = params.label?.trim() || params.task.split("\n", 1)[0].slice(0, 60) || "task"
      const target = `pi-agent-${safeLabel(label)}-${id}`
      const statusDir = await mkdtemp(join(tmpdir(), `pi-background-agent-${id}-`))
      const statusFile = join(statusDir, "completion.json")
      const parent = (await currentTmuxSession()) ?? ""
      const owner = currentTmuxPane()
      const readyChannel = `pi-background-agent-ready-${id}`
      const invocation = piInvocation()
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "default"
      const thinking = pi.getThinkingLevel()
      const piArgs = [...invocation.args, "--name", `agent: ${label}`]

      if (ctx.model) piArgs.push("--model", model)
      piArgs.push("--thinking", thinking, delegatedTaskPrompt(params.task))

      const shellWrapper = [
        'status="$1"',
        'ready="$2"',
        "shift 2",
        'tmux wait-for "$ready"',
        '"$@"',
        "code=$?",
        'if [ ! -e "$status" ]; then',
        '  printf \'{"kind":"exit","exitCode":%s}\\n\' "$code" > "$status.tmp"',
        '  mv "$status.tmp" "$status"',
        "fi",
        'exec "${SHELL:-/bin/bash}" -l',
      ].join("\n")

      const command = [
        "/usr/bin/env",
        `${STATUS_FILE_ENV}=${statusFile}`,
        `${AGENT_ID_ENV}=${id}`,
        `${AGENT_LABEL_ENV}=${label}`,
        `PI_BACKGROUND_AGENT_PARENT=${parent}`,
        invocation.command,
        ...piArgs,
      ]

      const agent: AgentSession = {
        id,
        target,
        label,
        status: "running",
        model,
        thinking,
        parent,
        owner,
        statusFile,
      }
      agentsCache.push(agent)
      monitor(agent)

      try {
        await tmux([
          "new-session",
          "-d",
          "-s",
          target,
          "-c",
          params.cwd ?? ctx.cwd,
          "/bin/bash",
          "-lc",
          shellWrapper,
          "background-agent",
          statusFile,
          readyChannel,
          ...command,
        ])
        await Promise.all([
          tmux(["set-option", "-t", target, "@pi_agent_id", id]),
          tmux(["set-option", "-t", target, "@pi_agent_label", label]),
          tmux(["set-option", "-t", target, "@pi_agent_status", "running"]),
          tmux(["set-option", "-t", target, "@pi_agent_model", model]),
          tmux(["set-option", "-t", target, "@pi_agent_thinking", thinking]),
          tmux(["set-option", "-t", target, "@pi_agent_parent", parent]),
          tmux(["set-option", "-t", target, "@pi_agent_owner", owner]),
          tmux(["set-option", "-t", target, "@pi_agent_status_file", statusFile]),
        ])
        await tmux(["wait-for", "-S", readyChannel])
      } catch (error) {
        watchers.get(id)?.close()
        watchers.delete(id)
        await tmux(["kill-session", "-t", target]).catch(() => undefined)
        throw error
      }

      const attach = process.env.TMUX
        ? `/agent-attach ${agentReference(agent, agentsCache)}`
        : `tmux attach -t ${target}`
      return {
        content: [
          {
            type: "text",
            text: `Started background agent: ${label}\nModel: ${model} (${thinking})\nTmux target: ${target}\nAttach with: ${attach}\nReturn from the child with: /agent-return`,
          },
        ],
        details: { id, label, target, statusFile },
      }
    },
  })

  pi.registerCommand("agents", {
    description: "List inspectable background Pi agents",
    handler: async (_args, ctx) => {
      const agents = await listAgents()
      agentsCache = agents
      if (agents.length === 0) {
        ctx.ui.notify("No background agents found.", "info")
        return
      }

      const lines = agents.map(
        (agent) =>
          `${agent.id}  ${agent.status || "unknown"}  ${agent.label}\n  ${agent.model || "unknown model"} (${agent.thinking || "unknown effort"})  ${agent.target}`,
      )
      ctx.ui.notify(`Background agents:\n${lines.join("\n")}`, "info")
    },
  })

  pi.registerCommand("agent-attach", {
    description: "Attach to a background agent",
    getArgumentCompletions: (prefix: string) => {
      const normalizedPrefix = prefix.trim().toLowerCase()
      const items = agentsCache
        .map((agent) => ({
          value: agentReference(agent, agentsCache),
          label: agent.label,
          description: `${agent.status || "unknown"} · ${agent.model || "unknown model"} (${agent.thinking || "unknown effort"})`,
          agent,
        }))
        .filter(
          (item) =>
            item.value.startsWith(normalizedPrefix) || item.agent.label.toLowerCase().includes(normalizedPrefix),
        )
        .map(({ value, label, description }) => ({ value, label, description }))
      return items.length > 0 ? items : null
    },
    handler: async (args, ctx) => {
      const requested = args.trim()
      const agents = await listAgents()
      agentsCache = agents
      const agent = agents.find(
        (item) =>
          item.id === requested || item.target === requested || agentReference(item, agents) === requested,
      )
      if (!agent) {
        ctx.ui.notify(`Unknown background agent: ${requested || "(missing reference)"}`, "error")
        return
      }
      if (!process.env.TMUX) {
        ctx.ui.notify(`Run: tmux attach -t ${agent.target}`, "info")
        return
      }
      await tmux(["switch-client", "-t", agent.target])
    },
  })

  pi.on("session_shutdown", () => {
    shuttingDown = true
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
  })
}
