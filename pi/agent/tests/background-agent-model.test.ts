import assert from "node:assert/strict"
import test from "node:test"
import backgroundAgentExtension from "../extensions/background-agent.ts"
import { BackgroundTasks } from "../extensions/lib/background-task.ts"
import { FakePiRuntime, FakeTmuxProcessAdapter } from "./support/background-task-runtime.ts"
import { installBackgroundTaskEnvironmentHooks } from "./support/background-task-environment.ts"

installBackgroundTaskEnvironmentHooks()

for (const parentModel of [undefined, { provider: "anthropic", id: "parent-model" }]) {
  for (const selectedModel of [undefined, "openai/child-model"]) {
    test(`background agent selects ${selectedModel ?? "inherited model"} with ${parentModel ? "a parent model" : "no parent model"}`, async () => {
      const runtime = new FakePiRuntime()
      runtime.context.model = parentModel
      const tmux = new FakeTmuxProcessAdapter()
      const tasks = new BackgroundTasks(tmux)
      await backgroundAgentExtension(runtime.pi, { tasks, tmux })
      try {
        const result = await runtime.execute("background_agent", {
          task: "review", model: selectedModel, expectedCompletionMinutes: 1,
        })
        const window = [...tmux.sessions.values()].flatMap((session) => [...session.windows.values()])
          .find((window) => window.metadata.has("@pi_agent_model"))!
        const expectedModel = selectedModel ?? (parentModel ? "anthropic/parent-model" : "default")
        assert.equal(window.metadata.get("@pi_agent_model"), expectedModel)
        assert.ok(result.content[0].text.includes(`Model: ${expectedModel} (medium)`))
        const command = window.command.join(" ")
        if (expectedModel === "default") assert.ok(!command.includes("--model"))
        else {
          assert.match(command, /--model/)
          assert.ok(command.includes(expectedModel))
          if (selectedModel) assert.ok(!command.includes("anthropic/parent-model"))
        }
      } finally {
        await runtime.emit("session_shutdown")
      }
    })
  }
}
