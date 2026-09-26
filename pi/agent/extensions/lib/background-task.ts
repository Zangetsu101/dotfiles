import { execFile } from "node:child_process"
import { mkdtemp, open, readFile, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
export const BACKGROUND_TASK_CREATED = "pi:background-task-created"
export const BACKGROUND_TASK_STATUS_CHANGED = "pi:background-task-status-changed"
export type TaskKind = "monitor" | "agent"
export type TaskStatus = "running" | "succeeded" | "failed" | "terminated" | "interrupted"
export type TaskQuery = { familyId: string } | { subtreeRootId: string }
export type BackgroundTask = {
  id: string
  familyId?: string
  rootId?: string
  kind: TaskKind
  label: string
  displayName?: string
  status: TaskStatus
  target: string
  parent: string
  parentId?: string
  parentTarget?: string
  rootPane?: string
  poolWindow?: string
  cwd: string
  statusFile: string
  outputFile?: string
  storageMode?: "family"
}
export type TaskCompletion = {
  status: "completed" | "failed" | "cancelled"
  exitCode?: number
  signal?: string
  reason?: string
}
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
    return (await execFileAsync("tmux", args, { encoding: "utf8" })).stdout.trim()
  },
}
export function safeTaskLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "task"
}
function siblingOrdinal(task: BackgroundTask, label: string): number {
  const localName = (task.displayName ?? task.label).replace(/ ← .*$/, "")
  if (localName === label) return 1
  const suffix = localName.startsWith(`${label} (`) ? Number.parseInt(localName.slice(label.length + 2, -1), 10) : 0
  return Number.isFinite(suffix) ? suffix : 0
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
export async function writeTaskCompletion(path: string, completion: TaskCompletionRecord): Promise<void> {
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temporary, JSON.stringify(completion), { encoding: "utf8", mode: 0o600 })
  await rename(temporary, path)
}

const locks = new Map<string, Promise<void>>()
async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  locks.set(key, queued)
  await previous
  try {
    return await operation()
  } finally {
    release!()
    if (locks.get(key) === queued) locks.delete(key)
  }
}

type CreateInput = {
  kind: TaskKind
  label: string
  cwd: string
  command: string
  args: string[]
  familyId?: string
  familyName?: string
  rootId?: string
  rootPane?: string
  parentId?: string
  parentLabel?: string
  parentTarget?: string
  parent?: string
  remainOnExit?: boolean
  interactiveAfterExit?: boolean
  statusFileEnv?: string
  env?: Record<string, string>
  metadata?: Record<string, string>
}
const keys = ["kind", "id", "label", "display_name", "status", "parent", "parent_id", "parent_target", "family_id", "root_id", "root_pane", "pool_window", "cwd", "status_file", "output_file"] as const

export class BackgroundTasks {
  private readonly tmux: TmuxProcessAdapter
  private readonly known = new Map<string, BackgroundTask>()
  private readonly sessions = new Map<string, string>()
  private readonly pools = new Map<string, Array<{ window: string; count: number }>>()
  constructor(tmux: TmuxProcessAdapter = systemTmux) {
    this.tmux = tmux
  }

  remember(task: BackgroundTask): void {
    this.known.set(task.id, task)
  }

  private async withFamilyLock<T>(familyId: string, operation: () => Promise<T>): Promise<T> {
    const lock = `pi-task-family:${familyId}`
    try {
      await this.tmux.run(["wait-for", "-L", lock])
    } catch {
      return operation()
    }
    try {
      return await operation()
    } finally {
      await this.tmux.run(["wait-for", "-U", lock]).catch(() => undefined)
    }
  }

  private async nextSiblingOrdinal(session: string, parentId: string, label: string, siblings: BackgroundTask[]): Promise<{ key: string; ordinal: number; counters: Record<string, number> }> {
    const stored = await this.tmux.run(["show-options", "-v", "-t", session, "@pi_task_sibling_ordinals"]).catch(() => "")
    let counters: Record<string, number> = {}
    try { counters = JSON.parse(stored) as Record<string, number> } catch {}
    const key = JSON.stringify([parentId, label])
    const highest = Math.max(counters[key] ?? 0, ...siblings.map((task) => siblingOrdinal(task, label)))
    return { key, ordinal: highest + 1, counters }
  }

  private async commitSiblingOrdinal(session: string, allocation: { key: string; ordinal: number; counters: Record<string, number> }): Promise<void> {
    allocation.counters[allocation.key] = allocation.ordinal
    await this.tmux.run(["set-option", "-t", session, "@pi_task_sibling_ordinals", JSON.stringify(allocation.counters)])
  }

  async familyExists(familyId: string): Promise<boolean> {
    return Boolean(await this.familySession(familyId))
  }

  async available(): Promise<boolean> {
    try {
      await this.tmux.run(["-V"])
      return true
    } catch {
      return false
    }
  }

  async create(input: CreateInput): Promise<BackgroundTask> {
    const currentPane = process.env.TMUX_PANE ?? ""
    const familyId = input.familyId ?? process.env.PI_BACKGROUND_TASK_FAMILY_ID ?? `root-${process.pid}`
    return serialized(familyId, () => this.withFamilyLock(familyId, async () => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const directory = await mkdtemp(join(tmpdir(), `pi-background-task-${id}-`))
      const parentId = input.parentId ?? input.parent ?? input.rootId ?? familyId
      const rootId = input.rootId ?? familyId
      const rootPane = input.rootPane ?? currentPane
      let session = await this.familySession(familyId)
      let createdSession = false
      let target = ""
      let createdWindow = ""
      let poolWindow: string | undefined
      try {
        if (!session) {
          const name = await this.availableSessionName(input.familyName ?? familyId)
          session = await this.tmux.run(["new-session", "-d", "-P", "-F", "#{session_id}", "-s", name, "-n", "bootstrap", "/bin/sh", "-c", "exec sleep 2147483647"])
          session ||= name
          createdSession = true
          this.sessions.set(familyId, session)
          const metadata = [
            ["@pi_task_family_id", familyId],
            ["@pi_task_family_name", input.familyName ?? familyId],
            ["@pi_task_root_id", rootId],
            ["@pi_task_root_pane", rootPane],
          ]
          await Promise.all(metadata.map(([key, value]) => this.tmux.run(["set-option", "-t", session, key, value])))
        }
        const siblings = [...this.known.values()].filter((task) => task.familyId === familyId && task.parentId === parentId && task.label === input.label)
        const allocation = await this.nextSiblingOrdinal(session, parentId, input.label, siblings)
        const suffix = allocation.ordinal === 1 ? "" : ` (${allocation.ordinal})`
        const nested = parentId !== rootId
        const displayName = `${input.label}${suffix}${nested && input.parentLabel ? ` ← ${input.parentLabel}` : ""}`
        const ready = `pi-task-ready-${id}`
        const statusFile = join(directory, "completion.json")
        const outputFile = join(directory, "output.log")
        const environment = Object.entries({ PI_BACKGROUND_TASK_STATUS_FILE: statusFile, PI_BACKGROUND_TASK_PARENT: input.parentTarget ?? input.parent ?? rootPane, PI_BACKGROUND_TASK_PARENT_ID: parentId, PI_BACKGROUND_TASK_FAMILY_ID: familyId, PI_BACKGROUND_TASK_FAMILY_NAME: input.familyName ?? familyId, PI_BACKGROUND_TASK_ROOT_ID: rootId, PI_BACKGROUND_TASK_ROOT_PANE: rootPane, PI_BACKGROUND_TASK_ID: id, PI_BACKGROUND_TASK_LABEL: input.label, ...(input.statusFileEnv ? { [input.statusFileEnv]: statusFile } : {}), ...(input.env ?? {}) }).flatMap(([key, value]) => ["-e", `${key}=${value}`])
        const wrapper = ['status="$1"; output="$2"; ready="$3"; shift 3', 'tmux wait-for "$ready"', '"$@"', 'code=$?', 'state=completed; [ "$code" -eq 0 ] || state=failed', 'if [ ! -e "$status" ]; then', '  printf \'{"status":"%s","exitCode":%s}\\n\' "$state" "$code" > "$status.tmp"', '  mv "$status.tmp" "$status"', 'fi', input.interactiveAfterExit ? 'exec "${SHELL:-/bin/bash}" -l' : 'exit "$code"'].join("\n")
        if (input.kind === "agent") {
          target = await this.tmux.run(["new-window", "-d", "-P", "-F", "#{window_id}", "-t", session, "-n", displayName, "-c", input.cwd, ...environment, "/bin/bash", "-c", wrapper, "background-task", statusFile, outputFile, ready, input.command, ...input.args])
          target ||= `${session}:${displayName}`; createdWindow = target
        } else {
          let pool = (this.pools.get(familyId) ?? []).find((candidate) => candidate.count < 8)
          const createdPool = !pool
          if (!pool) {
            const number = (this.pools.get(familyId)?.length ?? 0) + 1
            const name = number === 1 ? "monitors" : `monitors (${number})`
            const window = await this.tmux.run(["new-window", "-d", "-P", "-F", "#{window_id}", "-t", session, "-n", name, "/bin/sh", "-c", "exec sleep 2147483647"])
            pool = { window: window || `${session}:${name}`, count: 0 }
            this.pools.set(familyId, [...(this.pools.get(familyId) ?? []), pool])
            createdWindow = pool.window
          }
          target = await this.tmux.run(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pool.window, "-c", input.cwd, ...environment, "/bin/bash", "-c", wrapper, "background-task", statusFile, outputFile, ready, input.command, ...input.args])
          pool.count++
          poolWindow = pool.window
          target ||= pool.window
          if (createdPool) await this.tmux.run(["kill-pane", "-t", `${pool.window}.0`]).catch(() => undefined)
        }
        const task: BackgroundTask = { id, familyId, rootId, kind: input.kind, label: input.label, displayName, status: "running", target, parent: parentId, parentId, parentTarget: input.parentTarget ?? input.parent ?? rootPane, rootPane, poolWindow, cwd: input.cwd, statusFile, outputFile, storageMode: "family" }
        const values: Record<(typeof keys)[number], string> = { kind: task.kind, id, label: task.label, display_name: displayName, status: "running", parent: parentId, parent_id: parentId, parent_target: task.parentTarget ?? "", family_id: familyId, root_id: rootId, root_pane: rootPane, pool_window: poolWindow ?? "", cwd: task.cwd, status_file: statusFile, output_file: outputFile }
        const scope = input.kind === "agent" ? "-w" : "-p"
        await Promise.all([
          ...keys.map((key) => this.tmux.run(["set-option", scope, "-t", target, `@pi_task_${key}`, values[key]])),
          ...Object.entries(input.metadata ?? {}).map(([key, value]) => this.tmux.run(["set-option", scope, "-t", target, key, value])),
          this.tmux.run(["pipe-pane", "-t", target, `cat >> ${shellQuote(outputFile)}`]),
          ...(input.kind === "monitor" ? [this.tmux.run(["select-pane", "-t", target, "-T", displayName])] : []),
        ])
        if (input.remainOnExit) await this.tmux.run(["set-option", "-p", "-t", target, "remain-on-exit", "on"])
        await this.tmux.run(["wait-for", "-S", ready])
        await this.commitSiblingOrdinal(session, allocation)
        this.known.set(id, task)
        if (createdSession) await this.tmux.run(["kill-window", "-t", `${session}:bootstrap`]).catch(() => undefined)
        return task
      } catch (error) {
        if (target) await this.tmux.run([input.kind === "agent" ? "kill-window" : "kill-pane", "-t", target]).catch(() => undefined)
        else if (createdWindow) await this.tmux.run(["kill-window", "-t", createdWindow]).catch(() => undefined)
        if (createdSession) await this.tmux.run(["kill-session", "-t", session]).catch(() => undefined)
        throw error
      }
    }))
  }

  private async familySession(familyId: string): Promise<string> {
    const output = await this.tmux.run(["list-sessions", "-F", "#{session_id}\t#{@pi_task_family_id}"]).catch(() => "")
    const session = output
      .split("\n")
      .map((line) => line.split("\t"))
      .find(([, id]) => id === familyId)?.[0] ?? ""
    if (session) this.sessions.set(familyId, session)
    else this.sessions.delete(familyId)
    return session
  }

  private async availableSessionName(label: string, current = ""): Promise<string> {
    const base = label.replace(/[.:]/g, "-").trim() || "pi tasks"
    const output = await this.tmux.run(["list-sessions", "-F", "#{session_name}"]).catch(() => "")
    const used = new Set(output.split("\n").filter((name) => name && name !== current))
    if (!used.has(base)) return base

    for (let suffix = 2; ; suffix++) {
      const candidate = `${base} (${suffix})`
      if (!used.has(candidate)) return candidate
    }
  }
  async reconcileFamily(family: { familyId: string; familyName: string; rootId: string; rootPane: string }): Promise<void> {
    const session = await this.familySession(family.familyId)
    if (!session) return
    await Promise.all([
      this.tmux.run(["set-option", "-t", session, "@pi_task_family_name", family.familyName]),
      this.tmux.run(["set-option", "-t", session, "@pi_task_root_id", family.rootId]),
      this.tmux.run(["set-option", "-t", session, "@pi_task_root_pane", family.rootPane]),
    ])
    for (const task of await this.list({ familyId: family.familyId })) {
      task.rootPane = family.rootPane
      if (task.parentId === family.rootId) task.parentTarget = family.rootPane
      this.known.set(task.id, task)
      const scope = task.kind === "agent" ? "-w" : "-p"
      await this.tmux.run(["set-option", scope, "-t", task.target, "@pi_task_root_pane", family.rootPane])
      if (task.parentId === family.rootId) await this.tmux.run(["set-option", scope, "-t", task.target, "@pi_task_parent_target", family.rootPane])
    }
  }
  async renameFamily(familyId: string, label: string): Promise<void> {
    const session = await this.familySession(familyId)
    if (!session) return
    const current = await this.tmux.run(["display-message", "-p", "-t", session, "#{session_name}"]).catch(() => "")
    const name = await this.availableSessionName(label, current)
    await Promise.all([
      this.tmux.run(["rename-session", "-t", session, name]),
      this.tmux.run(["set-option", "-t", session, "@pi_task_family_name", label]),
    ])
  }
  async renameNode(nodeId: string, label: string): Promise<void> {
    const familyId = (await this.list()).find((task) => task.id === nodeId)?.familyId
    if (!familyId) return
    await serialized(familyId, () => this.withFamilyLock(familyId, async () => {
      const all = await this.list({ familyId })
      const node = all.find((task) => task.id === nodeId)
      if (!node || node.label === label) return
      const session = await this.familySession(familyId)
      const siblings = all.filter((task) => task.id !== node.id && task.parentId === node.parentId && task.label === label)
      const allocation = await this.nextSiblingOrdinal(session, node.parentId ?? "", label, siblings)
      const suffix = allocation.ordinal === 1 ? "" : ` (${allocation.ordinal})`
      const parent = all.find((task) => task.id === node.parentId)
      node.label = label
      node.displayName = `${label}${suffix}${node.parentId !== node.rootId && parent ? ` ← ${parent.label}` : ""}`
      await this.renameTarget(node)
      for (const child of all.filter((task) => task.parentId === node.id)) {
        const ownName = (child.displayName ?? child.label).split(" ← ", 1)[0]
        child.displayName = `${ownName} ← ${label}`
        await this.renameTarget(child)
      }
      await this.commitSiblingOrdinal(session, allocation)
    }))
  }
  private async renameTarget(task: BackgroundTask): Promise<void> {
    const scope = task.kind === "agent" ? "-w" : "-p"
    await Promise.all([
      this.tmux.run([task.kind === "agent" ? "rename-window" : "select-pane", "-t", task.target, ...(task.kind === "monitor" ? ["-T"] : []), task.displayName ?? task.label]),
      this.tmux.run(["set-option", scope, "-t", task.target, "@pi_task_label", task.label]),
      this.tmux.run(["set-option", scope, "-t", task.target, "@pi_task_display_name", task.displayName ?? task.label]),
    ])
    this.known.set(task.id, task)
  }
  async list(query?: TaskQuery): Promise<BackgroundTask[]> {
    const format = (target: string) => `${target}\t${keys.map((key) => `#{@pi_task_${key}}`).join("\t")}`
    const [windows, panes] = await Promise.all([this.tmux.run(["list-windows", "-a", "-F", format("#{window_id}")]).catch(() => ""), this.tmux.run(["list-panes", "-a", "-F", format("#{pane_id}")]).catch(() => "")])
    const parse = (line: string): BackgroundTask | undefined => {
      const [target, ...fields] = line.split("\t")
      if (!target) return undefined
      const value = Object.fromEntries(keys.map((key, index) => [key, fields[index] ?? ""]))
      if (!value.id || !value.family_id || !value.root_id) return undefined
      return {
        id: value.id,
        familyId: value.family_id,
        rootId: value.root_id,
        kind: value.kind as TaskKind,
        label: value.label,
        displayName: value.display_name,
        status: value.status as TaskStatus,
        target,
        parent: value.parent,
        parentId: value.parent_id || value.parent,
        parentTarget: value.parent_target,
        rootPane: value.root_pane,
        poolWindow: value.pool_window || undefined,
        cwd: value.cwd,
        statusFile: value.status_file,
        outputFile: value.output_file || undefined,
        storageMode: "family",
      }
    }
    const discovered = [...windows.split("\n"), ...panes.split("\n")].filter(Boolean).map(parse).filter((task): task is BackgroundTask => Boolean(task))
    for (const task of discovered) this.known.set(task.id, task)
    const poolCounts = new Map<string, Map<string, number>>()
    for (const task of discovered) {
      if (task.kind !== "monitor" || !task.familyId || !task.poolWindow) continue
      const familyPools = poolCounts.get(task.familyId) ?? new Map<string, number>()
      familyPools.set(task.poolWindow, (familyPools.get(task.poolWindow) ?? 0) + 1)
      poolCounts.set(task.familyId, familyPools)
    }
    for (const [familyId, familyPools] of poolCounts) {
      this.pools.set(familyId, [...familyPools].map(([window, count]) => ({ window, count })))
    }
    const all = discovered.length ? discovered : [...this.known.values()]
    if (!query) return all
    if ("familyId" in query) return all.filter((task) => task.familyId === query.familyId)
    return all.filter((task) => this.inSubtree(task, query.subtreeRootId, all))
  }
  private inSubtree(task: BackgroundTask, root: string, all: BackgroundTask[]): boolean {
    let current: BackgroundTask | undefined = task
    const seen = new Set<string>()
    while (current && !seen.has(current.id)) {
      if (current.id === root || current.parentId === root) return true
      seen.add(current.id)
      const parentId: string | undefined = current.parentId
      current = all.find((candidate) => candidate.id === parentId)
    }
    return false
  }

  subtree(task: BackgroundTask, all: BackgroundTask[]): BackgroundTask[] {
    return all.filter((candidate) => candidate.id === task.id || this.inSubtree(candidate, task.id, all))
  }

  async navigateParent(task: BackgroundTask): Promise<"switched" | string | undefined> {
    return task.parentTarget ? this.attach({ target: task.parentTarget }) : undefined
  }

  async navigateReturn(task: BackgroundTask): Promise<"switched" | string | undefined> {
    const session = task.familyId ? await this.familySession(task.familyId) : ""
    const rootPane = session
      ? await this.tmux.run(["show-options", "-v", "-t", session, "@pi_task_root_pane"]).catch(() => "")
      : task.rootPane
    return rootPane ? this.attach({ target: rootPane }) : undefined
  }

  async setStatus(task: BackgroundTask, status: TaskStatus): Promise<void> {
    task.status = status
    this.known.set(task.id, task)
    const scope = task.kind === "monitor" ? "-p" : "-w"
    await this.tmux.run(["set-option", scope, "-t", task.target, "@pi_task_status", status]).catch(() => undefined)
  }

  async attach(task: Pick<BackgroundTask, "target">): Promise<"switched" | string> {
    if (!process.env.TMUX) return `tmux attach -t ${task.target}`
    await this.tmux.run(["switch-client", "-t", task.target])
    return "switched"
  }

  async terminate(task: BackgroundTask, reason = "terminated by user"): Promise<BackgroundTask[]> {
    const all = await this.list(task.familyId ? { familyId: task.familyId } : { subtreeRootId: task.parentId ?? task.id })
    const active = this.subtree(task, all).filter((candidate) =>
      candidate.status === "running" || (candidate.kind === "agent" && candidate.status !== "terminated" && candidate.status !== "interrupted"),
    )
    for (const current of active) {
      await writeTaskCompletion(current.statusFile, { status: "cancelled", reason })
      await this.tmux.run(["send-keys", "-t", current.target, "C-c"])
      if (current.kind === "agent") await this.tmux.run(["send-keys", "-t", current.target, "C-d"])
      await this.setStatus(current, "terminated")
    }
    return active
  }
  async cleanup(tasks: BackgroundTask[]): Promise<number> {
    let removed = 0
    const all = await this.list()
    for (const selected of tasks) {
      const branch = this.subtree(selected, all)
      if (branch.some((task) => task.status === "running")) continue

      for (const task of branch.reverse()) {
        try {
          await this.tmux.run([task.kind === "monitor" ? "kill-pane" : "kill-window", "-t", task.target])
          this.known.delete(task.id)
          if (task.kind === "monitor" && task.familyId) await this.releasePool(task, task.familyId)
          removed++
        } catch {}
      }
    }

    const familyIds = new Set(tasks.flatMap((task) => task.familyId ? [task.familyId] : []))
    for (const familyId of familyIds) {
      if ([...this.known.values()].some((task) => task.familyId === familyId)) continue
      const session = this.sessions.get(familyId)
      if (session) await this.tmux.run(["kill-session", "-t", session]).catch(() => undefined)
      this.sessions.delete(familyId)
    }
    return removed
  }

  private async releasePool(task: BackgroundTask, familyId: string): Promise<void> {
    const pools = this.pools.get(familyId) ?? []
    const pool = pools.find((candidate) => candidate.window === task.poolWindow)
    if (!pool || --pool.count > 0) return
    await this.tmux.run(["kill-window", "-t", pool.window]).catch(() => undefined)
    this.pools.set(familyId, pools.filter((candidate) => candidate !== pool))
  }

  async completion(task: Pick<BackgroundTask, "statusFile">): Promise<TaskCompletionRecord | undefined> {
    try {
      return JSON.parse(await readFile(task.statusFile, "utf8")) as TaskCompletionRecord
    } catch {
      return undefined
    }
  }

  async isPresent(task: Pick<BackgroundTask, "id">): Promise<boolean> {
    try {
      const [windows, panes] = await Promise.all([
        this.tmux.run(["list-windows", "-a", "-F", "#{@pi_task_id}"]),
        this.tmux.run(["list-panes", "-a", "-F", "#{@pi_task_id}"]),
      ])
      return [...windows.split("\n"), ...panes.split("\n")].includes(task.id)
    } catch (error) {
      if (/no server running|no sessions/i.test(error instanceof Error ? error.message : String(error))) return false
      throw error
    }
  }

  async claimCompletionOrReconcile(task: Pick<BackgroundTask, "id" | "statusFile">): Promise<TaskCompletionRecord | undefined> {
    let completion = await this.claimCompletionRecord(task)
    if (completion || await this.isPresent(task)) return completion
    await writeTaskCompletion(task.statusFile, { status: "cancelled", reason: "task target disappeared before reporting completion" })
    completion = await this.claimCompletionRecord(task)
    return completion
  }

  async claimCompletion(task: BackgroundTask): Promise<TaskCompletion | undefined> {
    return this.claimCompletionRecord(task) as Promise<TaskCompletion | undefined>
  }

  async claimCompletionRecord(task: Pick<BackgroundTask, "statusFile">): Promise<TaskCompletionRecord | undefined> {
    const completion = await this.completion(task)
    if (!completion) return undefined
    try {
      const claim = await open(`${task.statusFile}.notified`, "wx", 0o600)
      await claim.close()
      return completion
    } catch {
      return undefined
    }
  }

  async resolveReference(reference: string, query: TaskQuery): Promise<{ kind: "found"; task: BackgroundTask } | { kind: "unknown" } | { kind: "ambiguous" }> {
    const scoped = await this.list(query)
    const exact = scoped.find((task) => task.id === reference || task.target === reference)
    if (exact) return { kind: "found", task: exact }

    const normalized = reference.toLowerCase()
    const labels = scoped.filter((task) => task.label.toLowerCase() === normalized || safeTaskLabel(task.label) === normalized)
    if (labels.length === 1) return { kind: "found", task: labels[0]! }
    return { kind: labels.length > 1 ? "ambiguous" : "unknown" }
  }

  async resolve(reference: string, query: TaskQuery): Promise<BackgroundTask | undefined> {
    const result = await this.resolveReference(reference, query)
    return result.kind === "found" ? result.task : undefined
  }
}
