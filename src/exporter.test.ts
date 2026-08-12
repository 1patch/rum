/**
 * The scrub has to happen at the exporter, so this pins that it actually does —
 * that spans are modified before they are handed on, that the callback still
 * reaches the SDK, and that opting out really opts out.
 */

import { describe, expect, test } from "bun:test";
import { buildExporter, exporterOption, scrubOnExport } from "./exporter.js";

type Span = { attributes: Record<string, unknown> };

function fakeExporter() {
	const sent: Span[][] = [];
	const results: unknown[] = [];
	const exporter = {
		export(spans: Span[], resultCallback: (result: unknown) => void) {
			sent.push(spans);
			resultCallback({ code: 0 });
		},
	};
	return { exporter, sent, results };
}

describe("scrubOnExport", () => {
	test("spans are scrubbed before the real exporter sees them", () => {
		const { exporter, sent } = fakeExporter();
		let scrubbed = 0;
		scrubOnExport(exporter, { scrubQueryStrings: true, onScrub: (n) => (scrubbed = n) });

		const span: Span = { attributes: { "http.url": "https://api.acme.com/run?token=s3cret" } };
		exporter.export([span], () => {});

		expect(sent[0]?.[0]?.attributes["http.url"]).toBe("https://api.acme.com/run?<scrubbed>");
		expect(scrubbed).toBe(1);
	});

	test("the export callback still reaches the caller", () => {
		const { exporter } = fakeExporter();
		scrubOnExport(exporter, { scrubQueryStrings: true });
		let result: unknown;
		exporter.export([{ attributes: {} }], (r) => {
			result = r;
		});
		expect(result).toEqual({ code: 0 });
	});

	test("opting out leaves the exporter untouched", () => {
		const { exporter, sent } = fakeExporter();
		const original = exporter.export;
		scrubOnExport(exporter, { scrubQueryStrings: false });
		expect(exporter.export).toBe(original);

		exporter.export([{ attributes: { "http.url": "https://a.dev/x?t=1" } }], () => {});
		expect(sent[0]?.[0]?.attributes["http.url"]).toBe("https://a.dev/x?t=1");
	});

	// A malformed span must not take the whole batch down with it — losing one
	// span's scrub is recoverable, throwing inside the export path is not.
	test("a span with no usable attributes is skipped, not thrown on", () => {
		const { exporter, sent } = fakeExporter();
		scrubOnExport(exporter, { scrubQueryStrings: true });
		const spans = [
			null,
			{ attributes: null },
			{ attributes: { "http.url": "https://a.dev/x?t=1" } },
		] as unknown as Span[];
		expect(() => exporter.export(spans, () => {})).not.toThrow();
		expect(sent[0]?.[2]?.attributes["http.url"]).toBe("https://a.dev/x?<scrubbed>");
	});
});

describe("buildExporter", () => {
	test("produces a real exporter pointed at the traces endpoint", () => {
		const exporter = buildExporter(
			{ url: "https://acme.logger.onepatch.dev/v1/traces", authHeader: "op_test" },
			{ scrubQueryStrings: true },
		);
		expect(typeof exporter.export).toBe("function");
		expect(typeof exporter.shutdown).toBe("function");
	});

	test("exporterOption hands the SDK a factory it will call", () => {
		const option = exporterOption({ scrubQueryStrings: true }) as unknown as {
			factory: (config: { url: string }) => { export: unknown };
		};
		const built = option.factory({ url: "https://acme.logger.onepatch.dev/v1/traces" });
		expect(typeof built.export).toBe("function");
	});
});
