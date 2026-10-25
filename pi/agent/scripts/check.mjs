import { spawn } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

// Each command owns a process group, so npm's shell and test workers receive
// cancellation too.
const children = [
  spawn("npm", ["test"], { stdio: "inherit", detached: true }),
  spawn("tsc", ["--noEmit"], { stdio: "inherit", detached: true }),
]
const groups = children.flatMap(child => child.pid ? [child.pid] : [])

function signalGroups(signal) {
  for (const group of groups) {
    try {
      process.kill(-group, signal)
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
  }
}

async function groupsRunning() {
  // kill(group, 0) also sees zombies. Those cannot run or receive signals;
  // their reaping belongs to their parent (possibly the container's init).
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    let stat
    try {
      stat = await readFile(`/proc/${entry}/stat`, "utf8")
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") continue
      throw error
    }
    const [state, , group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    if (state !== "Z" && state !== "X" && groups.includes(Number(group))) return true
  }
  return false
}

let shutdown
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shutdown) return
    process.exitCode = signal === "SIGINT" ? 130 : 143
    shutdown = (async () => {
      signalGroups(signal)
      const deadline = Date.now() + 500
      while (await groupsRunning()) {
        if (Date.now() >= deadline) signalGroups("SIGKILL")
        await delay(20)
      }
    })().catch(error => {
      console.error("Check shutdown failed:", error)
      process.exitCode = 1
      try {
        signalGroups("SIGKILL")
      } catch (killError) {
        console.error("Check cleanup failed:", killError)
      }
    })
  })
}

const results = await Promise.all(children.map(child => new Promise(resolve => {
  child.on("error", error => {
    console.error(error)
    resolve(1)
  })
  child.on("exit", code => resolve(code ?? 1))
})))

// Direct children can exit before their descendants. Keep shutdown alive until
// the owned groups have stopped, including after escalation.
await shutdown
if (results.some(code => code !== 0)) process.exitCode ||= 1
