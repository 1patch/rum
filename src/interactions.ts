import type { Span } from "@opentelemetry/api";

// Mouse down/up repeat a click without adding product intent. Keep the actual
// action events and their existing active-span/request correlation.
export const interactionInstrumentation = {
	eventNames: [
		"click",
		"dblclick",
		"submit",
		"reset",
		"change",
		"dragend",
		"drop",
		"ended",
		"pause",
		"play",
	] as (keyof HTMLElementEventMap)[],
	shouldPreventSpanCreation: (_event: string, element: HTMLElement, span: Span): boolean => {
		try {
			// Only an explicit, developer-authored label. Never read textContent,
			// value, aria-label or a table row, which can contain customer data.
			const control = element.closest("[data-op-rum-label]");
			const label = control
				?.getAttribute("data-op-rum-label")
				?.replace(/\s+/g, " ")
				.trim()
				.slice(0, 120);
			if (label) span.setAttribute("target.label", label);
		} catch {
			// A detached or unusual DOM element cannot break its event handler.
		}
		return false;
	},
};
