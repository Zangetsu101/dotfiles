import { spawn, type ChildProcess } from "node:child_process"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import {
  BACKGROUND_ACTIVITY_FINISHED,
  BACKGROUND_ACTIVITY_STARTED,
  type BackgroundActivity,
} from "./lib/background-activity.ts"

const MAX_OUTPUT_CHARS = 50_000

type Monitor = {
  child: ChildProcess
  label: string
}

function appendTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8")
  return next.length <= MAX_OUTPUT_CHARS ? next : next.slice(-MAX_OUTPUT_CHARS)
}

export default function (pi: ExtensionAPI) {
  const monitors = new Map<number, Monitor>()
  let nextId = 1
  let shuttingDown = false

  pi.registerTool({
    name: "background_monitor",
    label: "Background monitor",
    description:
      "Run a slow, finite shell command asynchronously. On exit, wake the agent with its status and captured output.",
    promptSnippet: "Run slow, finite shell commands asynchronously and wake on completion",
    promptGuidelines: [
      "Slow, finite commands requiring follow-up: use background_monitor.",
      "Short commands requiring immediate results: use bash.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Slow, finite shell command to run asynchronously until it exits" }),
      label: Type.Optional(Type.String({ description: "Short description shown on completion" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = nextId++
      const label = params.label?.trim() || params.command
      const activity: BackgroundActivity = {
        id: `background-monitor:${id}`,
        source: "background_monitor",
        label,
      }
      const child = spawn("/bin/bash", ["-lc", params.command], {
        cwd: ctx.cwd,
        env: process.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      })

      let output = ""
      let finished = false
      child.stdout.on("data", (chunk: Buffer) => {
        output = appendTail(output, chunk)
      })
      child.stderr.on("data", (chunk: Buffer) => {
        output = appendTail(output, chunk)
      })

      const finish = (status: string, failed: boolean) => {
        if (finished) return
        finished = true
        monitors.delete(id)
        pi.events.emit(BACKGROUND_ACTIVITY_FINISHED, activity)
        if (shuttingDown) return

        const summary = `Background monitor #${id} (${label}) ${status}.`
        if (ctx.hasUI) ctx.ui.notify(summary, failed ? "error" : "info")

        pi.sendMessage(
          {
            customType: "background-monitor",
            content: `${summary}\n\nOutput:\n${output.trim() || "(no output)"}\n\nReview the result and report it to the user.`,
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true },
        )
      }

      child.once("error", (error) => finish(`failed to start: ${error.message}`, true))
      child.once("close", (code, signal) => {
        const status = signal ? `was terminated by ${signal}` : `finished with exit code ${code ?? "unknown"}`
        finish(status, code !== 0 || signal !== null)
      })

      monitors.set(id, { child, label })
      pi.events.emit(BACKGROUND_ACTIVITY_STARTED, activity)

      return {
        content: [{ type: "text", text: `Started background monitor #${id}: ${label}` }],
        details: { id, pid: child.pid, label },
      }
    },
  })

  pi.on("session_shutdown", () => {
    shuttingDown = true
    for (const { child } of monitors.values()) {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM")
        } catch {
          // Process already exited.
        }
      }
    }
    monitors.clear()
  })
}
