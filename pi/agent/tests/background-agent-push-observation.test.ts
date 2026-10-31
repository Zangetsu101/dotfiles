import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { watch } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import backgroundAgent from "../extensions/background-agent.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"
import { installBackgroundTaskEnvironmentHooks } from "./support/background-task-environment.ts"

installBackgroundTaskEnvironmentHooks()
const pause = () => new Promise((resolve) => setTimeout(resolve, 5))
async function waitFor(predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return
    await pause()
  }
  assert.fail("expected push delivery without advancing the safety clock")
}

async function fixture(run: (f: { parent: FakePiRuntime; child: FakePiRuntime; tmux: FakeTmuxProcessAdapter; statusFile: string; id: string }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-push-"))
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux, { metadataDirectory: directory })
  const parent = new FakePiRuntime()
  const child = new FakePiRuntime()
  try {
    await backgroundAgent(parent.pi, { tasks, tmux })
    const spawned = await parent.execute("background_agent", { task: "Initial assignment", expectedCompletionMinutes: 1 })
    process.env.PI_BACKGROUND_AGENT_STATUS_FILE = spawned.details.statusFile
    process.env.PI_BACKGROUND_AGENT_DEPTH = "3"
    process.env.PI_BACKGROUND_TASK_FAMILY_ID = "family:conversation"
    process.env.PI_BACKGROUND_TASK_ROOT_ID = "root:conversation"
    process.env.PI_BACKGROUND_TASK_ID = spawned.details.id
    await backgroundAgent(child.pi, { tmux })
    await run({ parent, child, tmux, statusFile: spawned.details.statusFile, id: spawned.details.id })
  } finally {
    await child.emit("session_shutdown")
    await parent.emit("session_shutdown")
    await rm(directory, { recursive: true, force: true })
  }
}

test("mailbox filesystem events expose only complete error acknowledgements", async () => {
  await fixture(async ({ child, statusFile }) => {
    const mailbox = `${statusFile}.messages`
    await mkdir(mailbox, { recursive: true })
    const error = `delivery failed: ${"x".repeat(4 * 1024 * 1024)}`
    child.pi.sendUserMessage = () => { throw new Error(error) }
    const reads: Array<Promise<void>> = []
    const responses: string[] = []
    const failures: unknown[] = []
    const watcher = watch(mailbox, (_event, name) => {
      if (name?.toString() !== "large.ack") return
      reads.push(readFile(join(mailbox, "large.ack"), "utf8").then((raw) => {
        const response = JSON.parse(raw)
        assert.equal(response.status, "error")
        assert.equal(response.error, `Error: ${error}`)
        responses.push(raw)
      }).catch((error) => { failures.push(error) }))
    })
    try {
      await writeFile(join(mailbox, "large.request"), `\u0000force:${JSON.stringify({ message: "Fail delivery", operation: null })}`)
      await child.emit("session_start")
      await waitFor(() => reads.length > 0)
      await Promise.all(reads)
      assert.deepEqual(failures, [], "published responses must never be empty or partial JSON")
      assert.ok(responses.length > 0)
    } finally {
      watcher.close()
      await Promise.all(reads)
    }
  })
})

test("mailbox acknowledgement publication never replaces an existing response", async () => {
  await fixture(async ({ child, statusFile }) => {
    const mailbox = `${statusFile}.messages`
    await mkdir(mailbox, { recursive: true })
    await writeFile(join(mailbox, "claimed.ack"), "original response")
    await writeFile(join(mailbox, "claimed.request"), "A new message")
    await child.emit("session_start")
    await waitFor(() => child.userMessages.length === 1)
    await waitFor(async () => !(await readdir(mailbox)).includes("claimed.request"))
    assert.equal(await readFile(join(mailbox, "claimed.ack"), "utf8"), "original response")
  })
})

test("settled agent observation becomes idle after durable events drain", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  await fixture(async ({ parent, child, tmux }) => {
    let calls = 0
    const run = tmux.run.bind(tmux)
    tmux.run = async (args) => { calls++; return run(args) }
    await child.emit("session_start")
    await child.execute("background_agent_report", { state: "completed", activity: "Done" })
    await waitFor(() => parent.messages.length === 1)
    // Allow filesystem callbacks already queued by claims and status updates to drain.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const settled = calls
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(calls, settled, "idle observers must not keep reconciling tmux state")
  })
})

test("startup and mid-drain requests deliver through events while temporary requests stay invisible", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  await fixture(async ({ parent, child, statusFile, id }) => {
    const mailbox = `${statusFile}.messages`
    await mkdir(mailbox, { recursive: true })
    await writeFile(join(mailbox, "startup.request"), "Queued before startup")
    await writeFile(join(mailbox, "incomplete.tmp"), "Must never be delivered")
    await child.emit("session_start")
    await waitFor(() => child.userMessages.length === 1)
    const controller = new AbortController()
    child.context.signal = controller.signal
    child.context.abort = () => controller.abort()
    await child.emit("agent_start")
    const first = parent.execute("background_agent_message", { id, message: "Recovery", force: true })
    await waitFor(async () => (await readdir(mailbox)).some((name) => name.endsWith(".interrupt")))
    const second = parent.execute("background_agent_message", { id, message: "Arrived during drain" })
    await waitFor(async () => (await readdir(mailbox)).filter((name) => name.endsWith(".request")).length === 2)
    await child.emit("agent_end")
    await child.emit("agent_settled")
    assert.equal((await first).details.status, "delivered")
    assert.equal((await second).details.status, "delivered")
    assert.deepEqual(child.userMessages.map((message) => message.text), ["Queued before startup", "Recovery", "Arrived during drain"])
    await child.execute("background_agent_report", { state: "blocked", activity: "Need access", help: "Supply access", attention: true })
    await waitFor(() => parent.messages.some((message) => message.customType === "background-agent-check-in"))
    await child.execute("background_agent_report", { state: "completed", activity: "Finished" })
    await waitFor(() => parent.messages.some((message) => message.customType === "background-agent"))
  })
})
