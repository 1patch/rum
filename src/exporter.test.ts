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

	test("opting out of both scrubbing and the gate leaves the exporter untouched", () => {
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

// The identity gate. Every span in the buffer when it opens gets the person
// stamped on it; a batch that goes out before then is anonymous forever, which is
// what made the first ~2s of every one of our own sessions unattributable.
describe("the identity gate", () => {
	test("the first batch waits, and goes out when the gate opens", async () => {
		const { exporter, sent } = fakeExporter();
		let open: (() => void) | undefined;
		const wait = new Promise<void>((resolve) => {
			open = resolve;
		});
		scrubOnExport(exporter, { scrubQueryStrings: false, waitFor: wait });

		exporter.export([{ attributes: { a: 1 } }], () => {});
		await Promise.resolve();
		expect(sent).toHaveLength(0);

		open?.();
		await wait;
		await Promise.resolve();
		expect(sent).toHaveLength(1);
	});

	// A second batch cutting ahead of a held first one would be the same bug on a
	// slower connection, so everything before the gate opens waits, in order.
	test("every batch before the gate waits, and keeps its order", async () => {
		const { exporter, sent } = fakeExporter();
		let open: (() => void) | undefined;
		const wait = new Promise<void>((resolve) => {
			open = resolve;
		});
		scrubOnExport(exporter, { scrubQueryStrings: false, waitFor: wait });

		exporter.export([{ attributes: { n: 1 } }], () => {});
		exporter.export([{ attributes: { n: 2 } }], () => {});
		await Promise.resolve();
		expect(sent).toHaveLength(0);

		open?.();
		await wait;
		await Promise.resolve();
		await Promise.resolve();
		expect(sent.map((batch) => batch[0]?.attributes.n)).toEqual([1, 2]);
	});

	test("batches after the gate opens are not delayed at all", async () => {
		const { exporter, sent } = fakeExporter();
		const wait = Promise.resolve();
		scrubOnExport(exporter, { scrubQueryStrings: false, waitFor: wait });
		await wait;
		await Promise.resolve();

		exporter.export([{ attributes: { a: 1 } }], () => {});
		expect(sent).toHaveLength(1);
	});

	// Telemetry is never what gets dropped: a gate that rejects still delivers.
	test("a rejected gate delivers the batch anyway", async () => {
		const { exporter, sent } = fakeExporter();
		const wait = Promise.reject(new Error("resolver blew up"));
		scrubOnExport(exporter, { scrubQueryStrings: false, waitFor: wait });

		exporter.export([{ attributes: { a: 1 } }], () => {});
		await wait.catch(() => {});
		await Promise.resolve();
		expect(sent).toHaveLength(1);
	});

	test("held spans are still scrubbed on the way out", async () => {
		const { exporter, sent } = fakeExporter();
		let open: (() => void) | undefined;
		const wait = new Promise<void>((resolve) => {
			open = resolve;
		});
		scrubOnExport(exporter, { scrubQueryStrings: true, waitFor: wait });

		exporter.export([{ attributes: { "http.url": "https://a.dev/x?t=1" } }], () => {});
		open?.();
		await wait;
		await Promise.resolve();
		expect(sent[0]?.[0]?.attributes["http.url"]).toBe("https://a.dev/x?<scrubbed>");
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
