import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PI_PACKAGE = "@earendil-works/pi-coding-agent"
const agentDir = dirname(dirname(fileURLToPath(import.meta.url)))

// npm lifecycle scripts set these to the local project, which makes a nested
// `npm root --global` incorrectly resolve to <project>/lib/node_modules.
const globalNpmEnv = { ...process.env }
for (const name of [
  "npm_config_prefix",
  "npm_config_global_prefix",
  "npm_config_globalconfig",
  "npm_config_local_prefix",
]) {
  delete globalNpmEnv[name]
}
const globalModulesDir = execFileSync("npm", ["root", "--global"], {
  encoding: "utf8",
  env: globalNpmEnv,
}).trim()

function readPackage(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

const localPackage = readPackage(join(agentDir, "package.json"))
const globalPiDir = join(globalModulesDir, PI_PACKAGE)
const globalPi = readPackage(join(globalPiDir, "package.json"))
const globalTypebox = readPackage(join(globalPiDir, "node_modules", "typebox", "package.json"))

const expected = {
  [PI_PACKAGE]: globalPi.version,
  typebox: globalTypebox.version,
}

if (process.argv.includes("--check")) {
  const installed = {
    [PI_PACKAGE]: readPackage(join(agentDir, "node_modules", PI_PACKAGE, "package.json")).version,
    typebox: readPackage(join(agentDir, "node_modules", "typebox", "package.json")).version,
  }
  const mismatches = Object.entries(expected).filter(
    ([name, version]) =>
      localPackage.dependencies?.[name] !== version || installed[name] !== version,
  )

  if (mismatches.length > 0) {
    for (const [name, version] of mismatches) {
      console.error(
        `${name}: declared ${localPackage.dependencies?.[name] ?? "missing"}, installed ${installed[name]}, global ${version}`,
      )
    }
    console.error("Run npm run sync:pi")
    process.exit(1)
  }

  process.exit(0)
}

const result = spawnSync(
  "npm",
  [
    "install",
    "--save-exact",
    `${PI_PACKAGE}@${expected[PI_PACKAGE]}`,
    `typebox@${expected.typebox}`,
  ],
  { cwd: agentDir, stdio: "inherit" },
)

if (result.error) throw result.error
process.exit(result.status ?? 1)
