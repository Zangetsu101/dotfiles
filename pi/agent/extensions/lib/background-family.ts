import { basename } from "node:path"

export const FAMILY_ENTRY = "background-task-family"
export const FAMILY_ENV = "PI_BACKGROUND_TASK_FAMILY_ID"
export const FAMILY_NAME_ENV = "PI_BACKGROUND_TASK_FAMILY_NAME"
export const ROOT_ID_ENV = "PI_BACKGROUND_TASK_ROOT_ID"
export const ROOT_PANE_ENV = "PI_BACKGROUND_TASK_ROOT_PANE"
export const TASK_ID_ENV = "PI_BACKGROUND_TASK_ID"
export const TASK_LABEL_ENV = "PI_BACKGROUND_TASK_LABEL"

export type TaskFamily = {
  familyId: string
  familyName: string
  rootId: string
  rootPane: string
  nodeId: string
  nodeLabel: string
  isRoot: boolean
}

type PersistedFamily = Pick<TaskFamily, "familyId" | "rootId">
type FamilyEntry = { type?: string; customType?: string; data?: unknown }
type FamilyContext = {
  cwd: string
  sessionManager?: { getSessionId?(): string; getBranch?(): FamilyEntry[] }
}
type FamilySessionInput = {
  reason: string
  cwd: string
  pane: string
  sessionId: string
  sessionName?: string
  entries: FamilyEntry[]
  environment?: Record<string, string | undefined>
}

function generatedFamilyId(sessionId: string): string {
  return `family:${sessionId}`
}

export function familyForContext(reason: string, ctx: FamilyContext, sessionName?: string): TaskFamily {
  return familyForSession({
    reason,
    cwd: ctx.cwd,
    pane: process.env.TMUX_PANE ?? "",
    sessionId: ctx.sessionManager?.getSessionId?.() || process.env.PI_SESSION_ID || ctx.cwd,
    sessionName,
    entries: ctx.sessionManager?.getBranch?.() ?? [],
  })
}

export function familyForSession(input: FamilySessionInput): TaskFamily {
  const environment = input.environment ?? process.env
  const childFamilyId = environment[FAMILY_ENV]
  if (childFamilyId) {
    return {
      familyId: childFamilyId,
      familyName: environment[FAMILY_NAME_ENV] || input.sessionName || basename(input.cwd),
      rootId: environment[ROOT_ID_ENV] || `root:${input.sessionId}`,
      rootPane: environment[ROOT_PANE_ENV] || input.pane,
      nodeId: environment[TASK_ID_ENV] || `root:${input.sessionId}`,
      nodeLabel: environment[TASK_LABEL_ENV] || "root",
      isRoot: false,
    }
  }

  let restored: Partial<PersistedFamily> | undefined
  if (input.reason !== "fork" && input.reason !== "new") {
    for (let index = input.entries.length - 1; index >= 0; index--) {
      const entry = input.entries[index]
      if (entry?.type === "custom" && entry.customType === FAMILY_ENTRY && entry.data && typeof entry.data === "object") {
        const data = entry.data as Record<string, unknown>
        restored = {
          familyId: typeof data.familyId === "string" ? data.familyId : undefined,
          rootId: typeof data.rootId === "string" ? data.rootId : undefined,
        }
        break
      }
    }
  }
  const rootId = restored?.rootId || `root:${input.sessionId}`
  return {
    familyId: restored?.familyId || generatedFamilyId(input.sessionId),
    familyName: input.sessionName || basename(input.cwd),
    rootId,
    rootPane: input.pane,
    nodeId: rootId,
    nodeLabel: "root",
    isRoot: true,
  }
}
