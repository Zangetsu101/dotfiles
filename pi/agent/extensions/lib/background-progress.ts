import { randomUUID } from "node:crypto"
import { readFile, rename, writeFile } from "node:fs/promises"

export type AgentReport = {
  activity: string
  state: "working" | "blocked" | "completed" | "failed"
  help?: string
  attention?: boolean
  at: number
  id: string
}
export type AgentProgress = { assignment: string; latest: AgentReport; history: AgentReport[] }

export async function readAgentProgress(statusFile: string): Promise<AgentProgress | undefined> {
  try { return JSON.parse(await readFile(`${statusFile}.progress`, "utf8")) as AgentProgress } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export async function reportAgentProgress(statusFile: string, report: Omit<AgentReport, "id">): Promise<AgentProgress> {
  const previous = await readAgentProgress(statusFile)
  const latest = { ...report, id: randomUUID() }
  const progress = { assignment: previous?.assignment ?? randomUUID(), latest, history: [...(previous?.history ?? []), latest].slice(-20) }
  const temporary = `${statusFile}.progress.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(progress), { mode: 0o600 })
  await rename(temporary, `${statusFile}.progress`)
  return progress
}

export function describeAgentProgress(progress: AgentProgress, now = Date.now()): string {
  const report = progress.latest
  const age = Math.max(0, Math.floor((now - report.at) / 1000))
  return `${report.state}: ${report.activity} (${age}s ago)${report.help ? `; help: ${report.help}` : ""}`
}
