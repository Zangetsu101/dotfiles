import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"
import { BackgroundTasks, type TmuxProcessAdapter } from "../extensions/lib/background-task.ts"

const execFileAsync = promisify(execFile)
const tmux = async (socket: string, args: string[]): Promise<string> =>
  (await execFileAsync("tmux", ["-L", socket, ...args], { encoding: "utf8" })).stdout.trim()

async function tmuxAvailable(): Promise<boolean> {
  try { await execFileAsync("tmux", ["-V"]); return true } catch { return false }
}

async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  let value!: T
  for (let attempt = 0; attempt < 100; attempt++) {
    value = await read()
    if (accepts(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return value
}

test("real tmux groups monitors, selects the exact task window, and retains dead non-interactive panes", async (t) => {
  if (!(await tmuxAvailable())) return t.skip("tmux is not installed")

  // A private tmux socket makes names collision-proof and prevents this test from
  // listing, selecting, or deleting any user/agent sessions on the default server.
  const socket = `pi-task-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const adapter: TmuxProcessAdapter = { run: (args) => tmux(socket, args) }
  const tasks = new BackgroundTasks(adapter)
  const owner = `%integration-${socket}`
  const cleanup = async () => { await tmux(socket, ["kill-server"]).catch(() => undefined) }
  t.after(cleanup)

  try {
    const first = await tasks.create({ kind: "monitor", label: "first", cwd: process.cwd(), command: "/bin/sh", args: ["-c", "printf first-finished"], owner, remainOnExit: true })
    const second = await tasks.create({ kind: "monitor", label: "second", cwd: process.cwd(), command: "/bin/sh", args: ["-c", "printf second-finished"], owner, remainOnExit: true })
    const discovered = await tasks.list(owner)

    assert.equal(discovered.length, 2)
    assert.equal(new Set(discovered.map(({ target }) => target.split(":", 1)[0])).size, 1)
    assert.notEqual(first.target, second.target)

    const selected = discovered.find(({ id }) => id === second.id)!
    const inheritedTmux = process.env.TMUX
    let attachment: "switched" | string
    try {
      delete process.env.TMUX
      attachment = await tasks.attach(selected)
    } finally {
      if (inheritedTmux === undefined) delete process.env.TMUX; else process.env.TMUX = inheritedTmux
    }
    assert.equal(attachment, `tmux attach -t ${selected.target}`)
    // Control mode supplies a private client without needing or touching a terminal.
    // Attaching with the public command's exact target must make that window active.
    await tmux(socket, ["-C", "attach-session", "-t", selected.target, ";", "detach-client"])
    const selectedWindow = await tmux(socket, ["display-message", "-p", "-t", selected.target.split(":", 1)[0]!, "#{session_name}:#{window_index}"])
    assert.equal(selectedWindow, selected.target)
    assert.notEqual(selectedWindow, discovered.find(({ id }) => id === first.id)!.target)

    for (const task of discovered) {
      const state = await waitFor(
        () => tmux(socket, ["display-message", "-p", "-t", task.target, "#{pane_dead}\t#{pane_dead_status}"]),
        (value) => value === "1\t0",
      )
      const [dead, exitCode] = state.split("\t")
      assert.equal(dead, "1", `${task.target} should remain dead, not enter an interactive shell`)
      assert.equal(exitCode, "0")
      assert.match(await tmux(socket, ["capture-pane", "-p", "-t", task.target, "-S", "-"]), new RegExp(`${task.label}-finished`))
    }
  } finally {
    await cleanup()
  }
})
