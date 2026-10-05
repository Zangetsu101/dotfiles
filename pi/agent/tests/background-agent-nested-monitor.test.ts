import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { EventEmitter } from "node:events"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import backgroundAgentExtension from "../extensions/background-agent.ts"
import backgroundMonitorExtension from "../extensions/background-monitor.ts"
import { BackgroundTasks, type TmuxProcessAdapter } from "../extensions/lib/background-task.ts"

type Handler = (...args: any[]) => any

const execFileAsync = promisify(execFile)

test("a child agent waits for nested background monitors before reporting completion", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-background-agent-test-"))
  const statusFile = join(directory, "completion.json")
  const socket = `pi-nested-monitor-test-${process.pid}-${Date.now()}`
  const tmux: TmuxProcessAdapter = {
    async run(args) {
      return (await execFileAsync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })).stdout.trim()
    },
  }
  const tasks = new BackgroundTasks(tmux)
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("PI_BACKGROUND_") || key === "TMUX" || key === "TMUX_PANE"))
  for (const key of Object.keys(inherited)) delete process.env[key]
  process.env.PI_BACKGROUND_AGENT_STATUS_FILE = statusFile
  process.env.TMUX_PANE = "%isolated-nested-monitor-test"
  t.after(async () => {
    await tmux.run(["kill-server"]).catch(() => undefined)
    for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_") || key === "TMUX" || key === "TMUX_PANE") delete process.env[key]
    Object.assign(process.env, inherited)
    await rm(directory, { recursive: true, force: true })
  })

  const handlers = new Map<string, Handler[]>()
  const tools = new Map<string, any>()
  const messages: Array<{ content: string }> = []
  const messageWaiters: Array<{
    predicate: (message: { content: string }) => boolean
    resolve: () => void
  }> = []
  const eventBus = new EventEmitter()
  let finalOutput = "Research is still running."

  const waitForMessage = (text: string) => {
    if (messages.some((message) => message.content.includes(text))) return Promise.resolve()
    return new Promise<void>((resolve) => {
      messageWaiters.push({ predicate: (message) => message.content.includes(text), resolve })
    })
  }

  const pi = {
    events: eventBus,
    on(name: string, handler: Handler) {
      const registered = handlers.get(name) ?? []
      registered.push(handler)
      handlers.set(name, registered)
    },
    registerCommand() {},
    registerMessageRenderer() {},
    registerTool(tool: any) {
      tools.set(tool.name, tool)
    },
    sendMessage(message: { content: string }) {
      messages.push(message)
      for (const waiter of messageWaiters) {
        if (waiter.predicate(message)) waiter.resolve()
      }
    },
  } as any

  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: finalOutput }],
          },
        },
      ],
    },
  } as any

  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({}, ctx)
  }

  try {
    await backgroundAgentExtension(pi, { tasks, tmux })
    backgroundMonitorExtension(pi, { tasks })

    const monitor = tools.get("background_monitor")
    assert.ok(monitor, "background_monitor should be registered")

    const fastTask = await monitor.execute(
      "fast-monitor-call",
      { command: "sleep 0.1; printf fast-finished", label: "fast nested research", expectedRunningMinutes: 1 },
      undefined,
      undefined,
      ctx,
    )
    assert.ok(fastTask.details.target)
    const slowTask = await monitor.execute(
      "slow-monitor-call",
      { command: "sleep 0.4; printf slow-finished", label: "slow nested research", expectedRunningMinutes: 1 },
      undefined,
      undefined,
      ctx,
    )
    assert.ok(slowTask.details.target)

    await emit("agent_settled")
    await assert.rejects(access(statusFile), { code: "ENOENT" })

    await waitForMessage("fast nested research")
    finalOutput = "One nested monitor is still running."
    await emit("agent_settled")
    await assert.rejects(access(statusFile), { code: "ENOENT" })

    await waitForMessage("slow nested research")
    finalOutput = "Research report written."
    await emit("agent_settled")

    const completion = JSON.parse(await readFile(statusFile, "utf8"))
    assert.equal(completion.kind, "settled")
    assert.equal(completion.output, "Research report written.")
    assert.equal(messages.length, 2)
  } finally {
    await emit("session_shutdown")
  }
})
