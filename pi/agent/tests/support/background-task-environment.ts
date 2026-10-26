import { afterEach, beforeEach } from "node:test"

export function installBackgroundTaskEnvironmentHooks() {
  let inherited: NodeJS.ProcessEnv
  beforeEach(() => {
    inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("PI_BACKGROUND_")))
    for (const key of Object.keys(inherited)) delete process.env[key]
  })
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith("PI_BACKGROUND_")) delete process.env[key]
    Object.assign(process.env, inherited)
  })
}
