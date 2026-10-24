import assert from "node:assert/strict"
import test from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"
import footerExtension from "../extensions/footer.ts"

function footer(statuses: Map<string, string>) {
  let start!: (event: unknown, ctx: any) => void
  let component!: { render(width: number): string[] }
  const colors: Array<[string, string]> = []
  footerExtension({
    on: (_name: string, handler: typeof start) => { start = handler },
    getSessionName: () => undefined,
  } as any)
  start({}, {
    mode: "tui", cwd: "/repo",
    sessionManager: { getEntries: () => [] },
    getContextUsage: () => undefined,
    ui: { setFooter: (factory: any) => {
      component = factory({ requestRender() {} }, {
        fg: (color: string, text: string) => { colors.push([color, text]); return text },
      }, {
        onBranchChange: () => () => {},
        getGitBranch: () => undefined,
        getAvailableProviderCount: () => 1,
        getExtensionStatuses: () => statuses,
      })
    } },
  })
  return { render: (width = 120) => component.render(width), colors }
}

test("footer renders separate progress rows after sorted statuses and before Codex usage", () => {
  const view = footer(new Map([
    ["codex-usage", "Codex usage"],
    ["z-other", "Other\tstatus\ntext"],
    ["background-tasks-progress", "Tests · working\t now\nDocs · blocked\r waiting"],
    ["background-tasks", "2 agents"],
  ]))
  assert.deepEqual(view.render().slice(2), [
    "2 agents Other status text",
    "Tests · working now",
    "Docs · blocked waiting",
    "Codex usage",
  ])
  assert.deepEqual(view.colors.filter(([color]) => color === "muted"), [
    ["muted", "Tests · working now"],
    ["muted", "Docs · blocked waiting"],
  ])
})

test("footer truncates each wide progress row independently", () => {
  const view = footer(new Map([
    ["background-tasks", "2 agents"],
    ["background-tasks-progress", "Tests 界界界界界界界\nDocs 界界界界界界界"],
    ["codex-usage", "Codex usage"],
  ]))
  const lines = view.render(12)
  assert.equal(lines.length, 6)
  assert.match(lines[3]!, /^Tests /)
  assert.match(lines[4]!, /^Docs /)
  assert.ok(lines.every((line) => visibleWidth(line) <= 12))
  assert.equal(lines[5], "Codex usage")
})

test("footer removes cleared progress rows without duplicating statuses", () => {
  const statuses = new Map([
    ["background-tasks", "2 agents"],
    ["background-tasks-progress", "Tests working\nDocs working"],
    ["codex-usage", "Codex usage"],
  ])
  const view = footer(statuses)
  assert.equal(view.render().length, 6)
  statuses.delete("background-tasks-progress")
  statuses.set("background-tasks", "1 agent")
  assert.deepEqual(view.render().slice(2), ["1 agent", "Codex usage"])
  statuses.set("background-tasks-progress", "")
  assert.deepEqual(view.render().slice(2), ["1 agent", "Codex usage"])
  statuses.clear()
  assert.equal(view.render().length, 2)
})
