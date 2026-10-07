import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import codexUsageExtension from "../extensions/codex-usage.ts"

test("Codex usage updates and clears on model change and shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-test-"))
  const previousPath = process.env.PATH
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>()
  const statuses = new Map<string, string>()
  try {
    await writeFile(join(directory, "codex"), '#!/usr/bin/env node\nprocess.stdin.on("data", () => { process.stdout.write(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:12,windowDurationMins:300,resetsAt:null}}}}) + "\\n") });\n', { mode: 0o755 })
    process.env.PATH = `${directory}:${previousPath ?? ""}`
    const ctx = {
      hasUI: true,
      model: { provider: "openai-codex" },
      modelRegistry: { isUsingOAuth: () => true },
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus: (key: string, text: string | undefined) => {
          if (text === undefined) statuses.delete(key)
          else statuses.set(key, text)
        },
      },
    }
    codexUsageExtension({
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerCommand: () => {},
    } as any)
    await handlers.get("session_start")!({}, ctx)
    assert.equal(statuses.get("codex-usage"), "Codex used 5h:12%")
    statuses.clear()
    await handlers.get("turn_end")!({}, ctx)
    assert.equal(statuses.get("codex-usage"), "Codex used 5h:12%")
    ctx.model.provider = "other"
    await handlers.get("model_select")!({}, ctx)
    assert.equal(statuses.has("codex-usage"), false)
    ctx.model.provider = "openai-codex"
    await handlers.get("model_select")!({}, ctx)
    assert.equal(statuses.get("codex-usage"), "Codex used 5h:12%")
    await handlers.get("session_shutdown")!({}, ctx)
    assert.equal(statuses.has("codex-usage"), false)
    ctx.hasUI = false
    await handlers.get("turn_end")!({}, ctx)
    assert.equal(statuses.has("codex-usage"), false)
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(directory, { recursive: true, force: true })
  }
})
