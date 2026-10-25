import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const runner = fileURLToPath(new URL("../scripts/check.mjs", import.meta.url))
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function alive(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z"
  } catch {
    return false
  }
}

async function waitFor(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return
    await delay(20)
  }
  assert.fail("timed out waiting for runner processes")
}

async function waitForExit(exited: Promise<unknown>) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([exited, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("runner did not exit")), 5000)
    })])
  } finally {
    clearTimeout(timeout)
  }
}

function killOwnedProcess(pid: number | undefined) {
  if (!pid) return
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
}

async function commands(dir: string, source: string) {
  for (const name of ["npm", "tsc"]) {
    await writeFile(join(dir, name), `#!${process.execPath}\n${source}`)
    await chmod(join(dir, name), 0o755)
  }
}

function startRunner(dir: string): ChildProcess {
  return spawn(process.execPath, [runner], {
    cwd: dir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  })
}

async function cancellation(signal: "SIGINT" | "SIGTERM", stubborn = false) {
  const dir = await mkdtemp(join(tmpdir(), "check-runner-"))
  const pids: number[] = []
  const leafSource = `
    ${stubborn ? 'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {});' : ""}
    require("node:fs").writeFileSync(process.argv[1] + ".ready", "");
    setInterval(() => {}, 1000);
  `
  await commands(dir, `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const name = require("node:path").basename(process.argv[1]);
    const leaf = spawn(process.execPath, ["-e", ${JSON.stringify(leafSource)}, name], { stdio: "ignore" });
    writeFileSync(name + ".json", JSON.stringify([process.pid, leaf.pid]));
    setInterval(() => {}, 1000);
  `)
  const child = startRunner(dir)
  const exited = once(child, "exit")
  try {
    await waitFor(async () => {
      try {
        const entries = await Promise.all(["npm", "tsc"].map(name => readFile(join(dir, `${name}.json`), "utf8")))
        pids.splice(0, pids.length, ...entries.flatMap(entry => JSON.parse(entry)))
        await Promise.all(["npm", "tsc"].map(name => readFile(join(dir, `${name}.ready`))))
        return true
      } catch {
        return false
      }
    })
    child.kill(signal)
    await waitForExit(exited)
    assert.equal(child.exitCode, signal === "SIGINT" ? 130 : 143)
    assert.deepEqual(await Promise.all(pids.map(alive)), pids.map(() => false), "runner exited with surviving descendants")
  } finally {
    for (const pid of [child.pid, ...pids]) killOwnedProcess(pid)
    await rm(dir, { recursive: true, force: true })
  }
}

test("PID-targeted SIGTERM waits for descendant cleanup", { skip: process.platform !== "linux" }, async () => {
  await cancellation("SIGTERM")
})

test("PID-targeted SIGINT escalates and waits for stubborn descendants", { skip: process.platform !== "linux" }, async () => {
  await cancellation("SIGINT", true)
})

for (const failingCommand of [undefined, "npm", "tsc"]) {
  test(`parallel checks ${failingCommand ? `fail when ${failingCommand} fails` : "succeed when both commands succeed"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "check-runner-"))
    await commands(dir, `
      const { existsSync, writeFileSync } = require("node:fs");
      const name = require("node:path").basename(process.argv[1]);
      const other = name === "npm" ? "tsc" : "npm";
      writeFileSync(name + ".pid", String(process.pid));
      writeFileSync(name + ".started", JSON.stringify(process.argv.slice(2)));
      const timer = setInterval(() => {
        if (!existsSync(other + ".started")) return;
        clearInterval(timer);
        writeFileSync(name + ".finished", "");
        process.exit(name === ${JSON.stringify(failingCommand) ?? "undefined"} ? 23 : 0);
      }, 10);
    `)
    const child = startRunner(dir)
    const exited = once(child, "exit")
    try {
      await waitForExit(exited)
      assert.equal(child.exitCode, failingCommand ? 1 : 0)
      assert.deepEqual(JSON.parse(await readFile(join(dir, "npm.started"), "utf8")), ["test"])
      assert.deepEqual(JSON.parse(await readFile(join(dir, "tsc.started"), "utf8")), ["--noEmit"])
      await Promise.all(["npm", "tsc"].map(name => readFile(join(dir, `${name}.finished`))))
    } finally {
      killOwnedProcess(child.pid)
      // The fixture commands are in groups owned by the runner. On a timeout,
      // read their recorded PIDs so cleanup does not depend on runner cancellation.
      for (const name of ["npm", "tsc"]) {
        try {
          killOwnedProcess(Number(await readFile(join(dir, `${name}.pid`), "utf8")))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
      await rm(dir, { recursive: true, force: true })
    }
  })
}
