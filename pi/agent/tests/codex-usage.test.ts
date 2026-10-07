import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import codexUsageExtension from "../extensions/codex-usage.ts"

test("Codex usage has its own line below the editor and clears on model change and shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-test-"))
  const previousPath = process.env.PATH
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>()
  const widgets: Array<{ text: string[] | undefined; placement: string }> = []
  try {
    await writeFile(join(directory, "codex"), '#!/usr/bin/env node\nprocess.stdin.on("data", () => { process.stdout.write(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:12,windowDurationMins:300,resetsAt:null}}}}) + "\\n") });\n', { mode: 0o755 })
    process.env.PATH = `${directory}:${previousPath}`
    const ctx = {
      hasUI: true,
      model: { provider: "openai-codex" },
      modelRegistry: { isUsingOAuth: () => true },
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus: () => assert.fail("Codex usage must not share the footer statusline"),
        setWidget: (key: string, text: string[] | undefined, options: { placement: string }) => {
          assert.equal(key, "codex-usage")
          widgets.push({ text, placement: options.placement })
        },
      },
    }
    codexUsageExtension({ on: (name: string, handler: any) => handlers.set(name, handler), registerCommand: () => {} } as any)
    await handlers.get("session_start")!({}, ctx)
    assert.deepEqual(widgets, [
      { text: ["Codex usage …"], placement: "belowEditor" },
      { text: ["Codex used 5h:12%"], placement: "belowEditor" },
    ])
    ctx.model.provider = "other"
    await handlers.get("model_select")!({}, ctx)
    assert.equal(widgets.at(-1)!.text, undefined)
    ctx.model.provider = "openai-codex"
    await handlers.get("model_select")!({}, ctx)
    assert.deepEqual(widgets.at(-1)!.text, ["Codex used 5h:12%"])
    await handlers.get("session_shutdown")!({}, ctx)
    assert.equal(widgets.at(-1)!.text, undefined)
    ctx.hasUI = false
    const count = widgets.length
    await handlers.get("session_start")!({}, ctx)
    await handlers.get("session_shutdown")!({}, ctx)
    assert.equal(widgets.length, count)
  } finally {
    process.env.PATH = previousPath
    await rm(directory, { recursive: true, force: true })
  }
})
