import { execFile } from "node:child_process"
import { mkdtemp, open, readFile, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type TaskKind = "monitor" | "agent"
export type TaskStatus = "running" | "completed" | "failed" | "cancelled"
export type BackgroundTask = {
  id: string
  kind: TaskKind
  label: string
  status: TaskStatus
  target: string
  owner: string
  parent: string
  cwd: string
  statusFile: string
  outputFile?: string
}
export type TaskCompletion = { status: Exclude<TaskStatus, "running">; exitCode?: number; signal?: string; reason?: string }
export type AgentTaskCompletion = {
  kind: "settled" | "exit"
  output?: string
  exitCode?: number
  stopReason?: string
}
export type TaskCompletionRecord = TaskCompletion | AgentTaskCompletion

export interface TmuxProcessAdapter {
  run(args: string[]): Promise<string>
}

export const systemTmux: TmuxProcessAdapter = {
  async run(args) {
    const result = await execFileAsync("tmux", args, { encoding: "utf8" })
    return result.stdout.trim()
  },
}

export function safeTaskLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "task"
}

export async function writeTaskCompletion(path: string, completion: TaskCompletionRecord): Promise<void> {
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temporary, JSON.stringify(completion), { encoding: "utf8", mode: 0o600 })
  await rename(temporary, path)
}

export class BackgroundTasks {
  private readonly tmux: TmuxProcessAdapter

  constructor(tmux: TmuxProcessAdapter = systemTmux) {
    this.tmux = tmux
  }

  async available(): Promise<boolean> {
    try { await this.tmux.run(["-V"]); return true } catch { return false }
  }

  async create(input: { kind: TaskKind; label: string; cwd: string; command: string; args: string[]; owner?: string; parent?: string; remainOnExit?: boolean; interactiveAfterExit?: boolean; statusFileEnv?: string; env?: Record<string, string>; metadata?: Record<string, string> }): Promise<BackgroundTask> {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const target = `pi-${input.kind}-${safeTaskLabel(input.label)}-${id}`
    const directory = await mkdtemp(join(tmpdir(), `pi-background-task-${id}-`))
    const task: BackgroundTask = { id, kind: input.kind, label: input.label, status: "running", target, owner: input.owner ?? process.env.TMUX_PANE ?? "", parent: input.parent ?? "", cwd: input.cwd, statusFile: join(directory, "completion.json"), outputFile: join(directory, "output.log") }
    const ready = `pi-task-ready-${id}`
    const environment = Object.entries({
      PI_BACKGROUND_TASK_STATUS_FILE: task.statusFile,
      PI_BACKGROUND_TASK_PARENT: task.parent,
      ...(input.statusFileEnv ? { [input.statusFileEnv]: task.statusFile } : {}),
      ...(input.env ?? {}),
    }).flatMap(([key, value]) => ["-e", `${key}=${value}`])
    const wrapper = [
      'status="$1"; output="$2"; ready="$3"; shift 3',
      'tmux wait-for "$ready"',
      'set -o pipefail',
      '"$@" 2>&1 | tee "$output"',
      'code=${PIPESTATUS[0]}',
      'state=completed; [ "$code" -eq 0 ] || state=failed',
      'if [ ! -e "$status" ]; then',
      '  printf \'{"status":"%s","exitCode":%s}\\n\' "$state" "$code" > "$status.tmp"',
      '  mv "$status.tmp" "$status"',
      'fi',
      input.interactiveAfterExit ? 'exec "${SHELL:-/bin/bash}" -l' : 'exit "$code"',
    ].join("\n")
    try {
      await this.tmux.run(["new-session", "-d", "-s", target, "-c", input.cwd, ...environment, "/bin/bash", "-c", wrapper, "background-task", task.statusFile, task.outputFile!, ready, input.command, ...input.args])
      const metadata: Array<[string, string]> = [["kind", task.kind], ["id", id], ["label", task.label], ["status", "running"], ["owner", task.owner], ["parent", task.parent], ["cwd", task.cwd], ["status_file", task.statusFile], ["output_file", task.outputFile ?? ""]]
      await Promise.all([
        ...metadata.map(([key, value]) => this.tmux.run(["set-option", "-t", target, `@pi_task_${key}`, value])),
        ...Object.entries(input.metadata ?? {}).map(([key, value]) => this.tmux.run(["set-option", "-t", target, key, value])),
      ])
      if (input.remainOnExit) await this.tmux.run(["set-option", "-t", target, "remain-on-exit", "on"])
      // The channel is metadata too: wrappers may wait until setup is durable.
      await this.tmux.run(["set-option", "-t", target, "@pi_task_ready", ready])
      await this.tmux.run(["wait-for", "-S", ready])
      return task
    } catch (error) {
      await this.tmux.run(["kill-session", "-t", target]).catch(() => undefined)
      throw error
    }
  }

  async list(owner?: string): Promise<BackgroundTask[]> {
    let output: string
    try { output = await this.tmux.run(["list-sessions", "-F", "#{session_name}\t#{@pi_task_kind}\t#{@pi_task_id}\t#{@pi_task_label}\t#{@pi_task_status}\t#{@pi_task_owner}\t#{@pi_task_parent}\t#{@pi_task_cwd}\t#{@pi_task_status_file}\t#{@pi_task_output_file}"]) } catch { return [] }
    return output.split("\n").filter(Boolean).map((line) => {
      const [target, kind, id, label, status, taskOwner, parent, cwd, statusFile, outputFile] = line.split("\t")
      return { target, kind, id, label, status, owner: taskOwner, parent, cwd, statusFile, outputFile: outputFile || undefined } as BackgroundTask
    }).filter((task) => task.id && (owner === undefined || task.owner === owner))
  }

  async setStatus(task: BackgroundTask, status: TaskStatus): Promise<void> {
    task.status = status
    await this.tmux.run(["set-option", "-t", task.target, "@pi_task_status", status]).catch(() => undefined)
  }

  async attach(task: Pick<BackgroundTask, "target">): Promise<"switched" | string> {
    if (!process.env.TMUX) return `tmux attach -t ${task.target}`
    await this.tmux.run(["switch-client", "-t", task.target]); return "switched"
  }

  async terminate(task: BackgroundTask, reason = "terminated by user"): Promise<void> {
    if (task.status !== "running") return
    // Record cancellation first so the command wrapper cannot overwrite it. Sending
    // C-c through tmux targets the pane's foreground process group, unlike killing
    // only the wrapper shell's pid.
    await writeTaskCompletion(task.statusFile, { status: "cancelled", reason })
    await this.tmux.run(["send-keys", "-t", task.target, "C-c"])
    await this.setStatus(task, "cancelled")
  }

  async cleanup(tasks: BackgroundTask[]): Promise<number> {
    const eligible = tasks.filter((task) => task.status !== "running")
    await Promise.all(eligible.map((task) => this.tmux.run(["kill-session", "-t", task.target]).catch(() => undefined)))
    return eligible.length
  }

  async completion(task: BackgroundTask): Promise<TaskCompletion | undefined> {
    try { return JSON.parse(await readFile(task.statusFile, "utf8")) as TaskCompletion } catch { return undefined }
  }

  /** Claim a completion once across extension reload races. */
  async claimCompletion(task: BackgroundTask): Promise<TaskCompletion | undefined> {
    const completion = await this.completion(task)
    if (!completion) return undefined
    try {
      const claim = await open(`${task.statusFile}.notified`, "wx", 0o600)
      await claim.close()
      return completion
    } catch { return undefined }
  }

  async resolve(reference: string, owner: string): Promise<BackgroundTask | undefined> {
    const scoped = await this.list(owner)
    const exact = scoped.find((task) => task.id === reference || task.target === reference)
    if (exact) return exact
    const normalized = reference.toLowerCase()
    const labels = scoped.filter((task) =>
      task.label.toLowerCase() === normalized || safeTaskLabel(task.label) === normalized,
    )
    return labels.length === 1 ? labels[0] : undefined
  }
}
