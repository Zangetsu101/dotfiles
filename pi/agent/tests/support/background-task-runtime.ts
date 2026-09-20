import { EventEmitter } from "node:events"
import { writeFile } from "node:fs/promises"
import type { TmuxProcessAdapter } from "../../extensions/lib/background-task.ts"

type Pane = { id: string; windowId: string; metadata: Map<string, string>; command: string[]; dead: boolean; retained: boolean }
type Window = { id: string; sessionId: string; name: string; metadata: Map<string, string>; panes: Map<string, Pane>; command: string[]; interactiveAfterCompletion: boolean }
type Session = { id: string; name: string; metadata: Map<string, string>; windows: Map<string, Window> }

const option = (args: string[], name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined

export class FakeTmuxProcessAdapter implements TmuxProcessAdapter {
  readonly sessions = new Map<string, Session>()
  readonly signalledTargets: string[] = []
  available = true
  currentSession = "$current"
  attachedTarget?: string
  failSetupFor?: string
  private nextSession = 1
  private nextWindow = 1
  private nextPane = 1

  familySessions() { return [...this.sessions.values()].filter((session) => session.metadata.has("@pi_task_family_id")) }
  tasks() {
    return this.records().filter((record) => record.metadata.has("@pi_task_id")).map((record) => ({
      target: record.id,
      kind: record.metadata.get("@pi_task_kind"), label: record.metadata.get("@pi_task_label"),
      status: record.metadata.get("@pi_task_status"),
      parentId: record.metadata.get("@pi_task_parent_id"), familyId: record.metadata.get("@pi_task_family_id"),
      dead: "dead" in record ? record.dead : false,
      retained: "retained" in record ? record.retained : false,
      interactiveAfterCompletion: "interactiveAfterCompletion" in record ? record.interactiveAfterCompletion : false,
    }))
  }
  private records() { return [...this.sessions.values()].flatMap((session) => [...session.windows.values()].flatMap((window) => [window, ...window.panes.values()])) }
  private session(target = "") { return this.sessions.get(target) ?? [...this.sessions.values()].find((item) => item.name === target) }
  private window(target = "") { return this.records().find((item): item is Window => "panes" in item && (item.id === target || `${this.sessions.get(item.sessionId)?.name}:${item.name}` === target)) }
  private pane(target = "") { return this.records().find((item): item is Pane => "windowId" in item && item.id === target) }
  private record(target = "") { return this.pane(target) ?? this.window(target) ?? this.session(target) }
  private format(template: string, values: Record<string, string>, metadata: Map<string, string>) {
    return template.replace(/#\{(@?[^}]+)\}/g, (_match, key: string) => key.startsWith("@") ? metadata.get(key) ?? "" : values[key] ?? "")
  }

  async complete(target: string, status: "completed" | "failed" = "completed", output = "") {
    const record = this.record(target)
    if (!record || !("command" in record)) throw new Error(`unknown task target: ${target}`)
    if ("dead" in record) record.dead = true
    record.metadata.set("@pi_task_status", status)
    const outputFile = record.metadata.get("@pi_task_output_file")
    if (outputFile) await writeFile(outputFile, output)
    const statusFile = record.metadata.get("@pi_task_status_file")
    if (statusFile) await writeFile(statusFile, JSON.stringify(record.metadata.get("@pi_task_kind") === "agent"
      ? { kind: status === "completed" ? "settled" : "exit", output, exitCode: status === "completed" ? 0 : 1 }
      : { status, exitCode: status === "completed" ? 0 : 1 }))
  }

  async run(args: string[]): Promise<string> {
    const action = args[0]
    if (action === "-V") { if (!this.available) throw new Error("tmux unavailable"); return "tmux fake" }
    if (action === "new-session") {
      const id = `$${this.nextSession++}`; const name = option(args, "-s") ?? id; const windowName = option(args, "-n") ?? "0"
      const window: Window = { id: `@${this.nextWindow++}`, sessionId: id, name: windowName, metadata: new Map(), panes: new Map(), command: args, interactiveAfterCompletion: false }
      this.sessions.set(id, { id, name, metadata: new Map(), windows: new Map([[window.id, window]]) })
      return id
    }
    if (action === "new-window") {
      const session = this.session(option(args, "-t"))!; const id = `@${this.nextWindow++}`; const name = option(args, "-n") ?? id
      session.windows.set(id, { id, sessionId: session.id, name, metadata: new Map(), panes: new Map(), command: args, interactiveAfterCompletion: args.join("\n").includes('exec "${SHELL:-/bin/bash}" -l') })
      return id
    }
    if (action === "split-window") {
      const window = this.window(option(args, "-t"))!; const id = `%${this.nextPane++}`
      window.panes.set(id, { id, windowId: window.id, metadata: new Map(), command: args, dead: false, retained: false })
      return id
    }
    if (action === "set-option") {
      const target = option(args, "-t") ?? this.currentSession; const record = this.record(target); if (!record) return ""
      const targetIndex = args.indexOf("-t"); const key = args[targetIndex + 2]!; const value = args[targetIndex + 3] ?? ""
      if (this.failSetupFor === key) throw new Error("injected setup failure")
      if (key === "remain-on-exit" && "retained" in record) record.retained = value === "on"; else record.metadata.set(key, value)
      return ""
    }
    if (action === "list-sessions") {
      const format = option(args, "-F") ?? "#{session_name}"
      return [...this.sessions.values()].map((session) => this.format(format, { session_id: session.id, session_name: session.name }, session.metadata)).join("\n")
    }
    if (action === "list-windows") {
      const format = option(args, "-F") ?? "#{window_id}"
      return [...this.sessions.values()].flatMap((session) => [...session.windows.values()].map((window) => this.format(format, { session_id: session.id, session_name: session.name, window_id: window.id, window_name: window.name }, window.metadata))).join("\n")
    }
    if (action === "list-panes") {
      const format = option(args, "-F") ?? "#{pane_id}"
      return [...this.sessions.values()].flatMap((session) => [...session.windows.values()].flatMap((window) => [...window.panes.values()].map((pane) => this.format(format, { session_id: session.id, session_name: session.name, window_id: window.id, window_name: window.name, pane_id: pane.id }, pane.metadata)))).join("\n")
    }
    if (action === "display-message") { const target = option(args, "-t"); const format = args.at(-1) ?? ""; const session = this.session(target) ?? (this.window(target) ? this.sessions.get(this.window(target)!.sessionId) : undefined); return format.includes("session_name") ? session?.name ?? "" : this.currentSession }
    if (action === "rename-session") { const session = this.session(option(args, "-t")); if (session) session.name = args.at(-1)!; return "" }
    if (action === "switch-client") { this.attachedTarget = option(args, "-t"); return "" }
    if (action === "send-keys") { this.signalledTargets.push(option(args, "-t")!); return "" }
    if (action === "kill-pane") { const pane = this.pane(option(args, "-t") ?? args.at(-1)); if (pane) this.window(pane.windowId)?.panes.delete(pane.id); return "" }
    if (action === "kill-window") { const window = this.window(option(args, "-t") ?? args.at(-1)); if (window) this.sessions.get(window.sessionId)?.windows.delete(window.id); return "" }
    if (action === "kill-session") { const session = this.session(option(args, "-t") ?? args.at(-1)); if (session) this.sessions.delete(session.id); return "" }
    return ""
  }
}

export class FakePiRuntime {
  readonly events = new EventEmitter(); readonly tools = new Map<string, any>(); readonly commands = new Map<string, any>(); readonly handlers = new Map<string, Array<(event: any, ctx: any) => any>>(); readonly messages: any[] = []; readonly notifications: string[] = []; readonly entries: any[] = []
  readonly context: any
  readonly pi: any
  constructor(options: { sessionId?: string; sessionName?: string; entries?: any[] } = {}) {
    this.entries.push(...(options.entries ?? []))
    this.context = { cwd: "/repo", hasUI: true, model: undefined, ui: { notify: (message: string) => this.notifications.push(message), confirm: async () => true }, sessionManager: { getSessionId: () => options.sessionId ?? "conversation", getSessionName: () => options.sessionName ?? "dotfiles", getBranch: () => this.entries } }
    this.pi = { events: this.events, on: (name: string, handler: (event: any, ctx: any) => any) => this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]), registerTool: (tool: any) => this.tools.set(tool.name, tool), registerCommand: (name: string, command: any) => this.commands.set(name, command), sendMessage: (message: any) => this.messages.push(message), appendEntry: (customType: string, data: unknown) => this.entries.push({ type: "custom", customType, data }), getSessionName: () => options.sessionName ?? "dotfiles", getThinkingLevel: () => "medium" }
  }
  async execute(name: string, params: any) { return this.tools.get(name).execute("call", params, undefined, undefined, this.context) }
  async emit(name: string, event: any = {}) { for (const handler of this.handlers.get(name) ?? []) await handler(event, this.context) }
}
