import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { visibleWidth } from "@earendil-works/pi-tui"
import codexUsageExtension from "../extensions/codex-usage.ts"
import footerExtension from "../extensions/footer.ts"

test("Codex usage is the last footer line and clears on model change and shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-test-"))
  const previousPath = process.env.PATH
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>()
  const statuses = new Map<string, string>([["background-tasks", "tasks: 1 agent"]])
  let footer: { render: (width: number) => string[]; dispose: () => void } | undefined
  let disposed = false
  const pi = {
    on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: () => {},
    getSessionName: () => "demo",
    getThinkingLevel: () => "off",
  } as any
  try {
    await writeFile(join(directory, "codex"), '#!/usr/bin/env node\nprocess.stdin.on("data", () => { process.stdout.write(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:12,windowDurationMins:300,resetsAt:null}}}}) + "\\n") });\n', { mode: 0o755 })
    process.env.PATH = `${directory}:${previousPath}`
    const ctx = {
      mode: "tui", hasUI: true, cwd: "/repo",
      model: { provider: "openai-codex", id: "codex", contextWindow: 100000 },
      modelRegistry: { isUsingOAuth: () => true },
      sessionManager: { getEntries: () => [] },
      getContextUsage: () => ({ tokens: 1000, contextWindow: 100000, percent: 1 }),
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setWidget: () => assert.fail("Codex usage must not be an editor widget"),
        setStatus: (key: string, text: string | undefined) => {
          if (text === undefined) statuses.delete(key)
          else statuses.set(key, text)
        },
        setFooter: (factory: any) => {
          footer = factory({ requestRender() {} }, ctx.ui.theme, {
            getGitBranch: () => "main",
            getAvailableProviderCount: () => 1,
            getExtensionStatuses: () => statuses,
            onBranchChange: () => () => { disposed = true },
          })
        },
      },
    }
    const emit = async (name: string) => {
      for (const handler of handlers.get(name) ?? []) await handler({}, ctx)
    }
    codexUsageExtension(pi)
    footerExtension(pi)
    await emit("session_start")
    const lines = footer!.render(100)
    assert.equal(lines[0], "/repo (main) • demo")
    assert.match(lines[1]!, /1\.0k\/100k \(1\.0%\).*codex/)
    assert.deepEqual(lines.slice(2), ["tasks: 1 agent", "Codex used 5h:12%"])
    assert.ok(footer!.render(12).every((line) => visibleWidth(line) <= 12))
    statuses.delete("background-tasks")
    assert.equal(footer!.render(100).at(-1), "Codex used 5h:12%")
    ctx.model.provider = "other"
    await emit("model_select")
    assert.equal(footer!.render(100).length, 2)
    ctx.model.provider = "openai-codex"
    await emit("model_select")
    assert.equal(footer!.render(100).at(-1), "Codex used 5h:12%")
    await emit("session_shutdown")
    assert.equal(footer!.render(100).length, 2)
    ctx.hasUI = false
    await emit("turn_end")
    assert.equal(statuses.has("codex-usage"), false)
    footer!.dispose()
    assert.equal(disposed, true)
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(directory, { recursive: true, force: true })
  }
})
