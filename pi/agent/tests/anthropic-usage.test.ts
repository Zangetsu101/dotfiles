import assert from "node:assert/strict"
import test from "node:test"
import anthropicUsageExtension from "../extensions/anthropic-usage.ts"

async function startSession(fetchImpl: typeof fetch) {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>()
  const statuses = new Map<string, string>()
  const colors = new Map<string, string>()
  const ctx = {
    hasUI: true,
    model: { provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "token" }),
    },
    ui: {
      theme: { fg: (color: string, text: string) => { colors.set(text, color); return text } },
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
  globalThis.fetch = fetchImpl
  await handlers.get("session_start")!({}, ctx)
  return { ctx, handlers, statuses, colors }
}

function usageResponse(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body))) as any
}

const previousFetch = globalThis.fetch
test.afterEach(() => { globalThis.fetch = previousFetch })

test("Anthropic usage updates and clears on model change and shutdown", async () => {
  const requests: { url: string; headers: Record<string, string> }[] = []
  const { ctx, handlers, statuses } = await startSession((async (url: string, init: any) => {
    requests.push({ url, headers: init.headers })
    return new Response(JSON.stringify({
      five_hour: { utilization: 12.4, resets_at: null },
      seven_day: { utilization: 40, resets_at: "2026-10-30T00:00:00Z" },
    }))
  }) as any)
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
})

test("Anthropic usage shows the 5h reset time and turns red at 75%", async () => {
  const resetsAt = "2026-10-24T15:30:00Z"
  const { statuses, colors } = await startSession(usageResponse({
    five_hour: { utilization: 80, resets_at: resetsAt },
    seven_day: { utilization: 10, resets_at: "2026-10-30T00:00:00Z" },
  }))
  const resetTime = new Date(resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  const status = `Claude used 5h:80% (resets ${resetTime}) 7d:10%`
  assert.equal(statuses.get("anthropic-usage"), status)
  assert.equal(colors.get(status), "error")
})

test("Anthropic usage shows a warning when the request fails", async () => {
  const { statuses } = await startSession((async () => new Response("nope", { status: 401 })) as any)
  assert.equal(statuses.get("anthropic-usage"), "Claude usage ?")
})
