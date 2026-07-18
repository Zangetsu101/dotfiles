import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { access, mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import backgroundAgentExtension from "../extensions/background-agent.ts"
import backgroundMonitorExtension from "../extensions/background-monitor.ts"

type Handler = (...args: any[]) => any

test("a child agent waits for nested background monitors before reporting completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-background-agent-test-"))
  const statusFile = join(directory, "completion.json")
  const previousStatusFile = process.env.PI_BACKGROUND_AGENT_STATUS_FILE
  process.env.PI_BACKGROUND_AGENT_STATUS_FILE = statusFile

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
    await backgroundAgentExtension(pi)
    backgroundMonitorExtension(pi)

    const monitor = tools.get("background_monitor")
    assert.ok(monitor, "background_monitor should be registered")

    await monitor.execute(
      "fast-monitor-call",
      { command: "sleep 0.1; printf fast-finished", label: "fast nested research" },
      undefined,
      undefined,
      ctx,
    )
    await monitor.execute(
      "slow-monitor-call",
      { command: "sleep 0.4; printf slow-finished", label: "slow nested research" },
      undefined,
      undefined,
      ctx,
    )

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
    if (previousStatusFile === undefined) delete process.env.PI_BACKGROUND_AGENT_STATUS_FILE
    else process.env.PI_BACKGROUND_AGENT_STATUS_FILE = previousStatusFile
  }
})
