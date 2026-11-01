import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, rm } from "node:fs/promises"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { readAgentProgress, reportAgentProgress, type AgentProgress, type AgentReport } from "./background-progress.ts"
import { taskCompletionStatus, writeTaskCompletion, type BackgroundTask, type BackgroundTasks, type TaskCompletionRecord, type TaskStatus, type TmuxProcessAdapter } from "./background-task.ts"
import { BACKGROUND_ACTIVITY_FINISHED, BACKGROUND_ACTIVITY_STARTED } from "./background-activity.ts"
import { notifyRunningTask } from "./background-task-check-in.ts"
import type { createTaskCheckInScheduler } from "./task-check-in.ts"

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

type ParentAssignmentOptions = {
  tasks: BackgroundTasks
  tmux: TmuxProcessAdapter
  pi: Pick<ExtensionAPI, "events" | "sendMessage">
  checkIns: ReturnType<typeof createTaskCheckInScheduler>
  active: () => boolean
  current: () => boolean
  onProgress: (progress: AgentProgress | undefined) => Promise<void>
  onCompletion: (completion: TaskCompletionRecord, status: TaskStatus) => void
  onStatus: (status: TaskStatus) => void
}

export class ParentAssignment {
  private readonly agent: BackgroundTask
  private readonly options: ParentAssignmentOptions
  private readonly activity: { id: string; source: string; label: string }
  private settled: boolean
  private runtimeExit = false
  private consuming = false
  private dirty = false

  constructor(agent: BackgroundTask, options: ParentAssignmentOptions) {
    this.agent = agent
    this.options = options
    this.activity = { id: `background-agent:${agent.id}`, source: "background_agent", label: agent.label }
    this.settled = agent.status !== "running"
    if (!this.settled) options.pi.events.emit(BACKGROUND_ACTIVITY_STARTED, this.activity)
    void this.watchCheckIn()
  }

  get running(): boolean { return !this.settled }

  private watchCheckIn() {
    const { pi, tasks, checkIns, active } = this.options
    return checkIns.watch(this.agent.statusFile, () => notifyRunningTask(pi, tasks, this.agent, () => !this.settled && active()))
  }

  async reconcile(): Promise<void> {
    if (!this.options.active()) return
    this.dirty = true
    if (this.consuming) return
    this.consuming = true
    try {
      do {
        this.dirty = false
        if (this.settled) await this.checkSettled()
        else await this.consumeCompletion()
      } while (this.dirty && this.options.active())
    } finally {
      this.consuming = false
    }
  }

  private async checkSettled(): Promise<void> {
    const { tasks, active, current, pi } = this.options
    const agent = this.agent
    if (await tasks.pendingAssignmentCompletionPath(agent)) {
      await this.consumeCompletion()
      return
    }
    let completion = await tasks.completion(agent)
    if (completion && "kind" in completion && completion.kind !== "exit" && !await tasks.isPresent(agent)) {
      if (existsSync(`${agent.statusFile}.cleanup`)) return
      completion = { kind: "exit", reason: "agent session disappeared after reporting assignment completion" }
      await writeTaskCompletion(agent.statusFile, completion)
    }
    if (!current()) return
    if (completion) {
      if ("kind" in completion && completion.kind === "exit" && !this.runtimeExit) {
        this.runtimeExit = true
        this.settled = false
        await this.consumeCompletion()
        this.settled = true
      }
      return
    }
    this.settled = false
    agent.status = "running"
    await tasks.setStatus(agent, "running")
    if (!active()) return
    await this.watchCheckIn()
    if (!active()) return
    pi.events.emit(BACKGROUND_ACTIVITY_STARTED, this.activity)
    await this.consumeCompletion()
  }

  private async consumeCompletion(): Promise<void> {
    const { tasks, tmux, pi, checkIns, active, current, onProgress, onCompletion, onStatus } = this.options
    const agent = this.agent
    const completion = await tasks.claimCompletionOrReconcile(agent)
    if (!current()) return
    const progress = completion ? undefined : await readAgentProgress(agent.statusFile).catch((error) => { console.error("background agent progress:", error); return undefined })
    if (!completion) await onProgress(progress)
    if (!completion || existsSync(`${agent.statusFile}.cleanup`)) return
    const agentCompletion = "kind" in completion
    const currentCompletion = await tasks.completion(agent)
    if (!active()) return
    this.settled = !agentCompletion || !completion.assignment || Boolean(currentCompletion && "kind" in currentCompletion && currentCompletion.assignment === completion.assignment)
    this.runtimeExit = agentCompletion && completion.kind === "exit"
    if (this.settled) {
      checkIns.stop(agent.statusFile)
      pi.events.emit(BACKGROUND_ACTIVITY_FINISHED, this.activity)
    }
    const status = taskCompletionStatus(completion)
    if (this.settled) await Promise.all([
      tmux.run(["set-option", "-w", "-t", agent.target, "@pi_agent_status", status === "terminated" ? "terminated" : status === "failed" ? "failed" : "settled"]),
      tmux.run(["set-option", "-w", "-t", agent.target, "@pi_task_status", status]),
    ]).catch(() => undefined)
    if (!current()) return
    if (this.settled) {
      agent.status = status
      onStatus(status)
    }
    if (!current()) return
    onCompletion(completion, status)
  }
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
