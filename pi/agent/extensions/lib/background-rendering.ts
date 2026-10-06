import { keyText, type ExtensionAPI, type MessageRenderer, type ToolRenderers } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"

export type BackgroundMessageDetails = {
  label: string
  status: string
  id: string
  target: string
  output: string
  attach: string
  exitCode?: number
  elapsed?: string
  summary?: string
}

const textContent = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : ""
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {}
const string = (value: unknown): string => typeof value === "string" ? value : ""
const inline = (value: string) => value.replace(/[\r\n\t]/g, " ")
const actionStatuses: Record<string, string> = { list: "listed", inspect: "inspected", "check-in": "scheduled", terminate: "terminated" }
const expandHint = (expanded: boolean) => {
  const key = expanded ? "" : keyText("app.tools.expand")
  return key ? ` · ${key} to expand` : ""
}
const themedText = (content: () => string) => ({
  render: (width: number) => new Text(content(), 0, 0).render(width),
  invalidate() {},
})

export function backgroundToolRenderers(name: string): ToolRenderers {
  return {
    renderCall(input, theme, context) {
      const args = record(input)
      const label = string(args.label) || string(args.id) || string(args.action) || (name === "background_agent" ? string(args.task) : string(args.command)).split("\n")[0] || "task"
      const action = name === "background_task" ? string(args.action) : ""
      const heading = `${name}${action && action !== label ? ` · ${inline(action)}` : ""} · ${inline(label)}`
      const body = context.expanded ? string(args.task) || string(args.command) || string(args.message) : ""
      return themedText(() => theme.fg("toolTitle", heading) + (body ? `\n${theme.fg("toolOutput", body)}` : ""))
    },
    renderResult(result, options, theme, context) {
      const details = record(result.details)
      const args = record(context.args)
      const action = string(args.action)
      const defaultStatus = name === "background_task" ? actionStatuses[action] : name === "background_agent_message" ? "delivered" : "started"
      const status = context.isError ? "error" : options.isPartial ? "running" : string(details.status) || defaultStatus || "started"
      const heading = status
      const id = string(details.id)
      const target = string(details.target)
      const attach = string(details.attach) || textContent(result.content).match(/^Attach with: (.+)$/m)?.[1] || (target ? `tmux attach -t ${target}` : "")
      const extra = [id && `Task: ${id}`, target && `Tmux target: ${target}`, attach && `Attach: ${attach}`].filter(Boolean).join("\n")
      const content = textContent(result.content)
      const acknowledgement = name === "background_agent_message" && !context.isError && !options.isPartial && status === "delivered" && content === "delivered"
      const output = typeof details.output === "string" ? details.output : acknowledgement ? "" : content
      const body = options.expanded ? [output, extra].filter(Boolean).join("\n\n") : ""
      return themedText(() => theme.fg(context.isError || status === "error" ? "error" : options.isPartial ? "warning" : "muted", heading) + theme.fg("muted", expandHint(options.expanded)) + (body ? `\n${theme.fg("toolOutput", body)}` : ""))
    },
  }
}

function legacyBody(content: string, type: string): string {
  const suffix = type === "background-agent" && /^Background agent .+\nAttach with: .+\n\nFinal output:\n/.test(content)
    ? "\n\nReview the result and report it to the user."
    : type === "background-monitor" && /^Background monitor .+\nAttach with: .+\n\nOutput:\n/.test(content)
      ? "\n\nReview the result. When all background work has returned, provide the complete standalone result in your final turn, including any conclusions that remain unchanged."
      : /^background-(agent|monitor)-check-in$/.test(type) && /^Background (agent|monitor) .+ status: running; elapsed: .+\.\nRecent output:\n/.test(content)
        ? "\nUse background_task to inspect it or schedule another check-in."
        : ""
  return suffix && content.endsWith(suffix) ? content.slice(0, -suffix.length) : content
}

export const backgroundMessageRenderer: MessageRenderer<BackgroundMessageDetails> = (message, options, theme) => {
  const details = record(message.details)
  const raw = textContent(message.content)
  const structured = typeof details.label === "string" && typeof details.status === "string" && typeof details.output === "string"
  const checkIn = message.customType.endsWith("check-in")
  const name = checkIn ? "background check-in" : message.customType.replaceAll("-", "_")
  const status = string(details.status)
  const heading = structured
    ? `${name} · ${inline(string(details.label))} · ${status}${typeof details.exitCode === "number" ? ` · exit ${details.exitCode}` : ""}${details.elapsed ? ` · ${inline(string(details.elapsed))}` : ""}`
    : `${name} · ${inline(raw.split("\n")[0] || "result")}`
  const body = structured ? [string(details.summary), string(details.output), `Task: ${string(details.id)}`, `Tmux target: ${string(details.target)}`, string(details.attach) && `Attach: ${string(details.attach)}`].filter(Boolean).join("\n\n") : legacyBody(raw, message.customType)
  return themedText(() => theme.fg(status === "failed" || status === "terminated" ? "error" : checkIn ? "warning" : "success", heading) + theme.fg("muted", expandHint(options.expanded)) + (options.expanded ? `\n${theme.fg("toolOutput", body)}` : ""))
}

export function registerBackgroundMessages(pi: Pick<ExtensionAPI, "registerMessageRenderer">, kind: "agent" | "monitor") {
  pi.registerMessageRenderer(`background-${kind}`, backgroundMessageRenderer)
  pi.registerMessageRenderer(`background-${kind}-check-in`, backgroundMessageRenderer)
}
