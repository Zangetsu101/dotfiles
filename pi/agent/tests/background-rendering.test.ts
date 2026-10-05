import assert from "node:assert/strict"
import test from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"
import type { ExtensionAPI, Theme, ToolRenderContext } from "@earendil-works/pi-coding-agent"
import { backgroundMessageRenderer, backgroundToolRenderers, registerBackgroundMessages } from "../extensions/lib/background-rendering.ts"
import { notifyRunningTask } from "../extensions/lib/background-task-check-in.ts"
import type { BackgroundTask } from "../extensions/lib/background-task.ts"

const theme = { fg: (_token: string, text: string) => text } as Theme
const context: ToolRenderContext<undefined, Record<string, string>> = {
  args: { label: "研究 👩‍💻" }, toolCallId: "call", invalidate() {}, lastComponent: undefined,
  state: undefined, cwd: "/repo", executionStarted: true, argsComplete: true,
  isPartial: false, expanded: false, showImages: false, isError: false,
}
const guidance = "Review the result and report it to the user."
const message = {
  role: "custom", customType: "background-agent", display: true,
  content: `Background agent one (研究) finished its initial task.\nAttach with: tmux attach -t @1\n\nFinal output:\nDone\n\n${guidance}`,
  details: { label: "研究 👩‍💻", status: "completed", id: "one", target: "@1", output: "Done", attach: "tmux attach -t @1" },
}
type RenderMessage = Parameters<typeof backgroundMessageRenderer>[0]
const renderMessage = (value: unknown, expanded = false, palette = theme) => backgroundMessageRenderer(value as RenderMessage, { expanded, outputPad: 0 }, palette)!

test("variant A collapses messages to label/status and expands output and attach details without changing model content", () => {
  const before = structuredClone(message)
  const collapsed = renderMessage(message).render(100).join("\n")
  assert.match(collapsed, /background_agent · 研究 👩‍💻 · completed/)
  assert.doesNotMatch(collapsed, /Done|tmux|Review/)
  const expanded = renderMessage(message, true).render(100).join("\n")
  assert.match(expanded, /Done/)
  assert.match(expanded, /Task: one/)
  assert.match(expanded, /tmux attach -t @1/)
  assert.doesNotMatch(expanded, /Review the result/)
  assert.deepEqual(message, before)
  assert.ok(message.content.endsWith(guidance))
})

test("completion failures, cancellations, exit codes, and check-ins remain visible collapsed", () => {
  for (const status of ["completed", "failed", "terminated", "running"]) {
    const value = { ...message, customType: status === "running" ? "background-monitor-check-in" : "background-monitor", details: { ...message.details, status, exitCode: 1, elapsed: "3 minutes" } }
    const output = renderMessage(value).render(140).join("\n")
    assert.ok(output.includes(status))
    assert.match(output, /exit 1/)
    assert.match(output, /3 minutes/)
  }
})

test("legacy and malformed details render safely and strip only known trailing guidance", () => {
  for (const details of [undefined, null, {}, { label: 42 }]) {
    const output = renderMessage({ ...message, details }, true).render(100).join("\n")
    assert.match(output, /Done/)
    assert.doesNotMatch(output, /Review the result/)
  }
  const arbitrary = `Arbitrary output\n\n${guidance}`
  assert.match(renderMessage({ ...message, details: undefined, content: arbitrary }, true).render(100).join("\n"), /Review the result/)
  const content = `Earlier text: ${guidance}\nActual result`
  assert.match(renderMessage({ ...message, details: undefined, content }, true).render(100).join("\n"), /Review the result/)
  const checkIn = { ...message, details: undefined, customType: "background-agent-check-in", content: "Background agent one (check) status: running; elapsed: 1 minute.\nRecent output:\nwork\nUse background_task to inspect it or schedule another check-in." }
  assert.doesNotMatch(renderMessage(checkIn, true).render(100).join("\n"), /Use background_task/)
})

test("all background tools support collapsed, expanded, partial, error and legacy results", () => {
  for (const name of ["background_agent", "background_monitor", "background_task", "background_agent_message"]) {
    const renderer = backgroundToolRenderers(name)
    const result = { content: [{ type: "text" as const, text: "full output" }], details: { id: "one", label: "研究", target: "@1" } }
    const run = (expanded: boolean, isPartial = false, isError = false) => renderer.renderResult!(result, { expanded, isPartial }, theme, { ...context, isError }).render(100).join("\n")
    assert.match(run(false), name === "background_agent_message" ? /delivered/ : /started/)
    assert.doesNotMatch(run(false), /full output|tmux/)
    assert.match(run(true), /full output/)
    assert.match(run(true), /tmux attach -t @1/)
    assert.match(run(false, true), /running/)
    assert.match(run(false, false, true), /error/)
    const legacy = renderer.renderResult!({ content: [], details: undefined }, { expanded: true, isPartial: false }, theme, context)
    assert.ok(legacy.render(10).length)
    const call = renderer.renderCall!({ task: "long task\nsecret body", label: "研究" }, theme, context).render(100).join("\n")
    assert.doesNotMatch(call, /secret body/)
  }
})

test("expanded legacy tool results preserve arbitrary trailing instructions without mutating model content", () => {
  const renderer = backgroundToolRenderers("background_task")
  for (const suffix of [
    "\n\nReview the result and report it to the user.",
    "\n\nReview the result. When all background work has returned, provide the complete standalone result in your final turn, including any conclusions that remain unchanged.",
    "\nUse background_task to inspect it or schedule another check-in.",
  ]) {
    const result = { content: [{ type: "text" as const, text: `Task output${suffix}` }], details: undefined }
    const before = structuredClone(result)
    const output = renderer.renderResult!(result, { expanded: true, isPartial: false }, theme, context).render(400).join("\n")
    assert.match(output, /Task output/)
    assert.ok(output.includes(suffix.trim()))
    assert.deepEqual(result, before)
  }
  const result = { content: [{ type: "text" as const, text: `Quoted instruction: ${guidance}\nActual output` }], details: undefined }
  assert.match(renderer.renderResult!(result, { expanded: true, isPartial: false }, theme, context).render(120).join("\n"), /Review the result/)
})

test("legacy results retain their existing attach command", () => {
  const result = { content: [{ type: "text" as const, text: "Started\nAttach with: /task attach one" }], details: { id: "one", target: "@1" } }
  const output = backgroundToolRenderers("background_agent").renderResult!(result, { expanded: true, isPartial: false }, theme, context).render(120).join("\n")
  assert.match(output, /Attach: \/task attach one/)
  assert.doesNotMatch(output, /tmux attach/)
})

test("expanded inspection preserves quoted instructions and uses the producer's attach command", () => {
  const renderer = backgroundToolRenderers("background_task")
  const output = `Actual output\n\n${guidance}`
  const result = {
    content: [{ type: "text" as const, text: `Recent output:\n${output}` }],
    details: { id: "one", label: "research", target: "@1", status: "running", output, attach: "/task attach one" },
  }
  const rendered = renderer.renderResult!(result, { expanded: true, isPartial: false }, theme, { ...context, args: { action: "inspect", id: "one" } }).render(120).join("\n")
  assert.match(rendered, /Review the result and report it to the user\./)
  assert.match(rendered, /Attach: \/task attach one/)
  assert.doesNotMatch(rendered, /tmux attach/)
})

test("background_task calls identify actions while results supply complementary statuses", () => {
  const renderer = backgroundToolRenderers("background_task")
  for (const [action, status] of Object.entries({ list: "listed", inspect: "inspected", "check-in": "scheduled", terminate: "terminated" })) {
    const args = { action, id: "one" }
    const result = { content: [{ type: "text" as const, text: "output" }], details: undefined }
    const output = renderer.renderResult!(result, { expanded: false, isPartial: false }, theme, { ...context, args }).render(120).join("\n")
    const call = renderer.renderCall!(args, theme, { ...context, args }).render(120).join("\n")
    assert.ok(call.includes(`background_task · ${action} · one`))
    assert.equal(output.trim(), status)
    assert.doesNotMatch(output, /background_task|one/)
    const structured = { ...result, details: { status: action === "inspect" ? "failed" : status } }
    const rendered = renderer.renderResult!(structured, { expanded: false, isPartial: false }, theme, { ...context, args }).render(120).join("\n")
    assert.ok(rendered.includes(structured.details.status))
  }
})

test("rendering fits narrow and wide terminals and recalculates theme colors after invalidation", () => {
  let color = "\x1b[31m"
  const palette = { fg: (_token: string, text: string) => `${color}${text}\x1b[0m` } as Theme
  const components = [renderMessage(message, true, palette), backgroundToolRenderers("background_agent").renderResult!({ content: [{ type: "text", text: "研究 👩‍💻 ".repeat(20) }], details: {} }, { expanded: true, isPartial: true }, palette, context)]
  for (const component of components) {
    for (const width of [8, 20, 80]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`)
    assert.ok(component.render(80).join("\n").includes("\x1b[31m"))
    color = "\x1b[32m"
    component.invalidate()
    assert.ok(component.render(80).join("\n").includes("\x1b[32m"))
    color = "\x1b[31m"
  }
})

test("message renderer registration covers completion and check-in types", () => {
  const types: string[] = []
  for (const kind of ["agent", "monitor"] as const) registerBackgroundMessages({ registerMessageRenderer: (type: string) => { types.push(type) } }, kind)
  assert.deepEqual(types, ["background-agent", "background-agent-check-in", "background-monitor", "background-monitor-check-in"])
})

test("check-in producer retains model follow-up instructions but supplies an instruction-free UI", async () => {
  const task: BackgroundTask = { id: "one", kind: "monitor", label: "check", status: "running", target: "@1", statusFile: "/nonexistent-background-rendering-test", parentId: "root", parent: "root", cwd: "/repo" }
  let sent: Parameters<ExtensionAPI["sendMessage"]>[0] | undefined
  await notifyRunningTask({ sendMessage: (value) => { sent = value } }, { completion: async () => undefined, list: async () => [task] }, task, () => true)
  assert.ok(sent)
  assert.match(String(sent.content), /Use background_task to inspect it or schedule another check-in/)
  const before = structuredClone(sent)
  assert.doesNotMatch(renderMessage(sent, true).render(100).join("\n"), /Use background_task/)
  assert.deepEqual(sent, before)
})
