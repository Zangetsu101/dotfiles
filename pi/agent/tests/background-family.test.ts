import assert from "node:assert/strict"
import test from "node:test"
import { familyForSession } from "../extensions/lib/background-family.ts"

const root = {
  cwd: "/work/dotfiles",
  pane: "%9",
  sessionId: "conversation-one",
  sessionName: undefined,
  entries: [] as any[],
  environment: {},
}

test("a Root Pi restores its persisted task family on resume", () => {
  const persisted = { familyId: "family-one", rootId: "root-one" }
  const family = familyForSession({ ...root, reason: "resume", entries: [{ type: "custom", customType: "background-task-family", data: persisted }] })

  assert.equal(family.familyId, "family-one")
  assert.equal(family.rootId, "root-one")
  assert.equal(family.rootPane, "%9")
  assert.equal(family.familyName, "dotfiles")
  assert.equal(family.nodeId, "root-one")
  assert.equal(family.nodeLabel, "root")
  assert.equal(family.isRoot, true)
})

test("a new or forked conversation starts a new task family instead of inheriting live work", () => {
  for (const reason of ["new", "fork"]) {
    const family = familyForSession({ ...root, reason, entries: [{ type: "custom", customType: "background-task-family", data: { familyId: "old", rootId: "old-root" } }] })

    assert.equal(family.familyId, "family:conversation-one")
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

  assert.equal(family.familyId, "family-one")
  assert.equal(family.familyName, "dotfiles work")
  assert.equal(family.rootId, "root-one")
  assert.equal(family.isRoot, false)
  assert.equal(family.nodeId, "agent-one")
  assert.equal(family.nodeLabel, "research")
  assert.equal(family.rootPane, "%1")
})

test("a child falls back to session identity when optional environment fields are absent", () => {
  for (const sessionName of [undefined, "named session"]) {
    const family = familyForSession({ ...root, reason: "startup", sessionName, environment: { PI_BACKGROUND_TASK_FAMILY_ID: "child-family" } })
    assert.deepEqual(family, {
      familyId: "child-family",
      familyName: sessionName ?? "dotfiles",
      rootId: "root:conversation-one",
      rootPane: "%9",
      nodeId: "root:conversation-one",
      nodeLabel: "root",
      isRoot: false,
    })
  }
})

test("resume selects the latest family entry and ignores unrelated entries", () => {
  const family = familyForSession({ ...root, reason: "resume", sessionName: "current name", entries: [
    { type: "custom", customType: "background-task-family", data: { familyId: "old", rootId: "old-root" } },
    { type: "custom", customType: "background-task-family", data: { familyId: "latest", rootId: "latest-root" } },
    { type: "message", customType: "background-task-family", data: { familyId: "wrong" } },
    { type: "custom", customType: "unrelated", data: { familyId: "wrong" } },
    { type: "custom", customType: "background-task-family", data: null },
    { type: "custom", customType: "background-task-family", data: "invalid" },
  ] })
  assert.equal(family.familyId, "latest")
  assert.equal(family.rootId, "latest-root")
  assert.equal(family.familyName, "current name")
})

test("invalid persisted identity fields fall back to the current session", () => {
  const family = familyForSession({ ...root, reason: "resume", entries: [
    { type: "custom", customType: "background-task-family", data: { familyId: 12, rootId: 34 } },
  ] })
  assert.equal(family.familyId, "family:conversation-one")
  assert.equal(family.rootId, "root:conversation-one")
})
