import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerUsageFooter, type UsageWindow } from "./lib/usage-footer.ts";

type AnthropicUsageWindow = {
	utilization: number;
	resets_at: string | null;
};

type UsageResponse = {
	five_hour?: AnthropicUsageWindow | null;
	seven_day?: AnthropicUsageWindow | null;
};

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 8000;

async function queryAnthropicUsage(ctx: ExtensionContext, model: Model<any>): Promise<UsageWindow[]> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) throw new Error("Anthropic OAuth token unavailable");

	const response = await fetch(USAGE_URL, {
		headers: {
			Authorization: `Bearer ${auth.apiKey}`,
			"anthropic-beta": "oauth-2025-04-20",
		},
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Anthropic usage request failed with status ${response.status}`);

	const usage = (await response.json()) as UsageResponse;
	const windows: UsageWindow[] = [];
	if (usage.five_hour) {
		windows.push({
			label: "5h",
			usedPercent: usage.five_hour.utilization,
			resetsAt: usage.five_hour.resets_at ? new Date(usage.five_hour.resets_at) : undefined,
		});
	}
	if (usage.seven_day) windows.push({ label: "7d", usedPercent: usage.seven_day.utilization });
	return windows;
}

export default function anthropicUsageExtension(pi: ExtensionAPI) {
	registerUsageFooter(pi, {
		statusId: "anthropic-usage",
		name: "Claude",
		provider: "anthropic",
		query: queryAnthropicUsage,
	});
}
