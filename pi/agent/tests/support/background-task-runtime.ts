import { EventEmitter } from "node:events"
import { writeFile } from "node:fs/promises"
import type { TmuxProcessAdapter } from "../../extensions/lib/background-task.ts"
type Window = { name: string; target: string; metadata: Map<string, string>; command: string[]; dead: boolean; retained: boolean; interactiveAfterCompletion: boolean }
type Session = { target: string; metadata: Map<string, string>; windows: Map<string, Window> }
export class FakeTmuxProcessAdapter implements TmuxProcessAdapter {
  readonly sessions = new Map<string, Session>(); readonly signalledTargets: string[] = []; available = true; currentSession = "parent"; attachedTarget?: string; failSetupFor?: string
  hubs() { return [...this.sessions.values()].filter((s) => s.metadata.has("@pi_task_hub_id")).map((s) => ({ target: s.target, owner: s.metadata.get("@pi_task_hub_owner"), tasks: [...s.windows.values()].filter((w) => w.metadata.has("@pi_task_id")) })) }
  tasks() { return this.hubs().flatMap((hub) => hub.tasks.map((window) => ({ hub, window }))).map(({ hub, window }) => ({ target: `${hub.target}:${[...this.sessions.get(hub.target)!.windows.values()].indexOf(window)}`, kind: window.metadata.get("@pi_task_kind"), label: window.metadata.get("@pi_task_label"), status: window.metadata.get("@pi_task_status"), owner: window.metadata.get("@pi_task_owner"), dead: window.dead, retained: window.retained, interactiveAfterCompletion: window.interactiveAfterCompletion })) }
  private window(target: string) { const split = target.indexOf(":"); if (split < 0) return undefined; const windows = this.sessions.get(target.slice(0, split))?.windows; const selector = target.slice(split + 1); return windows?.get(selector) ?? (Number.isInteger(Number(selector)) ? [...(windows?.values() ?? [])][Number(selector)] : undefined) }
  async complete(target: string, status: "completed" | "failed" = "completed", output = "") { const window = this.window(target); if (!window) throw new Error(`unknown task target: ${target}`); window.dead = !window.interactiveAfterCompletion; window.metadata.set("@pi_task_status", status); const outputFile = window.metadata.get("@pi_task_output_file"); if (outputFile) await writeFile(outputFile, output); const file = window.metadata.get("@pi_task_status_file"); if (file) await writeFile(file, JSON.stringify(window.metadata.get("@pi_task_kind") === "agent" ? { kind: status === "completed" ? "settled" : "exit", output, exitCode: status === "completed" ? 0 : 1 } : { status, exitCode: status === "completed" ? 0 : 1 })) }
  async run(args: string[]): Promise<string> {
    const action = args[0]; if (action === "-V") { if (!this.available) throw new Error("tmux unavailable"); return "tmux fake" }
    if (action === "new-session") { const target = args[args.indexOf("-s") + 1]!; const name = args[args.indexOf("-n") + 1] ?? "0"; this.sessions.set(target, { target, metadata: new Map(), windows: new Map([[name, { name, target: `${target}:${name}`, metadata: new Map(), command: args, dead: false, retained: false, interactiveAfterCompletion: false }]]) }); return "" }
    if (action === "new-window") { const hub = args[args.indexOf("-t") + 1]!; const name = args[args.indexOf("-n") + 1]!; this.sessions.get(hub)!.windows.set(name, { name, target: `${hub}:${name}`, metadata: new Map(), command: args, dead: false, retained: false, interactiveAfterCompletion: args.join("\n").includes('exec "${SHELL:-/bin/bash}" -l') }); return "" }
    if (action === "set-option") { const targetIndex = args.indexOf("-t"); const target = targetIndex >= 0 ? args[targetIndex + 1]! : this.currentSession; const windowScoped = args.includes("-w") || args.includes("-p"); const record = windowScoped ? this.window(target) : this.sessions.get(target); if (!record) return ""; const key = args[targetIndex + 2]!; if (this.failSetupFor === key) throw new Error("injected setup failure"); const value = args[targetIndex + 3] ?? ""; if (key === "remain-on-exit" && args.includes("-p")) (record as Window).retained = value === "on"; else record.metadata.set(key, value); return "" }
    if (action === "list-sessions") { const format = args.at(-1) ?? ""; return [...this.sessions.values()].map((s) => {
      if (format.includes("@pi_task_kind")) return [s.target, ...["kind", "id", "label", "status", "owner", "parent", "cwd", "status_file", "output_file"].map((key) => s.metadata.get(`@pi_task_${key}`) ?? ""), s.metadata.get("@pi_task_hub_id") ?? ""].join("\t")
      return format.includes("@pi_task_hub_id") ? [s.target, s.metadata.get("@pi_task_hub_id") ?? "", s.metadata.get("@pi_task_hub_owner") ?? ""].join("\t") : s.target
    }).join("\n") }
    if (action === "list-windows") { const format = args.at(-1) ?? ""; return [...this.sessions.values()].flatMap((s) => [...s.windows.values()].map((w, index) => { const target = format.includes("#{window_index}") ? `${s.target}:${index}` : w.target; if (format.includes("@pi_agent_status")) return [target, w.metadata.get("@pi_agent_status") ?? "", w.metadata.get("@pi_agent_model") ?? "", w.metadata.get("@pi_agent_thinking") ?? ""].join("\t"); return [target, ...["kind", "id", "label", "status", "owner", "parent", "cwd", "status_file", "output_file"].map((key) => w.metadata.get(`@pi_task_${key}`) ?? "")].join("\t") })).join("\n") }
    if (action === "display-message") return this.currentSession
    if (action === "switch-client") { this.attachedTarget = args.at(-1); return "" }
    if (action === "send-keys") { this.signalledTargets.push(args[args.indexOf("-t") + 1]!); return "" }
    if (action === "kill-window") { const target = args.at(-1)!; const i = target.indexOf(":"); const session = this.sessions.get(target.slice(0, i)); const window = this.window(target); if (session && window) session.windows.delete(window.name); if (session && session.windows.size === 0) this.sessions.delete(session.target); return "" }
    if (action === "kill-session") { this.sessions.delete(args.at(-1)!); return "" }
    return ""
  }
}
export class FakePiRuntime {
  readonly events = new EventEmitter(); readonly tools = new Map<string, any>(); readonly commands = new Map<string, any>(); readonly handlers = new Map<string, Array<(event: any, ctx: any) => any>>(); readonly messages: any[] = []; readonly notifications: string[] = []
  readonly context = { cwd: "/repo", hasUI: true, model: undefined, ui: { notify: (message: string) => this.notifications.push(message), confirm: async () => true }, sessionManager: { getBranch: () => [] } }
  readonly pi = { events: this.events, on: (name: string, handler: (event: any, ctx: any) => any) => this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]), registerTool: (tool: any) => this.tools.set(tool.name, tool), registerCommand: (name: string, command: any) => this.commands.set(name, command), sendMessage: (message: any) => this.messages.push(message), getThinkingLevel: () => "medium" } as any
  async execute(name: string, params: any) { return this.tools.get(name).execute("call", params, undefined, undefined, this.context) }
  async emit(name: string, event: any = {}) { for (const handler of this.handlers.get(name) ?? []) await handler(event, this.context) }
}
