import assert from "node:assert/strict"
import test from "node:test"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { BackgroundTasks, type TmuxProcessAdapter } from "../extensions/lib/background-task.ts"

const execFileAsync = promisify(execFile)

class FakeTmux implements TmuxProcessAdapter {
  calls: string[][] = []
  listOutput = ""
  failOn?: string
  async run(args: string[]): Promise<string> {
    this.calls.push(args)
    if (this.failOn && args.includes(this.failOn)) throw new Error("tmux failure")
    if (args[0] === "list-sessions") return this.listOutput
    return args[0] === "-V" ? "tmux 3.4" : ""
  }
}

test("creating a task publishes durable task metadata before releasing its command", async () => {
  const tmux = new FakeTmux()
  const tasks = new BackgroundTasks(tmux)
  const task = await tasks.create({ kind: "monitor", label: "Run checks!", cwd: "/repo", command: "/bin/bash", args: ["-lc", "npm test"], remainOnExit: true })

  assert.match(task.target, /^pi-monitor-run-checks-/)
  assert.ok(tmux.calls.some((args) => args.includes("@pi_task_kind") && args.at(-1) === "monitor"))
  assert.ok(tmux.calls.some((args) => args.includes("remain-on-exit") && args.at(-1) === "on"))
  const release = tmux.calls.findIndex((args) => args[0] === "wait-for" && args[1] === "-S")
  const finalMetadata = tmux.calls.findIndex((args) => args.includes("@pi_task_output_file"))
  assert.ok(release > finalMetadata)
})

test("real tmux tasks preserve the child terminal while capturing output", async (t) => {
  try { await execFileAsync("tmux", ["-V"]) } catch { t.skip("tmux is unavailable"); return }
  const tasks = new BackgroundTasks()
  const task = await tasks.create({
    kind: "agent",
    label: "tty-test",
    cwd: process.cwd(),
    command: "/bin/bash",
    args: ["-c", "[ -t 0 ] && [ -t 1 ] && echo interactive-tty"],
    remainOnExit: true,
  })
  try {
    for (let attempt = 0; attempt < 20 && !(await tasks.completion(task)); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.deepEqual(await tasks.completion(task), { status: "completed", exitCode: 0 })
    assert.match(await readFile(task.outputFile!, "utf8"), /interactive-tty/)
  } finally {
    await tasks.cleanup([{ ...task, status: "completed" }])
  }
})

test("agent tasks preserve their interactive child session and parent navigation", async () => {
  const tmux = new FakeTmux()
  await new BackgroundTasks(tmux).create({
    kind: "agent",
    label: "worker",
    cwd: "/repo",
    command: "pi",
    args: [],
    parent: "parent-session",
    interactiveAfterExit: true,
  })

  const creation = tmux.calls.find((args) => args[0] === "new-session")!
  assert.ok(creation.includes("PI_BACKGROUND_TASK_PARENT=parent-session"))
  assert.match(creation.join("\n"), /exec \"\$\{SHELL:-\/bin\/bash\}\" -l/)
})

test("task creation rolls back a partially configured tmux session", async () => {
  const tmux = new FakeTmux()
  tmux.failOn = "@pi_task_label"
  await assert.rejects(new BackgroundTasks(tmux).create({ kind: "agent", label: "worker", cwd: "/repo", command: "pi", args: [] }))
  assert.ok(tmux.calls.some((args) => args[0] === "kill-session"))
})

test("discovery, external attachment, and cleanup expose task behavior", async () => {
  const tmux = new FakeTmux()
  tmux.listOutput = "pi-monitor-check-abc\tmonitor\tabc\tcheck\tcompleted\t%1\tparent\t/repo\t/tmp/status"
  const tasks = new BackgroundTasks(tmux)
  const discovered = await tasks.list("%1")
  assert.equal(discovered.length, 1)
  const previousTmux = process.env.TMUX
  delete process.env.TMUX
  try {
    assert.equal(await tasks.attach(discovered[0]!), "tmux attach -t pi-monitor-check-abc")
  } finally {
    if (previousTmux !== undefined) process.env.TMUX = previousTmux
  }
  assert.equal(await tasks.cleanup(discovered), 1)
  assert.ok(tmux.calls.some((args) => args[0] === "kill-session" && args.at(-1) === "pi-monitor-check-abc"))
})

test("discovery includes output files and scopes even an empty owner", async () => {
  const tmux = new FakeTmux()
  tmux.listOutput = [
    "mine\tmonitor\tone\tmine\trunning\t\tparent\t/repo\t/tmp/one-status\t/tmp/one-output",
    "other\tmonitor\ttwo\tother\trunning\t%2\tparent\t/repo\t/tmp/two-status\t/tmp/two-output",
  ].join("\n")
  const discovered = await new BackgroundTasks(tmux).list("")
  assert.deepEqual(discovered.map((task) => task.id), ["one"])
  assert.equal(discovered[0]?.outputFile, "/tmp/one-output")
})

test("task references never escape owner scope", async () => {
  const tmux = new FakeTmux()
  tmux.listOutput = [
    "mine\tmonitor\tone\tduplicate\trunning\t%1\tparent\t/repo\t/tmp/one\t/tmp/out",
    "other\tmonitor\ttwo\tduplicate\trunning\t%2\tparent\t/repo\t/tmp/two\t/tmp/out",
  ].join("\n")
  const tasks = new BackgroundTasks(tmux)
  assert.equal((await tasks.resolve("duplicate", "%1"))?.id, "one")
  assert.equal(await tasks.resolve("two", "%1"), undefined)
})

test("task references distinguish unknown and ambiguous labels", async () => {
  const tmux = new FakeTmux()
  tmux.listOutput = [
    "first\tmonitor\tone\tduplicate\trunning\t%1\tparent\t/repo\t/tmp/one\t/tmp/out",
    "second\tagent\ttwo\tduplicate\tcompleted\t%1\tparent\t/repo\t/tmp/two\t/tmp/out",
  ].join("\n")
  const tasks = new BackgroundTasks(tmux)
  assert.deepEqual(await tasks.resolveReference("missing", "%1"), { kind: "unknown" })
  assert.deepEqual(await tasks.resolveReference("duplicate", "%1"), { kind: "ambiguous" })
  assert.equal((await tasks.resolveReference("one", "%1")).kind, "found")
})

test("completion notification can be claimed only once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-task-claim-"))
  const statusFile = join(directory, "completion.json")
  await writeFile(statusFile, JSON.stringify({ status: "completed", exitCode: 0 }))
  const task = { id: "one", kind: "monitor", label: "one", status: "running", target: "one", owner: "", parent: "", cwd: "/repo", statusFile } as const
  const tasks = new BackgroundTasks(new FakeTmux())
  assert.equal((await tasks.claimCompletion(task))?.status, "completed")
  assert.equal(await tasks.claimCompletion(task), undefined)
})

test("termination records cancellation and signals the pane foreground group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-task-cancel-"))
  const task = { id: "one", kind: "monitor", label: "one", status: "running", target: "one", owner: "", parent: "", cwd: "/repo", statusFile: join(directory, "completion.json") } as const
  const tmux = new FakeTmux()
  await new BackgroundTasks(tmux).terminate(task)
  assert.ok(tmux.calls.some((args) => args[0] === "send-keys" && args.at(-1) === "C-c"))
})

test("default cleanup leaves running tasks inspectable", async () => {
  const tmux = new FakeTmux()
  const tasks = new BackgroundTasks(tmux)
  const removed = await tasks.cleanup([{ id: "one", kind: "monitor", label: "live", status: "running", target: "live-target", owner: "", parent: "", cwd: "/repo", statusFile: "/tmp/status" }])
  assert.equal(removed, 0)
  assert.equal(tmux.calls.length, 0)
})
