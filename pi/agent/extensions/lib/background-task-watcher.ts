import { sharedDirectoryObservation } from "./directory-observation.ts"
import { join } from "node:path"
import { familyInvalidationFilename, BackgroundTasks, systemTmux, taskMetadataDirectory, type BackgroundTask, type TaskMetadataOptions, type TaskQuery, type TmuxProcessAdapter } from "./background-task.ts"

const hooks = ["after-new-session", "after-new-window", "after-split-window", "after-set-option", "after-rename-window", "after-rename-session", "after-kill-pane", "window-unlinked", "pane-exited", "pane-died", "session-closed"]
const quote = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`
type Subscription = { query: TaskQuery; listener: (tasks: BackgroundTask[]) => void; signature?: string; resolvedFamilyId?: string }

/** Shares directory invalidations and tmux hooks across task subscribers. */
export class BackgroundTaskWatcher {
  private readonly tasks: BackgroundTasks
  private readonly directory: string
  private readonly subscriptions = new Set<Subscription>()
  private stopObservation?: () => void
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
      this.stopObservation?.()
      this.stopObservation = undefined
      // Finish old hook operations before a new generation installs its hooks.
      void this.enqueue(() => this.removeHooks())
    }
    try {
      await this.enqueue(async () => {
        if (generation !== this.generation) return
        if (!this.stopObservation) {
          const stop = await sharedDirectoryObservation.watch(this.directory, filename => this.invalidate(generation, filename))
          if (generation !== this.generation) { stop(); return }
          this.stopObservation = stop
        }
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
  private async installHooks(generation: number): Promise<void> {
    const server = await this.tmux.run(["display-message", "-p", "#{pid}"]).catch(() => undefined)
    if (generation !== this.generation) return
    if (server !== this.server) {
      this.installed.clear()
      this.server = server
    }
    // Only a validated digest enters the shell. Raw family IDs may contain
    // shell syntax or newlines, and tmux's q modifier drops literal newlines.
    const validToken = `#{m/r:^family-${"[a-f0-9]".repeat(64)}$,#{@pi_task_invalidation}}`
    const sameFamily = "#{&&:#{!=:#{@pi_task_invalidation_family},},#{==:#{@pi_task_family_id},#{@pi_task_invalidation_family}}}"
    const routable = `#{&&:${validToken},${sameFamily}}`
    for (const hook of hooks) {
      if (generation !== this.generation) return
      if (this.installed.has(hook)) continue
      try {
        let scoped = "0"
        if (["after-new-window", "after-split-window", "after-rename-window", "after-rename-session"].includes(hook)) scoped = routable
        if (hook === "after-set-option") {
          // Older tmux versions without hook flags remain conservative, as do
          // global/server writes and edits to the routing identity itself.
          const local = "#{&&:#{hook_flag_t},#{!:#{||:#{hook_flag_g},#{hook_flag_s}}}}"
          const identity = "#{||:#{==:#{hook_argument_0},@pi_task_family_id},#{||:#{==:#{hook_argument_0},@pi_task_invalidation},#{==:#{hook_argument_0},@pi_task_invalidation_family}}}"
          scoped = `#{&&:${routable},#{&&:${local},#{!:${identity}}}}`
        }
        // Destructive hooks can expose a surviving, unrelated session's options.
        const filename = `#{?${scoped},#{@pi_task_invalidation},tmux-invalidation}`
        const command = `run-shell -b ${quote(`touch ${quote(this.directory)}/${filename}`)}`
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
  private invalidate(generation: number, filename?: string): void {
    if (generation !== this.generation) return
    // Atomic writes only become authoritative on rename. Never treat their
    // temporary siblings as generic invalidations.
    if (filename && /^(?:family-[a-f0-9]{64}|invalidation)\.\d+\.[a-z0-9]+\.tmp$/.test(filename)) return
    if (filename && /^family-[a-f0-9]{64}$/.test(filename)) {
      const interested = [...this.subscriptions].some(subscription => {
        const query = subscription.query
        const family = "familyId" in query ? query.familyId : query.routingFamilyId ?? subscription.resolvedFamilyId
        return !family || familyInvalidationFilename(family) === filename
      })
      if (!interested) return
    }
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
      if ("subtreeRootId" in query) {
        // Preserve learned routing after removal; an unknown root stays conservative.
        subscription.resolvedFamilyId = all.find(task => task.id === query.subtreeRootId || task.rootId === query.subtreeRootId)?.familyId ?? subscription.resolvedFamilyId
      }
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
