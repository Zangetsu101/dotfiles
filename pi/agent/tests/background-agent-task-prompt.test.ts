import assert from "node:assert/strict"
import test from "node:test"
import { delegatedTaskPrompt } from "../extensions/background-agent.ts"

test("a delegated task tells the child to do the work itself", () => {
  assert.equal(
    delegatedTaskPrompt("Review the authentication changes."),
    [
      "Delegated task: Complete all work—including skill delegation steps—in this session.",
      "",
      "Review the authentication changes.",
    ].join("\n"),
  )
})
