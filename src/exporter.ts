/**
 * The one chokepoint every span passes through on its way out.
 *
 * The underlying SDK advertises an `onAttributesSerializing` hook for exactly
 * this purpose and then never calls it — its default exporter factory drops the
 * option on the floor. Injecting a span processor doesn't work either: the
 * provider is constructed with an explicit `spanProcessors` key that overrides
 * anything passed alongside it. So we replace the exporter factory, which is a
 * documented option, and patch the built exporter's `export` on the way past.
 *
 * Patching the instance rather than wrapping it in a new object is deliberate:
 * the batch processor holds onto this exporter and pokes at more of it than the
 * `SpanExporter` interface names, so it needs to stay the same object.
 */

import type { RumOtelWebExporterOptions } from "@hyperdx/otel-web";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { scrubAttributes } from "./scrub.js";

export type ScrubOptions = {
	scrubQueryStrings: boolean;
	onScrub?: (count: number) => void;
	/**
	 * Hold the first export until this settles — the identity gate.
	 *
	 * Without it the head of every session is anonymous: the document-load spans
	 * exist before any session request can have answered. The first caller to wire
	 * identity found exactly that — "only the first ~2s of page-load spans stay
	 * anonymous" — and a rule with a two-second hole in it is not a rule.
	 *
	 * See `identityGate` in ./index.ts for what bounds the wait. Whatever happens
	 * there, this defers a batch; it never drops one.
	 */
	waitFor?: Promise<unknown>;
	/**
	 * Who to stamp on a held span, read at export rather than at span creation.
	 *
	 * Waiting is not enough on its own, which cost a staging verification to
	 * learn: the underlying SDK copies global attributes onto a span in its
	 * processor's `onStart`, so a span that had already STARTED when identity
	 * arrived stays anonymous however long its batch is held. `documentLoad`,
	 * `documentFetch`, `resourceFetch` and `webvitals` all start at init, which is
	 * every span of the first page load.
	 *
	 * So the gate delays, and this fills in. Only keys the span is missing: a
	 * span that started after a later `identifyUser` already carries that
	 * person's attributes, and the older stamp must not overwrite them.
	 */
	identity?: () => Record<string, unknown> | null;
	/**
	 * Drop `resourceFetch` spans faster than this, in milliseconds.
	 *
	 * A page load emits one of these per stylesheet, font and chunk — seven per
	 * load on our own app, the same seven every time, forever. The slow ones earn
	 * their place: `documentLoad` tells you the page took 1.6s, and only the
	 * asset spans tell you which font it was waiting on. The fast ones are the
	 * same cache hit re-recorded on every visit by every visitor.
	 *
	 * A span whose status is not UNSET is always kept — a failed asset is the
	 * whole reason to look, and Resource Timing gives no status code to filter on
	 * afterwards.
	 */
	assetFloorMs?: number;
};

/** `ExportResultCode.SUCCESS`, without a dependency on the SDK's enum. */
const EXPORT_SUCCESS = { code: 0 };

/** The vendor instrumentation's name for a page asset — a stylesheet, font or chunk. */
const ASSET_SPAN = "resourceFetch";

/**
 * The SDK's `exporter` option carries a `factory` — it is read at runtime and
 * documented on the internal config type, but absent from the public `init`
 * signature. This function is the only place that gap is papered over.
 */
export function exporterOption(options: ScrubOptions): RumOtelWebExporterOptions {
	return {
		factory: (config: ExporterFactoryConfig) => buildExporter(config, options),
	} as RumOtelWebExporterOptions;
}

/**
 * The shape the SDK hands its exporter factory. Declared here rather than
 * imported because it belongs to the SDK's internal config type, which the
 * public `init` signature does not expose.
 */
export type ExporterFactoryConfig = { url: string; authHeader?: string };

/** As much of a span as scrubbing and the asset floor need to see. */
type SpanWithAttributes = {
	attributes: Record<string, unknown>;
	name?: string;
	/** OpenTelemetry's `HrTime`: `[seconds, nanoseconds]`. */
	duration?: [number, number];
	status?: { code?: number };
};

/**
 * Whether this span is a page asset fast enough to be worth nothing. Anything
 * that isn't recognisably a timed, successful `resourceFetch` is kept — an
 * unreadable span is not a reason to lose one.
 */
function isQuietAsset(span: SpanWithAttributes | null | undefined, floorMs: number): boolean {
	if (span === null || span === undefined) return false;
	if (span.name !== ASSET_SPAN) return false;
	// UNSET is 0. Anything else means the asset failed, which is the case the
	// floor exists to preserve.
	if (span.status !== undefined && span.status !== null && (span.status.code ?? 0) !== 0) {
		return false;
	}
	const duration = span.duration;
	if (!Array.isArray(duration) || duration.length !== 2) return false;
	const ms = duration[0] * 1000 + duration[1] / 1e6;
	if (!Number.isFinite(ms)) return false;
	return ms < floorMs;
}

type ExportCallback = (result: unknown) => void;

type PatchableExporter = {
	export: (spans: SpanWithAttributes[], resultCallback: ExportCallback) => void;
};

/**
 * Build the exporter the SDK will use, scrubbing query strings out of every
 * URL-shaped attribute unless the caller opted out.
 */
export function buildExporter(
	config: ExporterFactoryConfig,
	options: ScrubOptions,
): OTLPTraceExporter {
	const exporter = new OTLPTraceExporter({
		url: config.url,
		headers: { authorization: config.authHeader ?? "" },
	});
	return scrubOnExport(exporter, options);
}

/**
 * Patch one exporter's `export` so every span is scrubbed on its way out.
 * Separate from `buildExporter` so it can be tested without a live exporter.
 */
export function scrubOnExport<E>(exporter: E, options: ScrubOptions): E {
	const floorMs = options.assetFloorMs ?? 0;
	if (
		!options.scrubQueryStrings &&
		options.waitFor === undefined &&
		options.identity === undefined &&
		floorMs <= 0
	) {
		return exporter;
	}

	const patchable = exporter as unknown as PatchableExporter;
	const send = patchable.export.bind(exporter);
	// The gate opens once, and every batch that arrives before it does waits —
	// not just the first. A second batch cutting ahead would be exactly the
	// anonymous-spans bug again, on a slower connection. Promise callbacks run
	// FIFO, so held batches keep their order.
	const gate = options.waitFor;
	let open = gate === undefined;
	if (gate !== undefined) {
		const openIt = () => {
			open = true;
		};
		void gate.then(openIt, openIt);
	}
	patchable.export = (batch, resultCallback) => {
		const deliver = () => {
			const spans = floorMs > 0 ? batch.filter((span) => !isQuietAsset(span, floorMs)) : batch;
			// A batch of nothing but cache hits is a POST worth not making.
			if (spans.length === 0 && batch.length > 0) {
				resultCallback(EXPORT_SUCCESS);
				return;
			}
			const identity = options.identity?.() ?? null;
			if (identity !== null) {
				for (const span of spans) {
					if (span === null || span === undefined) continue;
					if (span.attributes === null || typeof span.attributes !== "object") continue;
					for (const [key, value] of Object.entries(identity)) {
						if (span.attributes[key] === undefined) span.attributes[key] = value;
					}
				}
			}
			if (options.scrubQueryStrings) {
				let scrubbed = 0;
				for (const span of spans) {
					// A span whose attributes aren't a plain object isn't ours to touch.
					if (span === null || span === undefined) continue;
					if (span.attributes === null || typeof span.attributes !== "object") continue;
					scrubbed += scrubAttributes(span.attributes);
				}
				if (scrubbed > 0) options.onScrub?.(scrubbed);
			}
			send(spans, resultCallback);
		};
		if (open || gate === undefined) {
			deliver();
			return;
		}
		// `.then` on both paths: a rejected gate must still deliver the batch.
		// Telemetry is never the thing that gets dropped here.
		void gate.then(deliver, deliver);
	};
	return exporter;
}
