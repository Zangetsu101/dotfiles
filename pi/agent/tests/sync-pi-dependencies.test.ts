import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"

test("sync and check cover every Pi dependency", () => {
  const root = mkdtempSync(join(tmpdir(), "sync-pi-"))
  try {
    const agent = join(root, "agent")
    const globalModules = join(root, "global")
    const globalPi = join(globalModules, "@earendil-works/pi-coding-agent")
    const versions: Record<string, string> = {
      "@earendil-works/pi-coding-agent": "1.0.3",
      "@earendil-works/pi-ai": "1.0.4",
      "@earendil-works/pi-tui": "1.0.5",
      typebox: "1.3.27",
    }
    function packageAt(path: string, value: object) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(value))
    }
    mkdirSync(join(agent, "scripts"), { recursive: true })
    copyFileSync(new URL("../scripts/sync-pi-dependencies.mjs", import.meta.url), join(agent, "scripts/sync.mjs"))
    packageAt(join(agent, "package.json"), { dependencies: versions })
    for (const [name, version] of Object.entries(versions)) {
      packageAt(join(name === "@earendil-works/pi-coding-agent" ? globalPi : join(globalPi, "node_modules", name), "package.json"), { version })
      packageAt(join(agent, "node_modules", name, "package.json"), { version })
    }
    const bin = join(root, "bin")
    mkdirSync(bin)
    const argsFile = join(root, "args")
    writeFileSync(join(bin, "npm"), `#!/bin/sh\nif [ "$1" = root ]; then printf '%s\\n' '${globalModules}'; else printf '%s\\n' "$@" > '${argsFile}'; fi\n`)
    chmodSync(join(bin, "npm"), 0o755)
    const run = (...args: string[]) => spawnSync(process.execPath, [join(agent, "scripts/sync.mjs"), ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8",
    })
    assert.equal(run().status, 0)
    const installArgs = readFileSync(argsFile, "utf8").trim().split("\n")
    for (const [name, version] of Object.entries(versions)) {
      assert.ok(installArgs.includes(`${name}@${version}`), `missing ${name} from sync`)
    }
    assert.equal(run("--check").status, 0)
    for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-tui"]) {
      packageAt(join(agent, "node_modules", name, "package.json"), { version: "0.0.0" })
      const result = run("--check")
      assert.equal(result.status, 1, `${name} mismatch should fail check`)
      assert.ok(result.stderr.includes(name))
      packageAt(join(agent, "node_modules", name, "package.json"), { version: versions[name] })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
