import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

type Fixture = {
  git: (...args: string[]) => void
  put: (path: string, text: string) => void
  hook: (status?: number) => ReturnType<typeof spawnSync>
  checked: () => boolean
  stagePiChange: () => void
}

function fixture(run: (repo: Fixture) => void) {
  const root = mkdtempSync(join(tmpdir(), "pre-commit-"))
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key]
  }

  function git(...args: string[]) {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
  }
  function put(path: string, text: string) {
    writeFileSync(join(root, path), text)
  }

  try {
    mkdirSync(join(root, "pi/agent"), { recursive: true })
    mkdirSync(join(root, "bin"))
    copyFileSync(new URL("../../../.githooks/pre-commit", import.meta.url), join(root, "hook"))
    put("bin/npm", '#!/bin/sh\nprintf "%s\\n" "$@" > "$PWD/checked"\nexit "${CHECK_STATUS:-0}"\n')
    chmodSync(join(root, "bin/npm"), 0o755)
    git("init", "-q")
    git("config", "user.email", "test@example.invalid")
    git("config", "user.name", "Hook test")
    git("config", "core.hooksPath", "/dev/null")
    put("pi/agent/trigger.ts", "original\n")
    put("pi/agent/hidden file.ts", "original\n")
    put("outside", "original\n")
    git("add", ".")
    git("commit", "-qm", "fixture")
    run({
      git,
      put,
      stagePiChange() {
        put("pi/agent/trigger.ts", "staged\n")
        git("add", "pi/agent/trigger.ts")
      },
      checked: () => existsSync(join(root, "checked")),
      hook: (status = 0) => {
        const result = spawnSync("sh", [join(root, "hook")], {
          cwd: root,
          env: {
            ...env,
            PATH: `${root}/bin:${env.PATH}`,
            CHECK_STATUS: String(status),
          },
          encoding: "utf8",
        })
        if (existsSync(join(root, "checked"))) {
          assert.equal(readFileSync(join(root, "checked"), "utf8"), "--prefix\npi/agent\nrun\ncheck\n")
        }
        return result
      },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

for (const flag of ["assume-unchanged", "skip-worktree"]) {
  test(`rejects ${flag} tracked Pi files before checks`, () => {
    fixture(({ git, put, hook, checked, stagePiChange }) => {
      stagePiChange()
      git("update-index", `--${flag}`, "pi/agent/hidden file.ts")
      put("pi/agent/hidden file.ts", "hidden invalid code\n")
      const result = hook()
      assert.equal(result.status, 1)
      assert.match(String(result.stderr), /assume-unchanged.*skip-worktree/)
      assert.match(String(result.stderr), /pi\/agent\/hidden file.ts/)
      assert.equal(checked(), false)
    })
  })

  test(`rejects ${flag} even when the flagged Pi file is clean`, () => {
    fixture(({ git, hook, checked, stagePiChange }) => {
      stagePiChange()
      git("update-index", `--${flag}`, "pi/agent/hidden file.ts")
      assert.equal(hook().status, 1)
      assert.equal(checked(), false)
    })
  })
}

for (const change of ["unstaged", "untracked"]) {
  test(`rejects ${change} Pi changes instead of validating different code`, () => {
    fixture(({ put, hook, checked, stagePiChange }) => {
      stagePiChange()
      put(change === "unstaged" ? "pi/agent/trigger.ts" : "pi/agent/new.ts", "not staged\n")
      const result = hook()
      assert.equal(result.status, 1)
      assert.match(String(result.stderr), /Stage or stash/)
      assert.equal(checked(), false)
    })
  })
}

for (const status of [0, 23]) {
  test(`staged Pi validation propagates check status ${status}`, () => {
    fixture(({ hook, checked, stagePiChange }) => {
      stagePiChange()
      assert.equal(hook(status).status, status)
      assert.equal(checked(), true)
    })
  })
}

test("non-Pi staged changes skip checks despite hidden and dirty Pi files", () => {
  fixture(({ git, put, hook, checked }) => {
    git("update-index", "--assume-unchanged", "pi/agent/hidden file.ts")
    git("update-index", "--skip-worktree", "pi/agent/trigger.ts")
    put("pi/agent/hidden file.ts", "hidden\n")
    put("pi/agent/new.ts", "untracked\n")
    put("outside", "staged\n")
    git("add", "outside")
    assert.equal(hook().status, 0)
    assert.equal(checked(), false)
  })
})

test("hidden flags outside Pi do not block staged Pi validation", () => {
  fixture(({ git, put, hook, checked, stagePiChange }) => {
    git("update-index", "--assume-unchanged", "--skip-worktree", "outside")
    put("outside", "hidden\n")
    stagePiChange()
    assert.equal(hook().status, 0)
    assert.equal(checked(), true)
  })
})
