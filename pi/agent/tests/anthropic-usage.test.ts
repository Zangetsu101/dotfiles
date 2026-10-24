import assert from "node:assert/strict"
import test from "node:test"
import anthropicUsageExtension from "../extensions/anthropic-usage.ts"

test("Anthropic usage updates and clears on model change and shutdown", async () => {
  const previousFetch = globalThis.fetch
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>()
  const statuses = new Map<string, string>()
  const requests: { url: string; headers: Record<string, string> }[] = []
  try {
    globalThis.fetch = (async (url: string, init: any) => {
      requests.push({ url, headers: init.headers })
      return new Response(JSON.stringify({
        five_hour: { utilization: 12.4, resets_at: null },
        seven_day: { utilization: 40, resets_at: "2026-10-30T00:00:00Z" },
      }))
    }) as any
    const ctx = {
      hasUI: true,
      model: { provider: "anthropic" },
      modelRegistry: {
        isUsingOAuth: () => true,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "token" }),
      },
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus: (key: string, text: string | undefined) => {
          if (text === undefined) statuses.delete(key)
          else statuses.set(key, text)
        },
      },
    }
    anthropicUsageExtension({
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerCommand: () => {},
    } as any)
    await handlers.get("session_start")!({}, ctx)
    assert.equal(statuses.get("anthropic-usage"), "Claude used 5h:12% 7d:40%")
    assert.equal(requests[0].url, "https://api.anthropic.com/api/oauth/usage")
    assert.equal(requests[0].headers.Authorization, "Bearer token")
    assert.equal(requests[0].headers["anthropic-beta"], "oauth-2025-04-20")
    statuses.clear()
    await handlers.get("turn_end")!({}, ctx)
    assert.equal(statuses.get("anthropic-usage"), "Claude used 5h:12% 7d:40%")
    ctx.model.provider = "other"
    await handlers.get("model_select")!({}, ctx)
    assert.equal(statuses.has("anthropic-usage"), false)
    ctx.model.provider = "anthropic"
    await handlers.get("model_select")!({}, ctx)
    assert.equal(statuses.get("anthropic-usage"), "Claude used 5h:12% 7d:40%")
    await handlers.get("session_shutdown")!({}, ctx)
    assert.equal(statuses.has("anthropic-usage"), false)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("Anthropic usage shows a warning when the request fails", async () => {
  const previousFetch = globalThis.fetch
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>()
  const statuses = new Map<string, string>()
  try {
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as any
    const ctx = {
      hasUI: true,
      model: { provider: "anthropic" },
      modelRegistry: {
        isUsingOAuth: () => true,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "token" }),
      },
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus: (key: string, text: string | undefined) => {
          if (text === undefined) statuses.delete(key)
          else statuses.set(key, text)
        },
      },
    }
    anthropicUsageExtension({
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerCommand: () => {},
    } as any)
    await handlers.get("session_start")!({}, ctx)
    assert.equal(statuses.get("anthropic-usage"), "Claude usage ?")
  } finally {
    globalThis.fetch = previousFetch
  }
})
