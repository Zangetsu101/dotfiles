import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { DefaultResourceLoader, getPackageDir, ProjectTrustStore, SettingsManager, type DefaultProjectTrust, type ProjectTrustContext } from "@earendil-works/pi-coding-agent"
import backgroundAgent from "../extensions/background-agent.ts"
import backgroundMonitor from "../extensions/background-monitor.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"
import { installBackgroundTaskEnvironmentHooks } from "./support/background-task-environment.ts"

installBackgroundTaskEnvironmentHooks()

// Exercise the pinned CLI's resolver: project_trust runs before saved decisions,
// and its UI context must be the one subsequently used by the built-in prompt.
const { resolveProjectTrusted } = await import(pathToFileURL(join(getPackageDir(), "dist/core/project-trust.js")).href)

const cases: Array<{ name: string; saved?: boolean; policy?: DefaultProjectTrust; hasUI?: boolean; resources?: boolean; choice?: string; trusted: boolean }> = [
  { name: "saved trust", saved: true, trusted: true },
  { name: "saved distrust", saved: false, trusted: false },
  { name: "always policy", policy: "always", trusted: true },
  { name: "never policy", policy: "never", trusted: false },
  { name: "non-interactive", hasUI: false, trusted: false },
  { name: "no protected resources", resources: false, trusted: true },
  { name: "session-only approval", choice: "Trust (this session only)", trusted: true },
  { name: "persistent refusal", choice: "Do not trust", trusted: false },
]

for (const scenario of cases) test(`real Pi startup preserves ${scenario.name}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-startup-real-"))
  const cwd = join(directory, "project")
  const agentDir = join(directory, "agent")
  await mkdir(cwd)
  if (scenario.resources !== false) await mkdir(join(cwd, ".agents/skills"), { recursive: true })
  const tmux = new FakeTmuxProcessAdapter()
  const tasks = new BackgroundTasks(tmux, { metadataDirectory: join(directory, "metadata") })
  const parent = new FakePiRuntime()
  let resolveChoice: ((choice: string) => void) | undefined
  let reload: Promise<void> | undefined
  try {
    await backgroundAgent(parent.pi, { tasks, tmux })
    await backgroundMonitor(parent.pi, { tasks, tmux })
    const spawned = await parent.execute("background_agent", { task: "Review", cwd, expectedCompletionMinutes: 1 })
    process.env.PI_BACKGROUND_AGENT_STATUS_FILE = spawned.details.statusFile
    const trustStore = new ProjectTrustStore(agentDir)
    if (scenario.saved !== undefined) trustStore.set(cwd, scenario.saved)
    const trustContext: ProjectTrustContext = {
      cwd, mode: "tui", hasUI: scenario.hasUI ?? true,
      ui: {
        select: async (title, options) => {
          assert.ok(scenario.choice, "a non-prompting decision must not ask for input")
          assert.match(title, /Trust project folder\?/)
          assert.ok(options.includes(scenario.choice))
          return new Promise<string>((resolve) => { resolveChoice = resolve })
        },
        confirm: async () => { assert.fail("unexpected confirmation") },
        input: async () => { assert.fail("unexpected input") },
        notify() {},
      },
    }
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [(pi) => backgroundAgent(pi, { tmux })],
    })
    let trusted: boolean | undefined
    reload = loader.reload({ resolveProjectTrust: async ({ extensionsResult }) => {
      const decision: boolean = await resolveProjectTrusted({ cwd, trustStore, defaultProjectTrust: scenario.policy, extensionsResult, projectTrustContext: trustContext })
      trusted = decision
      return decision
    } })
    if (scenario.choice) {
      for (let attempt = 0; attempt < 100 && (!resolveChoice || !parent.messages.length); attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
      assert.ok(resolveChoice, "the real resolver must reach the original selector")
      assert.equal(parent.messages.length, 1)
      assert.equal(parent.messages[0].details.status, "blocked")
      resolveChoice(scenario.choice)
    }
    await reload
    assert.equal(trusted, scenario.trusted)
    assert.equal(trustStore.get(cwd), scenario.choice === "Do not trust" ? false : scenario.saved ?? null)
    if (!scenario.choice) {
      const inspected = await parent.execute("background_task", { action: "inspect", id: spawned.details.id })
      assert.equal(inspected.details.progress, undefined)
      assert.equal(parent.messages.length, 0)
      assert.ok(parent.activeTools.includes("background_agent_message"))
    }
  } finally {
    resolveChoice?.("Do not trust (this session only)")
    await reload
    await parent.emit("session_shutdown")
    await rm(directory, { recursive: true, force: true })
  }
})
