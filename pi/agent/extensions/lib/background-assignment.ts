import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, rm } from "node:fs/promises"
import { readAgentProgress, reportAgentProgress, type AgentReport } from "./background-progress.ts"
import { writeTaskCompletion } from "./background-task.ts"

export async function withMailboxLock<T>(statusFile: string, operation: () => Promise<T>): Promise<T> {
  const lock = `${statusFile}.message-lock`
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 100) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  try { return await operation() } finally { await rm(lock, { recursive: true, force: true }) }
}

type AssignmentReport = Omit<AgentReport, "id" | "at" | "state"> & { state?: AgentReport["state"] }

export class BackgroundAssignment {
  private readonly statusFile: string
  private readonly now: () => number
  private readonly setRunning: () => Promise<void>
  private hasReport = false
  private assignmentCompleted: boolean
  private latest: AgentReport | undefined

  constructor(statusFile: string, options: { now?: () => number; setRunning: () => Promise<void> }) {
    this.statusFile = statusFile
    this.now = options.now ?? Date.now
    this.setRunning = options.setRunning
    this.assignmentCompleted = existsSync(statusFile)
  }

  get completed(): boolean { return this.assignmentCompleted }
  get needsInitialReport(): boolean { return !this.hasReport }
  get latestReport(): AgentReport | undefined { return this.latest }

  async settle(result: () => { output: string; stopReason?: string }, drainMailbox: () => Promise<void>): Promise<void> {
    if (this.assignmentCompleted) return
    await drainMailbox()
    await withMailboxLock(this.statusFile, async () => {
      if ((await readdir(`${this.statusFile}.messages`).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [] as string[]
        throw error
      })).some((name) => name.endsWith(".request"))) return
      this.assignmentCompleted = true
      const final = result()
      await writeTaskCompletion(this.statusFile, {
        kind: "settled",
        assignment: (await readAgentProgress(this.statusFile))?.assignment ?? randomUUID(),
        output: final.output,
        stopReason: final.stopReason,
      })
    })
  }

  async resume(): Promise<boolean> {
    if (!this.assignmentCompleted) return false
    await withMailboxLock(this.statusFile, async () => {
      await Promise.all([
        rm(this.statusFile, { force: true }),
        rm(`${this.statusFile}.notified`, { force: true }),
        rm(`${this.statusFile}.progress`, { force: true }),
        rm(`${this.statusFile}.check-in`, { force: true }),
        this.setRunning(),
      ])
      this.assignmentCompleted = false
      this.hasReport = false
      this.latest = undefined
    })
    return true
  }

  async report(report: AssignmentReport) {
    if (!report.activity.trim()) throw new Error("Activity must not be empty")
    const progress = await withMailboxLock(this.statusFile, async () => {
      if (this.assignmentCompleted) throw new Error("Assignment already completed; wait for follow-up work")
      const progress = await reportAgentProgress(this.statusFile, { ...report, activity: report.activity.trim(), state: report.state ?? "working", at: this.now() })
      if (progress.latest.state === "completed" || progress.latest.state === "failed") {
        await writeTaskCompletion(this.statusFile, { kind: "reported", outcome: progress.latest.state, assignment: progress.assignment, output: progress.latest.activity })
        this.assignmentCompleted = true
      }
      return progress
    })
    this.hasReport = true
    this.latest = progress.latest
    return progress
  }
}
