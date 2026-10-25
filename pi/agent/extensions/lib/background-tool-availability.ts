import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import type { BackgroundTask, BackgroundTasks } from "./background-task.ts"

export async function canMessageBackgroundAgent(tasks: BackgroundTasks, agent: BackgroundTask): Promise<boolean> {
  const completion = await tasks.completion(agent)
  return Boolean(completion && "kind" in completion && completion.kind !== "exit"
    ? await tasks.isPresent(agent)
    : !completion && agent.status !== "terminated" && agent.status !== "interrupted" && await tasks.isPresent(agent))
}

export function setBackgroundToolActive(pi: ExtensionAPI, name: string, available: boolean): void {
  const active = pi.getActiveTools()
  if (active.includes(name) === available) return
  pi.setActiveTools(available ? [...active, name] : active.filter((tool) => tool !== name))
}
