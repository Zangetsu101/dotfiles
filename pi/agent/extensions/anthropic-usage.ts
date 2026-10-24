import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type UsageWindow = {
	utilization: number;
	resets_at: string | null;
};

type UsageResponse = {
	five_hour?: UsageWindow | null;
	seven_day?: UsageWindow | null;
};

const STATUS_ID = "anthropic-usage";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 8000;

function formatResetTime(resetsAt: string | null): string | undefined {
	if (!resetsAt) return undefined;
	return new Date(resetsAt).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
}

function formatWindow(label: string, window: UsageWindow): string {
	const used = Math.round(Math.max(0, Math.min(100, window.utilization)));
	const resetTime = label === "5h" ? formatResetTime(window.resets_at) : undefined;
	return `${label}:${used}%${resetTime ? ` (resets ${resetTime})` : ""}`;
}

async function queryAnthropicUsage(ctx: ExtensionContext): Promise<UsageResponse> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
	if (!auth.ok || !auth.apiKey) throw new Error("Anthropic OAuth token unavailable");

	const response = await fetch(USAGE_URL, {
		headers: {
			Authorization: `Bearer ${auth.apiKey}`,
			"anthropic-beta": "oauth-2025-04-20",
		},
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Anthropic usage request failed with status ${response.status}`);
	return (await response.json()) as UsageResponse;
}

function renderStatus(ctx: ExtensionContext, usage: UsageResponse): string {
	const windows: [string, UsageWindow | null | undefined][] = [
		["5h", usage.five_hour],
		["7d", usage.seven_day],
	];
	const parts = windows
		.filter((entry): entry is [string, UsageWindow] => Boolean(entry[1]))
		.map(([label, window]) => formatWindow(label, window));

	const text = parts.length > 0 ? `Claude used ${parts.join(" ")}` : "Claude usage unavailable";
	const used = Math.max(usage.five_hour?.utilization ?? 0, usage.seven_day?.utilization ?? 0);
	const color = used >= 75 ? "error" : "accent";
	return ctx.ui.theme.fg(color, text);
}

function setUsageLine(ctx: ExtensionContext, text: string | undefined): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_ID, text);
}

function isAnthropicSubscriptionSession(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	return Boolean(model && model.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(model));
}

export default function anthropicUsageExtension(pi: ExtensionAPI) {
	let inFlight: Promise<void> | undefined;

	async function refresh(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!isAnthropicSubscriptionSession(ctx)) {
			setUsageLine(ctx, undefined);
			return;
		}
		if (inFlight) return inFlight;

		inFlight = (async () => {
			try {
				const usage = await queryAnthropicUsage(ctx);
				if (isAnthropicSubscriptionSession(ctx)) {
					setUsageLine(ctx, renderStatus(ctx, usage));
				}
			} catch {
				if (isAnthropicSubscriptionSession(ctx)) {
					setUsageLine(ctx, ctx.ui.theme.fg("warning", "Claude usage ?"));
				}
			} finally {
				inFlight = undefined;
			}
		})();

		return inFlight;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (isAnthropicSubscriptionSession(ctx)) {
			setUsageLine(ctx, ctx.ui.theme.fg("accent", "Claude usage …"));
		}
		await refresh(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (isAnthropicSubscriptionSession(ctx)) {
			setUsageLine(ctx, ctx.ui.theme.fg("accent", "Claude usage …"));
		}
		await refresh(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await refresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setUsageLine(ctx, undefined);
	});

	pi.registerCommand("anthropic-usage", {
		description: "Refresh Claude 5h/7d used percentage at the bottom of the footer",
		handler: async (_args, ctx) => {
			await refresh(ctx);
		},
	});
}
