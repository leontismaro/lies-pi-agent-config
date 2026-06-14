import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface ClearableContainer {
	clear(): void;
}

interface TuiRoot {
	children?: unknown[];
	requestRender(force?: boolean): void;
}

function isClearableContainer(value: unknown): value is ClearableContainer {
	return typeof value === "object" && value !== null && typeof (value as ClearableContainer).clear === "function";
}

function clearVisibleConversation(tui: TuiRoot): void {
	const [_header, chat, pendingMessages, status] = tui.children ?? [];

	for (const container of [chat, pendingMessages, status]) {
		if (isClearableContainer(container)) {
			container.clear();
		}
	}
}

async function redrawTerminalScreen(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") return;

	await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
		clearVisibleConversation(tui);
		tui.requestRender(true);
		done();
		return { render: () => [] };
	});
}

export default function clearScreenExtension(pi: ExtensionAPI) {
	pi.registerCommand("clear-screen", {
		description: "Redraw terminal screen without resetting session context",
		handler: async (_args, ctx) => redrawTerminalScreen(ctx),
	});

	pi.registerShortcut("ctrl+l", {
		description: "Redraw terminal screen without resetting session context",
		handler: async (ctx) => redrawTerminalScreen(ctx),
	});
}
