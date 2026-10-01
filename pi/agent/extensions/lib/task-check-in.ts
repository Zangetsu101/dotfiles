import { randomUUID } from "node:crypto"
import { access, open, readFile, rename, rm, writeFile } from "node:fs/promises"

export function createTaskCheckInScheduler(options: {
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
} = {}) {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const callbacks = new Map<string, () => void | Promise<void>>()
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
    const timer = setTimer(() => { void fire(statusFile, state.id).catch((error) => console.error("background task check-in failed:", error)) }, Math.min(0x7fffffff, Math.max(0, state.deadline - now())))
    timer.unref?.()
    timers.set(statusFile, timer)
  }

  async function fire(statusFile: string, id: string) {
    if (!callbacks.has(statusFile)) return
    const state = await read(statusFile)
    if (!state || state.id !== id) return
    if (state.deadline > now()) { arm(statusFile, state); return }
    // Claim before calling user code. The claim remains on disk across reloads.
    try {
      const claim = await open(`${file(statusFile)}.${id}.claimed`, "wx", 0o600)
      await claim.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return
      throw error
    }
    if (await exists(statusFile) || (await read(statusFile))?.id !== id) return
    const callback = callbacks.get(statusFile)
    if (callback && (await read(statusFile))?.id === id) await callback()
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
    async watch(statusFile: string, callback: () => void | Promise<void>) {
      callbacks.set(statusFile, callback)
      const state = await read(statusFile)
      if (state) arm(statusFile, state)
    },
    async cancel(statusFile: string) {
      stop(statusFile)
      await rm(file(statusFile), { force: true })
    },
    stop,
  }
}

export const taskCheckIns = createTaskCheckInScheduler()
