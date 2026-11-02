import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { readAgentProgress, reportAgentProgress } from "./background-progress.ts"

export async function readProjectTrustBlocker(statusFile: string) {
  const report = (await readAgentProgress(statusFile))?.latest
  return report?.state === "blocked" && report.blocker === "project_trust" ? report : undefined
}

export function registerAgentStartup(pi: ExtensionAPI, statusFile: string, now: () => number): void {
  pi.on("project_trust", (_event, ctx) => {
    if (ctx.hasUI) {
      const select = ctx.ui.select
      // Pi 1.4 invokes this hook before saved decisions. Observe the actual
      // selector instead of treating every trust resolution as a blocker.
      ctx.ui.select = async (...args) => {
        try {
          await reportAgentProgress(statusFile, {
            state: "blocked",
            blocker: "project_trust",
            activity: "Waiting for project trust approval",
            help: `Attach to this agent and answer the project trust prompt for ${ctx.cwd}. Trust decisions require user approval; do not approve automatically.`,
            attention: true,
            at: now(),
          }).catch((error) => console.error("background agent startup:", error))
          return await select(...args)
        } finally {
          ctx.ui.select = select
        }
      }
    }
    return { trusted: "undecided" }
  })
  pi.on("session_start", async () => {
    if (await readProjectTrustBlocker(statusFile)) {
      await reportAgentProgress(statusFile, { state: "working", activity: "Starting assignment", at: now() })
    }
  })
}
