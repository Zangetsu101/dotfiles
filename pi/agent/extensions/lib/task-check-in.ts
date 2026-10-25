import { randomUUID } from "node:crypto"
import { access, open, readFile, rename, rm, writeFile } from "node:fs/promises"

export function createTaskCheckInScheduler(options: {
  now?: () => number
  setTimer?: (callback: () => Promise<void>, delay: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
} = {}) {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  type Watcher = { callback: () => boolean | void | Promise<boolean | void> }
  const callbacks = new Map<string, Watcher>()
  // Three exception retries; false-return suppression does not consume this budget.
  const retryDelays = [1_000, 5_000, 30_000]
  type Retry = { failures: number; deadline: number }
  type State = { id: string; deadline: number }
  const file = (statusFile: string) => `${statusFile}.check-in`

  async function exists(path: string) {
    try { await access(path); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  }

  async function read(statusFile: string): Promise<State | undefined> {
    try {
      const state: unknown = JSON.parse(await readFile(file(statusFile), "utf8"))
      if (typeof state !== "object" || state === null || !("id" in state) || !("deadline" in state)
        || typeof state.id !== "string" || typeof state.deadline !== "number") return undefined
      return state as State
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  function stop(statusFile: string) {
    const timer = timers.get(statusFile)
    if (timer !== undefined) clearTimer(timer)
    timers.delete(statusFile)
    callbacks.delete(statusFile)
  }

  function arm(statusFile: string, state: State) {
    const previous = timers.get(statusFile)
    if (previous !== undefined) clearTimer(previous)
    const watcher = callbacks.get(statusFile)
    const timer = setTimer(() => fire(statusFile, state.id, watcher).catch((error) => console.error("background task check-in failed:", error)), Math.min(0x7fffffff, Math.max(0, state.deadline - now())))
    timer.unref?.()
    timers.set(statusFile, timer)
  }

  async function fire(statusFile: string, id: string, watcher: Watcher | undefined) {
    if (!watcher || callbacks.get(statusFile) !== watcher) return
    const state = await read(statusFile)
    if (!state || state.id !== id || callbacks.get(statusFile) !== watcher) return
    if (state.deadline > now()) { arm(statusFile, state); return }
    const claimFile = `${file(statusFile)}.${id}.claimed`
    try {
      const claim = await open(claimFile, "wx", 0o600)
      await claim.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return
      throw error
    }
    const retryFile = `${file(statusFile)}.${id}.retry`
    let retry: Retry = { failures: 0, deadline: state.deadline }
    try {
      retry = JSON.parse(await readFile(retryFile, "utf8"))
      if (!retry || !Number.isInteger(retry.failures) || retry.failures < 1 || retry.failures > retryDelays.length
        || !Number.isFinite(retry.deadline)) throw new Error("invalid check-in retry state")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (await exists(statusFile) || (await read(statusFile))?.id !== id) return
    if (retry.deadline > now()) {
      await rm(claimFile, { force: true })
      if ((await read(statusFile))?.id === id && callbacks.get(statusFile) === watcher) arm(statusFile, { ...state, deadline: retry.deadline })
      return
    }
    if ((await read(statusFile))?.id !== id || callbacks.get(statusFile) !== watcher) return
    const { callback } = watcher
    let delivered: boolean | void
    let retryDeadline: number | undefined
    try { delivered = await callback() } catch (error) {
      const backoff = retryDelays[retry.failures]
      if (backoff === undefined) {
        console.error(`background task check-in terminal failure after 4 callback exceptions (${statusFile}, ${id}):`, error)
        return
      }
      console.error("background task check-in failed:", error)
      retry = { failures: retry.failures + 1, deadline: now() + backoff }
      // Persist retry state before releasing the claim. Filesystem failures fail closed.
      await writeFile(retryFile, JSON.stringify(retry), { mode: 0o600 })
      retryDeadline = retry.deadline
      delivered = false
    }
    if (delivered !== false || await exists(statusFile) || (await read(statusFile))?.id !== id) return
    await rm(claimFile, { force: true })
    if ((await read(statusFile))?.id === id && callbacks.get(statusFile) === watcher) arm(statusFile, { ...state, deadline: retryDeadline ?? now() + 1_000 })
  }

  return {
    async schedule(statusFile: string, deadlineMs: number) {
      if (!Number.isFinite(deadlineMs)) throw new RangeError("deadlineMs must be finite")
      const state: State = { id: randomUUID(), deadline: deadlineMs }
      const temporary = `${file(statusFile)}.${state.id}.tmp`
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
      try { await rename(temporary, file(statusFile)) } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
      if (callbacks.has(statusFile)) arm(statusFile, state)
    },
    async watch(statusFile: string, callback: () => boolean | void | Promise<boolean | void>) {
      const watcher = { callback }
      callbacks.set(statusFile, watcher)
      const state = await read(statusFile)
      if (state && callbacks.get(statusFile) === watcher) arm(statusFile, state)
    },
    stop,
  }
}

export const taskCheckIns = createTaskCheckInScheduler()
