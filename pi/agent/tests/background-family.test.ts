import assert from "node:assert/strict"
import test from "node:test"
import { familyForSession } from "../extensions/lib/background-family.ts"

const root = {
  cwd: "/work/dotfiles",
  pane: "%9",
  sessionId: "conversation-one",
  sessionName: undefined,
  entries: [] as any[],
}

test("a Root Pi restores its persisted task family on resume", () => {
  const persisted = { familyId: "family-one", rootId: "root-one" }
  const family = familyForSession({ ...root, reason: "resume", entries: [{ type: "custom", customType: "background-task-family", data: persisted }] })

  assert.equal(family.familyId, "family-one")
  assert.equal(family.rootId, "root-one")
  assert.equal(family.rootPane, "%9")
  assert.equal(family.familyName, "dotfiles")
})

test("a new or forked conversation starts a new task family instead of inheriting live work", () => {
  for (const reason of ["new", "fork"]) {
    const family = familyForSession({ ...root, reason, entries: [{ type: "custom", customType: "background-task-family", data: { familyId: "old", rootId: "old-root" } }] })

    assert.notEqual(family.familyId, "old")
    assert.equal(family.rootId, "root:conversation-one")
  }
})

test("a child receives its family and node identity from the environment", () => {
  const family = familyForSession({ ...root, reason: "startup", environment: {
    PI_BACKGROUND_TASK_FAMILY_ID: "family-one",
    PI_BACKGROUND_TASK_FAMILY_NAME: "dotfiles work",
    PI_BACKGROUND_TASK_ROOT_ID: "root-one",
    PI_BACKGROUND_TASK_ROOT_PANE: "%1",
    PI_BACKGROUND_TASK_ID: "agent-one",
    PI_BACKGROUND_TASK_LABEL: "research",
  } })

  assert.equal(family.nodeId, "agent-one")
  assert.equal(family.nodeLabel, "research")
  assert.equal(family.rootPane, "%1")
})
