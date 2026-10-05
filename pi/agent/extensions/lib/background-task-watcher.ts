import { watch, type FSWatcher } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { BackgroundTasks, systemTmux, taskMetadataDirectory, type BackgroundTask, type TaskMetadataOptions, type TaskQuery, type TmuxProcessAdapter } from "./background-task.ts"

const hooks = ["after-new-session", "after-new-window", "after-split-window", "after-set-option", "after-rename-window", "after-rename-session", "after-kill-pane", "window-unlinked", "pane-exited", "pane-died", "session-closed"]
const quote = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`
type Subscription = { query: TaskQuery; listener: (tasks: BackgroundTask[]) => void; signature?: string }

/** Shares filesystem events and tmux hooks across subscribers, without polling. */
export class BackgroundTaskWatcher {
  private readonly tasks: BackgroundTasks
  private readonly directory: string
  private readonly subscriptions = new Set<Subscription>()
  private watcher?: FSWatcher
  private queue: Promise<void> = Promise.resolve()
  private dirty = false
  private refreshQueued = false
  private generation = 0
  private readonly hookIndex = Math.floor(Math.random() * 1_000_000_000) + 1
  private readonly installed = new Set<string>()
  private server?: string
  private readonly tmux: TmuxProcessAdapter
  constructor(tmux: TmuxProcessAdapter = systemTmux, options: TaskMetadataOptions = {}) {
    this.tmux = tmux
    this.directory = options.metadataDirectory ?? taskMetadataDirectory
    this.tasks = new BackgroundTasks(tmux, options)
  }
  async watch(query: TaskQuery, listener: (tasks: BackgroundTask[]) => void): Promise<() => void> {
    const subscription: Subscription = { query, listener }
    if (!this.subscriptions.size) ++this.generation
    const generation = this.generation
    this.subscriptions.add(subscription)
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      this.subscriptions.delete(subscription)
      if (this.subscriptions.size) return
      ++this.generation
      this.watcher?.close()
      this.watcher = undefined
      // Finish old hook operations before a new generation installs its hooks.
      void this.enqueue(() => this.removeHooks())
    }
    try {
      await this.enqueue(async () => {
        if (generation !== this.generation) return
        if (!this.watcher) await this.openWatcher(generation)
        this.dirty = true
        await this.reconcile(generation)
      })
    } catch (error) { dispose(); throw error }
    return dispose
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }
  private async openWatcher(generation: number): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (generation !== this.generation) return
    const watcher = watch(this.directory, () => this.invalidate(generation))
    this.watcher = watcher
    watcher.on("error", error => {
      watcher.close()
      if (this.watcher !== watcher || generation !== this.generation) return
      this.watcher = undefined
      console.error("Background task watcher failed:", error)
      void this.enqueue(async () => {
        if (generation !== this.generation) return
        await this.openWatcher(generation)
        this.dirty = true
        await this.reconcile(generation)
      }).catch(error => console.error("Background task watcher recovery failed:", error))
    })
  }
  private async installHooks(generation: number): Promise<void> {
    const server = await this.tmux.run(["display-message", "-p", "#{pid}"]).catch(() => undefined)
    if (generation !== this.generation) return
    if (server !== this.server) {
      this.installed.clear()
      this.server = server
    }
    const command = `run-shell -b ${quote(`touch ${quote(join(this.directory, "tmux-invalidation"))}`)}`
    for (const hook of hooks) {
      if (generation !== this.generation) return
      if (this.installed.has(hook)) continue
      try {
        await this.tmux.run(["set-hook", "-g", `${hook}[${this.hookIndex}]`, command])
        this.installed.add(hook)
      } catch { /* No server yet, or an unsupported hook. The next event retries installation. */ }
    }
  }
  private async removeHooks(): Promise<void> {
    for (const hook of this.installed) {
      await this.tmux.run(["set-hook", "-gu", `${hook}[${this.hookIndex}]`]).catch(() => undefined)
      this.installed.delete(hook)
    }
  }
  private invalidate(generation: number): void {
    if (generation !== this.generation) return
    this.dirty = true
    if (this.refreshQueued) return
    this.refreshQueued = true
    void this.enqueue(async () => {
      this.refreshQueued = false
      await this.reconcile(generation)
    }).catch(error => console.error("Background task reconciliation failed:", error))
  }
  private async reconcile(generation: number): Promise<void> {
    if (!this.dirty || generation !== this.generation || !this.subscriptions.size) return
    this.dirty = false
    await this.installHooks(generation)
    if (generation !== this.generation) return
    const all = await this.tasks.list(undefined, true)
    if (generation !== this.generation) return
    for (const subscription of this.subscriptions) {
      if (generation !== this.generation) return
      const query = subscription.query
      const scoped = "familyId" in query
        ? all.filter(task => task.familyId === query.familyId)
        : this.tasks.subtree({ id: query.subtreeRootId }, all)
      const snapshot = scoped.map(task => ({ ...task })).sort((a, b) => a.id.localeCompare(b.id))
      const signature = JSON.stringify(snapshot)
      if (subscription.signature === signature) continue
      subscription.signature = signature
      try { subscription.listener(snapshot) } catch { /* Keep other subscribers running. */ }
    }
  }
}
export const sharedTaskMetadataWatcher = new BackgroundTaskWatcher()
