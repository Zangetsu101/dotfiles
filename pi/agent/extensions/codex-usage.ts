import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

type RateLimitWindow = {
	usedPercent: number;
	windowDurationMins: number | null;
	resetsAt: number | null;
};

type RateLimitSnapshot = {
	primary?: RateLimitWindow | null;
	secondary?: RateLimitWindow | null;
	limitId?: string | null;
	planType?: string | null;
};

type RateLimitResponse = {
	rateLimits: RateLimitSnapshot;
	rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
};

const STATUS_ID = "codex-usage";
const TIMEOUT_MS = 8000;

function labelForWindow(window: RateLimitWindow): string {
	if (window.windowDurationMins === 300) return "5h";
	if (window.windowDurationMins === 10080) return "7d";
	if (window.windowDurationMins && window.windowDurationMins % 1440 === 0) {
		return `${window.windowDurationMins / 1440}d`;
	}
	if (window.windowDurationMins && window.windowDurationMins % 60 === 0) {
		return `${window.windowDurationMins / 60}h`;
	}
	return window.windowDurationMins ? `${window.windowDurationMins}m` : "?";
}

function formatResetTime(resetsAt: number | null): string | undefined {
	if (!resetsAt) return undefined;

	const resetMs = resetsAt > 1_000_000_000_000 ? resetsAt : resetsAt * 1000;
	return new Date(resetMs).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
}

function formatWindow(window: RateLimitWindow): string {
	const used = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
	const resetTime = window.windowDurationMins === 300 ? formatResetTime(window.resetsAt) : undefined;
	return `${labelForWindow(window)}:${used}%${resetTime ? ` (resets ${resetTime})` : ""}`;
}

function pickCodexLimit(response: RateLimitResponse): RateLimitSnapshot {
	return response.rateLimitsByLimitId?.codex ?? response.rateLimits;
}

function queryCodexRateLimits(): Promise<RateLimitSnapshot> {
	return new Promise((resolve, reject) => {
		const child = spawn("codex", ["app-server", "--stdio"], {
			stdio: ["pipe", "pipe", "ignore"],
		});

		let settled = false;
		let buffer = "";
		const timeout = setTimeout(() => finish(new Error("Timed out querying Codex rate limits")), TIMEOUT_MS);

		function finish(error?: Error, snapshot?: RateLimitSnapshot) {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.kill();
			if (error) reject(error);
			else resolve(snapshot!);
		}

		child.on("error", (error) => finish(error));
		child.on("exit", (code) => {
			if (!settled) finish(new Error(`Codex app-server exited with code ${code ?? "unknown"}`));
		});

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (!line) continue;

				let message: any;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}

				if (message.id === 2) {
					if (message.error) {
						finish(new Error(message.error.message ?? "Codex rate-limit query failed"));
					} else {
						finish(undefined, pickCodexLimit(message.result as RateLimitResponse));
					}
				}
			}
		});

		const initialize = {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				clientInfo: { name: "pi-codex-usage", version: "1" },
				capabilities: { experimentalApi: true },
			},
		};
		const readLimits = {
			jsonrpc: "2.0",
			id: 2,
			method: "account/rateLimits/read",
			params: null,
		};

		child.stdin.write(`${JSON.stringify(initialize)}\n`);
		child.stdin.write(`${JSON.stringify(readLimits)}\n`);
	});
}

function renderStatus(ctx: ExtensionContext, snapshot: RateLimitSnapshot): string {
	const windows = [snapshot.primary, snapshot.secondary]
		.filter((window): window is RateLimitWindow => Boolean(window))
		.map(formatWindow);

	const text = windows.length > 0 ? `Codex used ${windows.join(" ")}` : "Codex usage unavailable";
	const used = Math.max(snapshot.primary?.usedPercent ?? 0, snapshot.secondary?.usedPercent ?? 0);
	const color = used >= 75 ? "error" : "accent";
	return ctx.ui.theme.fg(color, text);
}

function isCodexSubscriptionSession(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	return Boolean(model && model.provider === "openai-codex" && ctx.modelRegistry.isUsingOAuth(model));
}

export default function codexUsageExtension(pi: ExtensionAPI) {
	let inFlight: Promise<void> | undefined;

	async function refresh(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!isCodexSubscriptionSession(ctx)) {
			ctx.ui.setStatus(STATUS_ID, undefined);
			return;
		}
		if (inFlight) return inFlight;

		inFlight = (async () => {
			try {
				const snapshot = await queryCodexRateLimits();
				if (isCodexSubscriptionSession(ctx)) {
					ctx.ui.setStatus(STATUS_ID, renderStatus(ctx, snapshot));
				}
			} catch {
				if (isCodexSubscriptionSession(ctx)) {
					ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", "Codex usage ?"));
				}
			} finally {
				inFlight = undefined;
			}
		})();

		return inFlight;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (isCodexSubscriptionSession(ctx)) {
			ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", "Codex usage …"));
		}
		await refresh(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (isCodexSubscriptionSession(ctx)) {
			ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", "Codex usage …"));
		}
		await refresh(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await refresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_ID, undefined);
	});

	pi.registerCommand("codex-usage", {
		description: "Refresh Codex 5h/7d used percentage in the footer",
		handler: async (_args, ctx) => {
			await refresh(ctx);
		},
	});
}
