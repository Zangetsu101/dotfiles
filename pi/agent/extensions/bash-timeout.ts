import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash" && event.input.timeout === undefined) event.input.timeout = 120
  })

  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash" || !event.isError) return
    return {
      content: [...event.content, { type: "text", text: "If this was a timeout, cancellation and subprocess termination are not confirmed. Check for partial filesystem or external side effects before retrying; do not retry automatically. For a known longer command, use an explicit timeout or background_monitor." }],
      details: event.details,
      structuredContent: event.structuredContent,
    }
  })
}
