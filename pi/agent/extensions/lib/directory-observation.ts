import { watch, type FSWatcher } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import { basename, resolve } from "node:path"

type Subscription = { listener: () => void; ignored: ReadonlySet<string> }
type Directory = {
  path: string
  subscriptions: Set<Subscription>
  watcher?: FSWatcher
  identity?: string
  opening?: Promise<void>
  retry?: ReturnType<typeof setTimeout>
  attempts: number
}
const retryDelays = [100, 500, 2_000]

/**
 * Events are invalidations, not an authoritative record of directory contents.
 * `ignore` names files whose own events a subscriber skips. Deliveries without a
 * filename (initial, sweep, reattach) always reach every subscriber.
 */
class DirectoryObservation {
  private readonly directories = new Map<string, Directory>()
  private sweep?: ReturnType<typeof setInterval>

  async watch(directory: string, listener: () => void, options: { ignore?: Iterable<string> } = {}): Promise<() => void> {
    const path = resolve(directory)
    let entry = this.directories.get(path)
    if (!entry) {
      entry = { path, subscriptions: new Set(), attempts: 0 }
      this.directories.set(path, entry)
    }
    const current = entry
    const subscription = { listener, ignored: new Set(options.ignore) }
    current.subscriptions.add(subscription)
    if (!this.sweep) {
      this.sweep = setInterval(() => {
        for (const entry of this.directories.values()) {
          this.notify(entry)
          entry.attempts = 0
          void this.ensureWatcher(entry)
        }
      }, 30_000)
      this.sweep.unref()
    }
    await this.ensureWatcher(current)
    if (current.subscriptions.has(subscription)) this.deliver(subscription)
    return () => {
      if (!current.subscriptions.delete(subscription) || current.subscriptions.size) return
      this.directories.delete(path)
      clearTimeout(current.retry)
      current.watcher?.close()
      current.watcher = undefined
      if (!this.directories.size) {
        clearInterval(this.sweep)
        this.sweep = undefined
      }
    }
  }

  private active(entry: Directory): boolean {
    return this.directories.get(entry.path) === entry && entry.subscriptions.size > 0
  }
  private deliver(subscription: Subscription): void {
    try { subscription.listener() } catch (error) { console.error("Directory observation listener failed:", error) }
  }
  private notify(entry: Directory, filename?: string): void {
    if (!this.active(entry)) return
    for (const subscription of entry.subscriptions) {
      if (filename === undefined || !subscription.ignored.has(filename)) this.deliver(subscription)
    }
  }
  private ensureWatcher(entry: Directory): Promise<void> {
    if (entry.opening) return entry.opening
    const operation = this.open(entry).catch(error => {
      if (!this.active(entry)) return
      entry.watcher?.close()
      entry.watcher = undefined
      this.retry(entry)
      if (entry.attempts > retryDelays.length) console.error("Directory observation recovery failed:", error)
    })
    entry.opening = operation
    void operation.finally(() => { if (entry.opening === operation) entry.opening = undefined })
    return operation
  }
  private async open(entry: Directory): Promise<void> {
    if (!this.active(entry)) return
    await mkdir(entry.path, { recursive: true, mode: 0o700 })
    const info = await stat(entry.path)
    if (!this.active(entry)) return
    const identity = `${info.dev}:${info.ino}`
    if (entry.watcher && entry.identity === identity) return
    entry.watcher?.close()
    const watcher = watch(entry.path, (event, filename) => {
      if (!this.active(entry) || entry.watcher !== watcher) return
      this.notify(entry, filename?.toString())
      if (event !== "rename") return
      if (!filename || filename.toString() === basename(entry.path)) {
        // A self-rename can precede removal completing. Do not reattach to
        // the old inode in that window, even if its path still exists.
        watcher.close()
        entry.watcher = undefined
        this.retry(entry)
      } else void this.ensureWatcher(entry)
    })
    entry.watcher = watcher
    entry.identity = identity
    // Only the safety sweep replenishes retries, so flapping watchers stay bounded.
    clearTimeout(entry.retry)
    entry.retry = undefined
    watcher.on("error", () => {
      if (!this.active(entry) || entry.watcher !== watcher) return
      watcher.close()
      entry.watcher = undefined
      this.notify(entry)
      this.retry(entry)
    })
    // A directory may have been replaced while attaching. Reconcile its durable files.
    this.notify(entry)
  }
  private retry(entry: Directory): void {
    if (!this.active(entry) || entry.retry) return
    const delay = retryDelays[entry.attempts++]
    if (delay === undefined) return
    entry.retry = setTimeout(() => {
      entry.retry = undefined
      void this.ensureWatcher(entry)
    }, delay)
    entry.retry.unref()
  }
}

// Pi reloads extension modules. Keep watcher ownership process-wide across runtimes.
const key = Symbol.for("dotfiles.pi.directory-observation")
const shared = globalThis as typeof globalThis & { [key]?: DirectoryObservation }
export const sharedDirectoryObservation = shared[key] ??= new DirectoryObservation()
