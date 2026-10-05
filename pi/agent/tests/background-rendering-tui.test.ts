import assert from "node:assert/strict"
import test from "node:test"
import { CustomEditor, CustomMessageComponent, getSelectListTheme, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent"
import { getKeybindings, KeybindingsManager, setKeybindings, type KeyId, type TUI } from "@earendil-works/pi-tui"
import { backgroundMessageRenderer, backgroundToolRenderers } from "../extensions/lib/background-rendering.ts"

initTheme("dark")
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "")
const details = { label: "Demo mock inspection", status: "started", id: "demo", target: "@1", output: "Captured output", attach: "/task attach demo" }
const bindings = (keys: KeyId[] = ["ctrl+o"]) => new KeybindingsManager({ "app.tools.expand": { defaultKeys: keys } })

test("Pi tool composition does not repeat the call label and toggles output and attach data", () => {
  const previous = getKeybindings()
  setKeybindings(bindings())
  try {
    const component = new ToolExecutionComponent("background_agent", "call", { label: details.label, task: "Inspect demo" }, {}, backgroundToolRenderers("background_agent"), { requestRender() {} } as TUI, "/repo")
    component.updateResult({ content: [{ type: "text", text: "Captured output" }], details, isError: false })
    const collapsed = plain(component.render(160))
    assert.equal(collapsed.split("background_agent").length - 1, 1)
    assert.equal(collapsed.split(details.label).length - 1, 1)
    assert.match(collapsed, /started · ctrl\+o to expand/)
    assert.doesNotMatch(collapsed, /Captured output|Attach:/)
    let expandedState = false
    const editor = new CustomEditor({ requestRender() {} } as TUI, { borderColor: (text) => text, selectList: getSelectListTheme() }, getKeybindings())
    editor.onAction("app.tools.expand", () => {
      expandedState = !expandedState
      component.setExpanded(expandedState)
    })
    editor.handleInput("\x0f")
    const expanded = plain(component.render(160))
    assert.match(expanded, /Captured output/)
    assert.match(expanded, /Attach: \/task attach demo/)
    assert.match(expanded, /Inspect demo/)
    editor.handleInput("\x0f")
    assert.equal(plain(component.render(160)), collapsed)
  } finally { setKeybindings(previous) }
})

test("Pi custom message expansion preserves its standalone header and respects rebound or unbound keys", () => {
  const previous = getKeybindings()
  try {
    for (const keys of [["alt+o"], []] as KeyId[][]) {
      setKeybindings(bindings(keys))
      const component = new CustomMessageComponent({ role: "custom", customType: "background-agent", display: true, content: "Model content", details }, backgroundMessageRenderer)
      const collapsed = plain(component.render(160))
      assert.match(collapsed, /background_agent · Demo mock inspection · started/)
      if (keys.length) assert.match(collapsed, /alt\+o to expand/)
      else assert.doesNotMatch(collapsed, /to expand|ctrl\+o/)
      component.setExpanded(true)
      assert.match(plain(component.render(160)), /Captured output/)
      assert.match(plain(component.render(160)), /Attach: \/task attach demo/)
      component.setExpanded(false)
      assert.equal(plain(component.render(160)), collapsed)
    }
  } finally { setKeybindings(previous) }
})
