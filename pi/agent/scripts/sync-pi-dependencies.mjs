import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PI_PACKAGE = "@earendil-works/pi-coding-agent"
const agentDir = dirname(dirname(fileURLToPath(import.meta.url)))

const installRoot = process.env.PI_MANAGED_INSTALL_ROOT || join(homedir(), ".pi", "agent", "install")
const currentVersion = readFileSync(join(installRoot, "current-version"), "utf8").trim()
if (!/^[A-Za-z0-9._+-]+$/.test(currentVersion) || [".", ".."].includes(currentVersion)) {
  throw new Error(`Invalid managed Pi version in ${join(installRoot, "current-version")}`)
}
const managedModulesDir = join(installRoot, "releases", currentVersion, "node_modules")

function readPackage(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

const localPackage = readPackage(join(agentDir, "package.json"))
const managedPiDir = join(managedModulesDir, PI_PACKAGE)
const managedPi = readPackage(join(managedPiDir, "package.json"))
const managedRequire = createRequire(join(managedPiDir, "package.json"))
const expected = { [PI_PACKAGE]: managedPi.version }
for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"]) {
  const packagePath = managedRequire.resolve.paths(name)
    .map((path) => join(path, name, "package.json"))
    .find((path) => existsSync(path))
  if (!packagePath) throw new Error(`Could not find ${name} installed for ${managedPiDir}`)
  expected[name] = readPackage(packagePath).version
}

if (process.argv.includes("--check")) {
  const installed = Object.fromEntries(
    Object.keys(expected).map((name) => [
      name,
      readPackage(join(agentDir, "node_modules", name, "package.json")).version,
    ]),
  )
  const mismatches = Object.entries(expected).filter(
    ([name, version]) =>
      localPackage.dependencies?.[name] !== version || installed[name] !== version,
  )

  if (mismatches.length > 0) {
    for (const [name, version] of mismatches) {
      console.error(
        `${name}: declared ${localPackage.dependencies?.[name] ?? "missing"}, installed ${installed[name]}, managed ${version}`,
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
    ...Object.entries(expected).map(([name, version]) => `${name}@${version}`),
  ],
  { cwd: agentDir, stdio: "inherit" },
)

if (result.error) throw result.error
process.exit(result.status ?? 1)
