import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function formatContextUsage(tokens: number | null, total: number, percent: number | null): string {
	const used = tokens === null ? "?" : formatTokens(tokens);
	const pct = percent === null ? "?" : percent.toFixed(1);
	return `${used}/${formatTokens(total)} (${pct}%)`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	if (!home) return cwd;

	const relativeToHome = relative(resolve(home), resolve(cwd));
	if (relativeToHome === "") return "~";
	if (relativeToHome === ".." || relativeToHome.startsWith(`..${sep}`)) return cwd;
	return `~${sep}${relativeToHome}`;
}

function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => ({
			dispose: footerData.onBranchChange(() => tui.requestRender()),
			invalidate() {},
			render(width: number): string[] {
				let input = 0;
				let output = 0;
				let cacheRead = 0;
				let cacheWrite = 0;
				let cost = 0;
				let latestCacheHitRate: number | undefined;

				for (const entry of ctx.sessionManager.getEntries()) {
					if (entry.type !== "message" || entry.message.role !== "assistant") continue;
					const message = entry.message as AssistantMessage;
					input += message.usage.input;
					output += message.usage.output;
					cacheRead += message.usage.cacheRead;
					cacheWrite += message.usage.cacheWrite;
					cost += message.usage.cost.total;
					const promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
					latestCacheHitRate = promptTokens > 0 ? (message.usage.cacheRead / promptTokens) * 100 : undefined;
				}

				let pwd = formatCwd(ctx.cwd);
				const branch = footerData.getGitBranch();
				if (branch) pwd += ` (${branch})`;
				const sessionName = pi.getSessionName();
				if (sessionName) pwd += ` • ${sessionName}`;

				const parts: string[] = [];
				if (input) parts.push(`↑${formatTokens(input)}`);
				if (output) parts.push(`↓${formatTokens(output)}`);
				if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
				if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
				if ((cacheRead || cacheWrite) && latestCacheHitRate !== undefined) {
					parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
				}
				if (cost) parts.push(`$${cost.toFixed(3)}`);

				const usage = ctx.getContextUsage();
				const total = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const percent = usage?.percent ?? null;
				const context = formatContextUsage(usage?.tokens ?? null, total, percent);
				parts.push(percent !== null && percent > 90
					? theme.fg("error", context)
					: percent !== null && percent > 70
						? theme.fg("warning", context)
						: context);

				let left = parts.join(" ");
				if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");

				const modelName = ctx.model?.id ?? "no-model";
				const thinking = ctx.model?.reasoning ? pi.getThinkingLevel() : undefined;
				const modelWithThinking = thinking ? `${modelName} • ${thinking === "off" ? "thinking off" : thinking}` : modelName;
				const withProvider = ctx.model && footerData.getAvailableProviderCount() > 1
					? `(${ctx.model.provider}) ${modelWithThinking}`
					: modelWithThinking;
				const right = visibleWidth(left) + 2 + visibleWidth(withProvider) <= width ? withProvider : modelWithThinking;
				const available = Math.max(0, width - visibleWidth(left) - 2);
				const shownRight = truncateToWidth(right, available, "");
				const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(shownRight)));

				const lines = [
					truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
					theme.fg("dim", left) + theme.fg("dim", padding + shownRight),
				];
				const statuses = [...footerData.getExtensionStatuses().entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, text]) => sanitizeStatus(text));
				if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
				return lines;
			},
		}));
	});
}
