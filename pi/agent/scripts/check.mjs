import { spawn } from "node:child_process"

const children = [
  spawn("npm", ["test"], { stdio: "inherit" }),
  spawn("tsc", ["--noEmit"], { stdio: "inherit" }),
]

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal)
    process.exitCode = signal === "SIGINT" ? 130 : 143
  })
}

const results = await Promise.all(children.map(child => new Promise(resolve => {
  child.on("error", error => {
    console.error(error)
    resolve(1)
  })
  child.on("exit", code => resolve(code ?? 1))
})))

if (results.some(code => code !== 0)) process.exitCode ||= 1
