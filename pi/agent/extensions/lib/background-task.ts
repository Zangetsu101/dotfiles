import { execFile } from "node:child_process"
import { mkdtemp, open, readFile, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
export const BACKGROUND_TASK_CREATED = "pi:background-task-created"
export type TaskKind = "monitor" | "agent"
export type TaskStatus = "running" | "completed" | "failed" | "cancelled"
export type BackgroundTask = { id: string; kind: TaskKind; label: string; status: TaskStatus; target: string; owner: string; parent: string; cwd: string; statusFile: string; outputFile?: string; storageMode?: "hub" | "legacy" }
export type TaskCompletion = { status: Exclude<TaskStatus, "running">; exitCode?: number; signal?: string; reason?: string }
export type AgentTaskCompletion = { kind: "settled" | "exit"; output?: string; exitCode?: number; stopReason?: string }
export type TaskCompletionRecord = TaskCompletion | AgentTaskCompletion
export interface TmuxProcessAdapter { run(args: string[]): Promise<string> }
export const systemTmux: TmuxProcessAdapter = { async run(args) { return (await execFileAsync("tmux", args, { encoding: "utf8" })).stdout.trim() } }
export function safeTaskLabel(label: string): string { return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "task" }
function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'` }
export async function writeTaskCompletion(path: string, completion: TaskCompletionRecord): Promise<void> { const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`; await writeFile(temporary, JSON.stringify(completion), { encoding: "utf8", mode: 0o600 }); await rename(temporary, path) }

const ownerLocks = new Map<string, Promise<void>>()
async function serialized<T>(owner: string, operation: () => Promise<T>): Promise<T> {
  const previous = ownerLocks.get(owner) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  ownerLocks.set(owner, queued)
  await previous
  try { return await operation() } finally { release(); if (ownerLocks.get(owner) === queued) ownerLocks.delete(owner) }
}

export class BackgroundTasks {
  private readonly tmux: TmuxProcessAdapter
  constructor(tmux: TmuxProcessAdapter = systemTmux) { this.tmux = tmux }
  async available(): Promise<boolean> { try { await this.tmux.run(["-V"]); return true } catch { return false } }

  async create(input: { kind: TaskKind; label: string; cwd: string; command: string; args: string[]; owner?: string; parent?: string; remainOnExit?: boolean; interactiveAfterExit?: boolean; statusFileEnv?: string; env?: Record<string, string>; metadata?: Record<string, string> }): Promise<BackgroundTask> {
    const owner = input.owner ?? process.env.TMUX_PANE ?? ""
    return serialized(owner, async () => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const directory = await mkdtemp(join(tmpdir(), `pi-background-task-${id}-`))
      let hub = ""; let createdHub = false; let target = ""
      try {
        const hubs = await this.tmux.run(["list-sessions", "-F", "#{session_name}\t#{@pi_task_hub_id}\t#{@pi_task_hub_owner}"]).catch(() => "")
        hub = hubs.split("\n").filter(Boolean).map((line) => line.split("\t")).find(([, hubId, hubOwner]) => hubId && hubOwner === owner)?.[0] ?? ""
        if (!hub) {
          const hubId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          hub = `pi-tasks-${safeTaskLabel(owner)}-${hubId.slice(-6)}`
          await this.tmux.run(["new-session", "-d", "-s", hub, "-n", "bootstrap", "/bin/sh", "-c", "exec sleep 2147483647"])
          createdHub = true
          await this.tmux.run(["set-option", "-t", hub, "@pi_task_hub_id", hubId])
          await this.tmux.run(["set-option", "-t", hub, "@pi_task_hub_owner", owner])
        }
        const window = `${input.kind}-${safeTaskLabel(input.label)}-${id.slice(-6)}`
        target = `${hub}:${window}`
        const task: BackgroundTask = { id, kind: input.kind, label: input.label, status: "running", target, owner, parent: input.parent ?? "", cwd: input.cwd, statusFile: join(directory, "completion.json"), outputFile: join(directory, "output.log"), storageMode: "hub" }
        const ready = `pi-task-ready-${id}`
        const environment = Object.entries({ PI_BACKGROUND_TASK_STATUS_FILE: task.statusFile, PI_BACKGROUND_TASK_PARENT: task.parent, ...(input.statusFileEnv ? { [input.statusFileEnv]: task.statusFile } : {}), ...(input.env ?? {}) }).flatMap(([key, value]) => ["-e", `${key}=${value}`])
        const wrapper = ['status="$1"; output="$2"; ready="$3"; shift 3', 'tmux wait-for "$ready"', '"$@"', 'code=$?', 'state=completed; [ "$code" -eq 0 ] || state=failed', 'if [ ! -e "$status" ]; then', '  printf \'{"status":"%s","exitCode":%s}\\n\' "$state" "$code" > "$status.tmp"', '  mv "$status.tmp" "$status"', 'fi', input.interactiveAfterExit ? 'exec "${SHELL:-/bin/bash}" -l' : 'exit "$code"'].join("\n")
        await this.tmux.run(["new-window", "-d", "-t", hub, "-n", window, "-c", input.cwd, ...environment, "/bin/bash", "-c", wrapper, "background-task", task.statusFile, task.outputFile!, ready, input.command, ...input.args])
        const metadata: Array<[string, string]> = [["kind", task.kind], ["id", id], ["label", task.label], ["status", "running"], ["owner", owner], ["parent", task.parent], ["cwd", task.cwd], ["status_file", task.statusFile], ["output_file", task.outputFile!]]
        await Promise.all([...metadata.map(([key, value]) => this.tmux.run(["set-option", "-w", "-t", target, `@pi_task_${key}`, value])), ...Object.entries(input.metadata ?? {}).map(([key, value]) => this.tmux.run(["set-option", "-w", "-t", target, key, value])), this.tmux.run(["pipe-pane", "-t", target, `cat >> ${shellQuote(task.outputFile!)}`])])
        if (input.remainOnExit) await this.tmux.run(["set-option", "-p", "-t", target, "remain-on-exit", "on"])
        await this.tmux.run(["set-option", "-w", "-t", target, "@pi_task_ready", ready])
        await this.tmux.run(["wait-for", "-S", ready])
        if (createdHub) await this.tmux.run(["kill-window", "-t", `${hub}:bootstrap`]).catch(() => undefined)
        return (await this.list(owner)).find((candidate) => candidate.id === id) ?? task
      } catch (error) {
        if (target) await this.tmux.run(["kill-window", "-t", target]).catch(() => undefined)
        if (createdHub) await this.tmux.run(["kill-session", "-t", hub]).catch(() => undefined)
        throw error
      }
    })
  }

  async list(owner?: string): Promise<BackgroundTask[]> {
    const format = "#{session_name}\t#{@pi_task_kind}\t#{@pi_task_id}\t#{@pi_task_label}\t#{@pi_task_status}\t#{@pi_task_owner}\t#{@pi_task_parent}\t#{@pi_task_cwd}\t#{@pi_task_status_file}\t#{@pi_task_output_file}\t#{@pi_task_hub_id}"
    const [windows, sessions] = await Promise.all([
      this.tmux.run(["list-windows", "-a", "-F", "#{session_name}:#{window_index}\t#{@pi_task_kind}\t#{@pi_task_id}\t#{@pi_task_label}\t#{@pi_task_status}\t#{@pi_task_owner}\t#{@pi_task_parent}\t#{@pi_task_cwd}\t#{@pi_task_status_file}\t#{@pi_task_output_file}"]).catch(() => ""),
      this.tmux.run(["list-sessions", "-F", format]).catch(() => ""),
    ])
    const parse = (line: string, storageMode: "hub" | "legacy") => { const [target, kind, id, label, status, taskOwner, parent, cwd, statusFile, outputFile] = line.split("\t"); return { target, kind, id, label, status, owner: taskOwner, parent, cwd, statusFile, outputFile: outputFile || undefined, storageMode } as BackgroundTask }
    const current = windows.split("\n").filter(Boolean).map((line) => parse(line, "hub")).filter((task) => task.id)
    const legacy = sessions.split("\n").filter(Boolean).filter((line) => { const fields = line.split("\t"); return fields[2] && !fields[10] }).map((line) => parse(line, "legacy"))
    return [...current, ...legacy].filter((task) => owner === undefined || task.owner === owner)
  }
  async setStatus(task: BackgroundTask, status: TaskStatus): Promise<void> { task.status = status; await this.tmux.run(["set-option", "-w", "-t", task.target, "@pi_task_status", status]).catch(() => undefined) }
  async attach(task: Pick<BackgroundTask, "target"> & Partial<Pick<BackgroundTask, "storageMode">>): Promise<"switched" | string> { if (task.storageMode === "legacy") throw new Error("Legacy cleanup-only tasks cannot be attached"); if (!process.env.TMUX) return `tmux attach -t ${task.target}`; await this.tmux.run(["switch-client", "-t", task.target]); return "switched" }
  async terminate(task: BackgroundTask, reason = "terminated by user"): Promise<void> {
    if (task.storageMode === "legacy") return
    const current = (await this.list(task.owner)).find((candidate) => candidate.id === task.id && candidate.storageMode === "hub")
    if (!current || current.status !== "running") return
    await writeTaskCompletion(current.statusFile, { status: "cancelled", reason })
    await this.tmux.run(["send-keys", "-t", current.target, "C-c"])
    await this.setStatus(current, "cancelled")
  }
  async cleanup(tasks: BackgroundTask[]): Promise<number> {
    let removed = 0
    const owners = new Set(tasks.map((task) => task.owner))
    for (const selected of tasks) {
      const current = (await this.list(selected.owner)).find((candidate) => candidate.id === selected.id && candidate.storageMode === selected.storageMode)
      if (!current || (current.storageMode === "hub" && current.status === "running")) continue
      try {
        await this.tmux.run(current.storageMode === "legacy" ? ["kill-session", "-t", current.target] : ["kill-window", "-t", current.target])
        removed++
      } catch {}
    }
    const remaining = await this.list()
    const hubs = await this.tmux.run(["list-sessions", "-F", "#{session_name}\t#{@pi_task_hub_id}\t#{@pi_task_hub_owner}"]).catch(() => "")
    for (const line of hubs.split("\n").filter(Boolean)) {
      const [hub, hubId, hubOwner] = line.split("\t")
      if (!hubId || !owners.has(hubOwner!) || remaining.some((task) => task.target.startsWith(`${hub}:`))) continue
      await this.tmux.run(["kill-session", "-t", hub!]).catch(() => undefined)
    }
    return removed
  }
  async completion(task: BackgroundTask): Promise<TaskCompletion | undefined> { try { return JSON.parse(await readFile(task.statusFile, "utf8")) as TaskCompletion } catch { return undefined } }
  async claimCompletion(task: BackgroundTask): Promise<TaskCompletion | undefined> { return this.claimCompletionRecord(task) as Promise<TaskCompletion | undefined> }
  async claimCompletionRecord(task: Pick<BackgroundTask, "statusFile">): Promise<TaskCompletionRecord | undefined> { let completion: TaskCompletionRecord; try { completion = JSON.parse(await readFile(task.statusFile, "utf8")) as TaskCompletionRecord } catch { return undefined } try { const claim = await open(`${task.statusFile}.notified`, "wx", 0o600); await claim.close(); return completion } catch { return undefined } }
  async resolveReference(reference: string, owner: string): Promise<{ kind: "found"; task: BackgroundTask } | { kind: "unknown" } | { kind: "ambiguous" }> { const scoped = await this.list(owner); const exact = scoped.find((task) => task.id === reference || task.target === reference); if (exact) return { kind: "found", task: exact }; const normalized = reference.toLowerCase(); const labels = scoped.filter((task) => task.label.toLowerCase() === normalized || safeTaskLabel(task.label) === normalized); if (labels.length === 1) return { kind: "found", task: labels[0]! }; return { kind: labels.length > 1 ? "ambiguous" : "unknown" } }
  async resolve(reference: string, owner: string): Promise<BackgroundTask | undefined> { const result = await this.resolveReference(reference, owner); return result.kind === "found" ? result.task : undefined }
}
