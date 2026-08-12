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

export type ScrubOptions = { scrubQueryStrings: boolean; onScrub?: (count: number) => void };

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

/** As much of a span as scrubbing needs to see. */
type SpanWithAttributes = { attributes: Record<string, unknown> };

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
	if (!options.scrubQueryStrings) return exporter;

	const patchable = exporter as unknown as PatchableExporter;
	const send = patchable.export.bind(exporter);
	patchable.export = (spans, resultCallback) => {
		let scrubbed = 0;
		for (const span of spans) {
			// A span whose attributes aren't a plain object isn't ours to touch.
			if (span === null || span === undefined) continue;
			if (span.attributes === null || typeof span.attributes !== "object") continue;
			scrubbed += scrubAttributes(span.attributes);
		}
		if (scrubbed > 0) options.onScrub?.(scrubbed);
		send(spans, resultCallback);
	};
	return exporter;
}
