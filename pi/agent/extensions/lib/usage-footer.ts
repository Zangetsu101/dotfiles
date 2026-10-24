import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type UsageWindow = {
	label: string;
	usedPercent: number;
	resetsAt?: Date;
};

type UsageFooterOptions = {
	statusId: string;
	name: string;
	provider: string;
	query: (ctx: ExtensionContext, model: Model<any>) => Promise<UsageWindow[]>;
};

function formatResetTime(resetsAt: Date): string {
	return resetsAt.toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
}

function formatWindow(window: UsageWindow): string {
	const used = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
	const reset = window.resetsAt ? ` (resets ${formatResetTime(window.resetsAt)})` : "";
	return `${window.label}:${used}%${reset}`;
}

export function registerUsageFooter(pi: ExtensionAPI, { statusId, name, provider, query }: UsageFooterOptions) {
	let inFlight: Promise<void> | undefined;

	function setUsageLine(ctx: ExtensionContext, text: string | undefined): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(statusId, text);
	}

	function subscriptionModel(ctx: ExtensionContext): Model<any> | undefined {
		const model = ctx.model;
		return model && model.provider === provider && ctx.modelRegistry.isUsingOAuth(model) ? model : undefined;
	}

	function renderStatus(ctx: ExtensionContext, windows: UsageWindow[]): string {
		const text = windows.length > 0 ? `${name} used ${windows.map(formatWindow).join(" ")}` : `${name} usage unavailable`;
		const used = Math.max(0, ...windows.map((window) => window.usedPercent));
		const color = used >= 75 ? "error" : "accent";
		return ctx.ui.theme.fg(color, text);
	}

	async function refresh(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const model = subscriptionModel(ctx);
		if (!model) {
			setUsageLine(ctx, undefined);
			return;
		}
		if (inFlight) return inFlight;

		inFlight = (async () => {
			try {
				const windows = await query(ctx, model);
				if (subscriptionModel(ctx)) {
					setUsageLine(ctx, renderStatus(ctx, windows));
				}
			} catch {
				if (subscriptionModel(ctx)) {
					setUsageLine(ctx, ctx.ui.theme.fg("warning", `${name} usage ?`));
				}
			} finally {
				inFlight = undefined;
			}
		})();

		return inFlight;
	}

	async function showLoadingAndRefresh(_event: unknown, ctx: ExtensionContext) {
		if (subscriptionModel(ctx)) {
			setUsageLine(ctx, ctx.ui.theme.fg("accent", `${name} usage …`));
		}
		await refresh(ctx);
	}

	pi.on("session_start", showLoadingAndRefresh);
	pi.on("model_select", showLoadingAndRefresh);

	pi.on("turn_end", async (_event, ctx) => {
		await refresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setUsageLine(ctx, undefined);
	});

	pi.registerCommand(statusId, {
		description: `Refresh ${name} 5h/7d used percentage at the bottom of the footer`,
		handler: async (_args, ctx) => {
			await refresh(ctx);
		},
	});
}
