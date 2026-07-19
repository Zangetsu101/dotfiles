import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createAgentSession,
  DefaultResourceLoader,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"

const ROUTES = ["background_monitor", "bash", "background_agent"] as const
const DEFAULT_MODELS = [
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.6-terra",
]
const TIMEOUT_MS = 120_000
const here = dirname(fileURLToPath(import.meta.url))

type Route = (typeof ROUTES)[number]
type Scenario = {
  id: string
  prompt: string
  expected: Route | null
  tags: string[]
  rationale: string
  skip?: string
}
type ToolCall = {
  name: string
  input: unknown
}
type Trial = {
  model: string
  scenarioId: string
  repetition: number
  expected: Route | null
  toolCalls: ToolCall[]
  assistantText: string
  usage?: unknown
  status: "pass" | "fail" | "infra"
  error?: string
  durationMs: number
}

function values(flag: string): string[] {
  const result: string[] = []
  for (let i = 2; i < process.argv.length; i++) {
    const argument = process.argv[i]
    if (argument === flag && process.argv[i + 1]) result.push(...process.argv[++i].split(","))
    else if (argument.startsWith(`${flag}=`)) result.push(...argument.slice(flag.length + 1).split(","))
  }
  return result.filter(Boolean)
}

function has(flag: string): boolean {
  return process.argv.slice(2).includes(flag)
}

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ type?: string; text?: string }> }).content ?? []
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")
}

async function trial(
  modelName: string,
  scenario: Scenario,
  repetition: number,
  cwd: string,
  modelRuntime: ModelRuntime,
): Promise<Trial> {
  const started = Date.now()
  const toolCalls: ToolCall[] = []
  let assistantText = ""
  let usage: unknown
  let capturedAssistant = false
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined
  let timer: NodeJS.Timeout | undefined

  try {
    const slash = modelName.indexOf("/")
    if (slash < 1) throw new Error(`Invalid model name: ${modelName}`)
    const model = modelRuntime.getModel(modelName.slice(0, slash), modelName.slice(slash + 1))
    if (!model) throw new Error(`Model not found: ${modelName}`)

    const evaluator: InlineExtension = {
      name: "background-monitor-evaluator",
      factory: (pi) => {
        pi.on("message_end", (event) => {
          if (event.message.role !== "assistant" || capturedAssistant) return
          capturedAssistant = true
          assistantText = textOf(event.message)
          usage = (event.message as { usage?: unknown }).usage
        })
        pi.on("tool_call", (event, ctx) => {
          toolCalls.push({ name: event.toolName, input: event.input })
          if (!capturedAssistant) {
            const branch = ctx.sessionManager.getBranch() as Array<{ type?: string; message?: unknown }>
            const last = [...branch].reverse().find((entry) => entry.type === "message")
            if (last?.message) {
              capturedAssistant = true
              assistantText = textOf(last.message)
              usage = (last.message as { usage?: unknown }).usage
            }
          }
          queueMicrotask(() => ctx.abort())
          return { block: true, reason: "Evaluator blocked execution after recording the first assistant turn." }
        })
      },
    }

    const agentDir = join(homedir(), ".pi", "agent")
    const settingsManager = SettingsManager.create(cwd, agentDir)
    settingsManager.applyOverrides({ retry: { enabled: false }, compaction: { enabled: false } })
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [evaluator],
    })
    await resourceLoader.reload()
    const created = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime,
      thinkingLevel: "low",
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
    })
    session = created.session
    if (created.extensionsResult.errors.length > 0) {
      throw new Error(`Extension load failed: ${created.extensionsResult.errors.map((item) => item.error).join("; ")}`)
    }

    await Promise.race([
      session.prompt(scenario.prompt),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("INFRA_TIMEOUT")), TIMEOUT_MS)
      }),
    ])

    const expectedTools = scenario.expected === null ? [] : [scenario.expected]
    const observed = toolCalls.map((call) => call.name)
    const pass = observed.length === expectedTools.length && observed.every((tool, index) => tool === expectedTools[index])
    return {
      model: modelName, scenarioId: scenario.id, repetition, expected: scenario.expected,
      toolCalls, assistantText, usage, status: pass ? "pass" : "fail", durationMs: Date.now() - started,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const infra = message === "INFRA_TIMEOUT" || toolCalls.length === 0 && !capturedAssistant && /auth|credential|api key|network|fetch|model not found/i.test(message)
    return {
      model: modelName, scenarioId: scenario.id, repetition, expected: scenario.expected,
      toolCalls, assistantText, usage, status: infra ? "infra" : "fail", error: message, durationMs: Date.now() - started,
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (session?.isStreaming) await session.abort().catch(() => undefined)
    session?.dispose()
  }
}

function printReport(trials: Trial[]): void {
  for (const model of [...new Set(trials.map((item) => item.model))]) {
    const rows = trials.filter((item) => item.model === model)
    const scored = rows.filter((item) => item.status !== "infra")
    const passed = scored.filter((item) => item.status === "pass").length
    console.log(`\n${model}: ${passed}/${scored.length} (${scored.length ? (100 * passed / scored.length).toFixed(1) : "n/a"}%), infra ${rows.length - scored.length}`)
    for (const route of [...ROUTES, null]) {
      const routeRows = scored.filter((item) => item.expected === route)
      const routePassed = routeRows.filter((item) => item.status === "pass").length
      console.log(`  ${route ?? "no-tool"}: ${routePassed}/${routeRows.length}`)
    }
    const confusion = new Map<string, number>()
    for (const row of scored) {
      const observed = row.toolCalls.map((call) => call.name)
      const key = `${row.expected ?? "no-tool"} -> ${observed.join("+") || "no-tool"}`
      confusion.set(key, (confusion.get(key) ?? 0) + 1)
    }
    console.log("  confusion:")
    for (const [key, count] of confusion) console.log(`    ${key}: ${count}`)
    const failures = rows.filter((item) => item.status !== "pass")
    if (failures.length) {
      console.log("  failures:")
      for (const item of failures) {
        const observed = item.toolCalls.map((call) => call.name)
        console.log(`    ${item.scenarioId} #${item.repetition}: ${item.status} expected=${item.expected ?? "no-tool"} observed=${observed.join("+") || "no-tool"}${item.error ? ` (${item.error})` : ""}`)
      }
    }
  }
}

async function main(): Promise<void> {
  if (has("--help")) {
    console.log("Usage: npm run eval:background-monitor -- [--mode smoke|full] [--repetitions N] [--model NAME] [--scenario ID] [--enforce]")
    return
  }
  const scenarios = JSON.parse(await readFile(join(here, "scenarios.json"), "utf8")) as Scenario[]
  const modelFilters = values("--model")
  const scenarioFilters = values("--scenario")
  const models = modelFilters.length ? DEFAULT_MODELS.filter((name) => modelFilters.some((filter) => name.includes(filter))) : DEFAULT_MODELS
  const matching = scenarioFilters.length ? scenarios.filter((scenario) => scenarioFilters.some((filter) => scenario.id.includes(filter) || scenario.tags.includes(filter))) : scenarios
  const skipped = matching.filter((scenario) => scenario.skip)
  const selected = matching.filter((scenario) => !scenario.skip)
  const mode = values("--mode")[0] ?? (has("--full") ? "full" : "smoke")
  if (mode !== "smoke" && mode !== "full") throw new Error(`Invalid mode: ${mode}`)
  const repetitionsValue = values("--repetitions")[0]
  const repetitions = repetitionsValue ? Number.parseInt(repetitionsValue, 10) : mode === "full" ? 5 : 1
  if (!models.length || !selected.length || !Number.isInteger(repetitions) || repetitions < 1) throw new Error("Filters selected nothing or repetitions is invalid")

  for (const scenario of skipped) console.log(`[skip] ${scenario.id}: ${scenario.skip}`)

  const fixture = await mkdtemp(join(tmpdir(), "pi-background-monitor-eval-"))
  const modelRuntime = await ModelRuntime.create()
  const trials: Trial[] = []
  try {
    for (const model of models) for (const scenario of selected) for (let repetition = 1; repetition <= repetitions; repetition++) {
      console.log(`[${trials.length + 1}/${models.length * selected.length * repetitions}] ${model} ${scenario.id} #${repetition}`)
      trials.push(await trial(model, scenario, repetition, fixture, modelRuntime))
    }
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }

  const generatedAt = new Date().toISOString()
  const output = resolve(here, "..", "results", `${generatedAt.replace(/[:.]/g, "-")}.json`)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify({ generatedAt, repetitions, timeoutMs: TIMEOUT_MS, models, scenarios: selected, skipped, trials }, null, 2) + "\n")
  printReport(trials)
  console.log(`\nJSON: ${output}`)

  const failedThreshold = models.some((model) => selected.some((scenario) => {
    const scored = trials.filter((item) => item.model === model && item.scenarioId === scenario.id && item.status !== "infra")
    const threshold = Math.ceil(scored.length * 0.8)
    return scored.length > 0 && scored.filter((item) => item.status === "pass").length < threshold
  }))
  if (has("--enforce") && failedThreshold) process.exitCode = 1
}

await main()
