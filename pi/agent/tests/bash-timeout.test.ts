import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createBashTool } from "@earendil-works/pi-coding-agent"
import extension from "../extensions/bash-timeout.ts"

function hooks() {
  const handlers = new Map<string, (event: any) => any>()
  extension({ on: (name: string, handler: (event: any) => any) => { handlers.set(name, handler) } } as unknown as ExtensionAPI)
  return handlers
}

test("defaults only omitted bash timeouts and preserves explicit values", () => {
  const call = hooks().get("tool_call")!
  const input: { command: string; timeout?: number } = { command: "true" }
  call({ toolName: "bash", input })
  assert.equal(input.timeout, 120)
  for (const timeout of [0, -1, 1, 2147483.647]) {
    const explicit = { command: "true", timeout }
    call({ toolName: "bash", input: explicit })
    assert.equal(explicit.timeout, timeout)
  }
  const other = { command: "true" }
  call({ toolName: "background_monitor", input: other })
  assert.deepEqual(other, { command: "true" })
})

test("Pi timeout retains output and reports unconfirmed subprocess cleanup", async () => {
  const tool = createBashTool(process.cwd())
  let error: Error | undefined
  try { await tool.execute("test", { command: "echo before; sleep 2", timeout: 0.05 }) } catch (caught) { error = caught as Error }
  assert.match(error!.message, /before/)
  const result = hooks().get("tool_result")!({ toolName: "bash", isError: true, content: [{ type: "text", text: error!.message }] })
  assert.equal(result.content[1].type, "text")
  assert.match(result.content[1].text, /If this was a timeout, cancellation and subprocess termination are not confirmed/)
  assert.match(result.content[1].text, /Check for partial filesystem or external side effects before retrying/)
  assert.match(result.content[1].text, /explicit timeout or background_monitor/)
})

test("hooked calls honor two explicit deadlines and clean up an ordinary child", { skip: process.platform !== "linux" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bash-deadline-"))
  const call = hooks().get("tool_call")!
  try {
    for (const timeout of [0.2, 0.6]) {
      const pidFile = join(directory, `child-${timeout}`)
      const input = { command: `sleep 10 & echo $! > '${pidFile}'; echo started; wait`, timeout }
      call({ toolName: "bash", input })
      const started = performance.now()
      await assert.rejects(createBashTool(process.cwd()).execute("test", input), /started[\s\S]*Command timed out/)
      const elapsed = performance.now() - started
      assert.ok(elapsed >= timeout * 1000 * 0.8, `expired too early: ${elapsed}ms`)
      assert.ok(elapsed < timeout * 1000 + 1000, `expired too late: ${elapsed}ms`)
      const pid = Number(await readFile(pidFile, "utf8"))
      assert.ok(Number.isInteger(pid) && pid > 0)
      try {
        let running = true
        for (let attempt = 0; attempt < 50 && running; attempt++) {
          try {
            process.kill(pid, 0)
            const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return ""
              throw error
            })
            running = stat !== "" && !/^\d+ \(.*\) Z /.test(stat)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
            running = false
          }
          if (running) await new Promise((resolve) => setTimeout(resolve, 20))
        }
        assert.equal(running, false, `child ${pid} still running`)
      } finally {
        try { process.kill(pid, "SIGKILL") } catch { /* already gone */ }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("hooked deadlines allow early completion and expire late commands at both limits", async () => {
  const call = hooks().get("tool_call")!
  for (const timeout of [0.2, 0.6]) {
    for (const [position, duration] of [["below", timeout / 2], ["at", timeout], ["above", timeout * 2]] as const) {
      const input = { command: `echo started; sleep ${duration}; echo finished`, timeout }
      call({ toolName: "bash", input })
      const started = performance.now()
      let output: string
      let expired = false
      try {
        const result = await createBashTool(process.cwd()).execute("test", input)
        output = result.content.map((part) => part.type === "text" ? part.text : "").join("")
      } catch (error) {
        expired = true
        output = (error as Error).message
      }
      const elapsed = performance.now() - started
      assert.match(output, /started/)
      assert.ok(elapsed < timeout * 1000 + 1500, `${timeout}s ${position} took ${elapsed}ms`)
      if (position === "below") {
        assert.equal(expired, false, `${timeout}s early completion timed out`)
        assert.match(output, /finished/)
      } else if (position === "above") {
        assert.equal(expired, true, `${timeout}s late command completed`)
        assert.match(output, /Command timed out/)
        assert.doesNotMatch(output, /finished/)
      } else {
        assert.match(output, expired ? /Command timed out/ : /finished/)
      }
    }
  }
})

test("escaped descendant survives timeout and cancellation remains unconfirmed", { skip: process.platform !== "linux" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bash-escaped-"))
  const pidFile = join(directory, "child")
  try {
    const input = { command: `setsid sleep 10 </dev/null >/dev/null 2>&1 & echo $! > '${pidFile}'; echo started; wait`, timeout: 0.3 }
    const registered = hooks()
    registered.get("tool_call")!({ toolName: "bash", input })
    let error: Error | undefined
    try { await createBashTool(process.cwd()).execute("test", input) } catch (caught) { error = caught as Error }
    assert.match(error!.message, /started[\s\S]*Command timed out/)
    const pid = Number(await readFile(pidFile, "utf8"))
    assert.ok(Number.isInteger(pid) && pid > 1)
    process.kill(pid, 0)
    const result = registered.get("tool_result")!({ toolName: "bash", isError: true, content: [{ type: "text", text: error!.message }] })
    assert.match(result.content[1].text, /subprocess termination are not confirmed/)
  } finally {
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""))
    if (Number.isInteger(pid) && pid > 1) {
      try { process.kill(pid, "SIGKILL") } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test("normal completion is unchanged and errors receive conditional guidance", async () => {
  const result = await createBashTool(process.cwd()).execute("test", { command: "echo done", timeout: 1 })
  assert.match(result.content[0].type === "text" ? result.content[0].text : "", /done/)
  const hook = hooks().get("tool_result")!
  const failed = await createBashTool(process.cwd()).execute("test", { command: "echo 'Command timed out after 1 seconds'; exit 1", timeout: 1 })
  const actual = hook({ toolName: "bash", isError: true, ...failed })
  assert.match(actual.content[0].text, /Command exited with code 1/)
  assert.match(actual.content[1].text, /^If this was a timeout/)
  const otherError = hook({ toolName: "bash", isError: true, content: [{ type: "text", text: "Command timed out after 1 seconds" }], details: { reason: "ordinary error" }, structuredContent: { exit_code: 1 } })
  assert.equal(otherError.content[0].text, "Command timed out after 1 seconds")
  assert.match(otherError.content[1].text, /^If this was a timeout/)
  assert.deepEqual(otherError.structuredContent, { exit_code: 1 })
  assert.deepEqual(otherError.details, { reason: "ordinary error" })
  for (const event of [
    { toolName: "other", isError: true },
    { toolName: "bash", isError: false },
  ]) assert.equal(hook({ ...event, content: [{ type: "text", text: "Command timed out after 1 seconds" }] }), undefined)
})
