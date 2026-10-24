import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { registerUsageFooter, type UsageWindow } from "./lib/usage-footer.ts";

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

function resetDate(resetsAt: number | null): Date | undefined {
	if (!resetsAt) return undefined;
	return new Date(resetsAt > 1_000_000_000_000 ? resetsAt : resetsAt * 1000);
}

function toUsageWindow(window: RateLimitWindow): UsageWindow {
	return {
		label: labelForWindow(window),
		usedPercent: window.usedPercent,
		resetsAt: window.windowDurationMins === 300 ? resetDate(window.resetsAt) : undefined,
	};
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

export default function codexUsageExtension(pi: ExtensionAPI) {
	registerUsageFooter(pi, {
		statusId: "codex-usage",
		name: "Codex",
		isSession: (ctx, model) => model.provider === "openai-codex" && ctx.modelRegistry.isUsingOAuth(model),
		query: async () => {
			const snapshot = await queryCodexRateLimits();
			return [snapshot.primary, snapshot.secondary]
				.filter((window): window is RateLimitWindow => Boolean(window))
				.map(toUsageWindow);
		},
	});
}
