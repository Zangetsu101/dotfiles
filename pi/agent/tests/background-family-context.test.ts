import assert from "node:assert/strict"
import test from "node:test"
import { familyForContext, familyTaskParent } from "../extensions/lib/background-family.ts"

const environmentKeys = ["TMUX_PANE", "PI_SESSION_ID", "PI_BACKGROUND_TASK_FAMILY_ID"]

function isolatedEnvironment(t: { after(fn: () => void): void }) {
  const saved = environmentKeys.map((key) => [key, process.env[key]] as const)
  for (const key of environmentKeys) delete process.env[key]
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test("context restores the session family and uses the current pane and display name", (t) => {
  isolatedEnvironment(t)
  process.env.TMUX_PANE = "%17"
  process.env.PI_SESSION_ID = "environment-session"
  const family = familyForContext("resume", {
    cwd: "/work/project",
    sessionManager: {
      getSessionId: () => "manager-session",
      getBranch: () => [{ type: "custom", customType: "background-task-family", data: { familyId: "saved-family", rootId: "saved-root" } }],
    },
  }, "chosen name")
  assert.deepEqual(family, {
    familyId: "saved-family", familyName: "chosen name", rootId: "saved-root",
    rootPane: "%17", nodeId: "saved-root", nodeLabel: "root", isRoot: true,
  })
  assert.equal(familyForContext("fork", {
    cwd: "/work/project", sessionManager: { getSessionId: () => "manager-session" },
  }).familyId, "family:manager-session")
})

test("context falls back from unavailable session APIs to environment then working directory", (t) => {
  isolatedEnvironment(t)
  process.env.PI_SESSION_ID = "environment-session"
  for (const sessionManager of [undefined, {}, { getSessionId: () => "" }]) {
    assert.deepEqual(familyForContext("resume", { cwd: "/work/project", sessionManager }), {
      familyId: "family:environment-session", familyName: "project", rootId: "root:environment-session",
      rootPane: "", nodeId: "root:environment-session", nodeLabel: "root", isRoot: true,
    })
  }
  delete process.env.PI_SESSION_ID
  assert.equal(familyForContext("startup", { cwd: "/work/project" }).familyId, "family:/work/project")
})

test("task parent metadata identifies the immediate node without losing the family root", () => {
  assert.deepEqual(familyTaskParent({
    familyId: "family-one", familyName: "project", rootId: "root-one", rootPane: "%1",
    nodeId: "agent-two", nodeLabel: "research", isRoot: false,
  }, "@7"), {
    familyId: "family-one", familyName: "project", rootId: "root-one", rootPane: "%1",
    parent: "agent-two", parentId: "agent-two", parentLabel: "research", parentTarget: "@7",
  })
})
