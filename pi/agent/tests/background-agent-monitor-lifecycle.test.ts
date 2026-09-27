import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import backgroundAgentExtension from "../extensions/background-agent.ts"

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

for (const outcome of ["settled", "exit"] as const) test(`${outcome} agents stop polling, including after session restoration`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-monitor-"))
  const agent = {
    id: "agent-one", kind: "agent", target: "test:agent", label: "test", status: "running",
    statusFile: join(directory, "completion.json"), parentId: `root:${directory}`, familyId: `family:${directory}`, cwd: directory,
  }
  let claims = 0
  let completed = false
  let claimed = false
  const completion = { kind: outcome, output: "done", exitCode: outcome === "exit" ? 1 : 0 }
  const tasks = {
    list: async () => [{ ...agent, status: completed ? (outcome === "exit" ? "failed" : "succeeded") : "running" }],
    claimCompletionOrReconcile: async () => { claims++; if (!completed || claimed) return undefined; claimed = true; return completion },
    completion: async () => completed ? completion : undefined,
  }
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void> | void>>()
  const messages: unknown[] = []
  const pi = {
    events: new EventEmitter(),
    on(name: string, handler: (event: any, ctx: any) => Promise<void> | void) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    registerTool() {}, registerCommand() {},
    sendMessage(message: unknown) { messages.push(message) },
  }
  const ctx = { cwd: directory, sessionManager: { getSessionId: () => directory, getSessionFile: () => join(directory, "session.jsonl"), getBranch: () => [] } }
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({}, ctx)
  }
  try {
    await backgroundAgentExtension(pi as any, {
      tasks: tasks as any,
      tmux: { run: async () => "" },
      pollMs: 10,
    })
    await emit("session_start")
    await pause(60)
    assert.ok(claims >= 2, "running agent should be reconciled repeatedly")
    completed = true
    await pause(60)
    assert.equal(messages.length, 1)
    const afterCompletion = claims
    await pause(60)
    assert.equal(claims, afterCompletion, "settled agent must not keep polling")

    await emit("session_tree")
    await pause(60)
    const afterRestore = claims
    await pause(60)
    assert.equal(claims, afterRestore, "restored settled agent must not keep polling")
    assert.equal(messages.length, 1)
  } finally {
    await emit("session_shutdown")
    await rm(directory, { recursive: true, force: true })
  }
})
