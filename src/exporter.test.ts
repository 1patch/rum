/**
 * The scrub has to happen at the exporter, so this pins that it actually does —
 * that spans are modified before they are handed on, that the callback still
 * reaches the SDK, and that opting out really opts out.
 */

import { describe, expect, test } from "bun:test";
import { buildExporter, exporterOption, scrubOnExport } from "./exporter.js";

type Span = {
	attributes: Record<string, unknown>;
	name?: string;
	duration?: [number, number];
	status?: { code?: number };
};

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

	// The bug a staging verification found: holding a batch is not stamping it.
	// The underlying SDK copies global attributes in `onStart`, so a span that had
	// already started when identity arrived went out anonymous however long it
	// waited — which is every span of the first page load.
	test("a span that started before identity is stamped on the way out", async () => {
		const { exporter, sent } = fakeExporter();
		let open: (() => void) | undefined;
		const wait = new Promise<void>((resolve) => {
			open = resolve;
		});
		let identity: Record<string, unknown> | null = null;
		scrubOnExport(exporter, {
			scrubQueryStrings: false,
			waitFor: wait,
			identity: () => identity,
		});

		// Started (and buffered) while nobody was known.
		exporter.export([{ attributes: { name: "documentLoad" } }], () => {});
		identity = { "user.id": "u_1", "user.email": "zoe@acme.com" };
		open?.();
		await wait;
		await Promise.resolve();

		expect(sent[0]?.[0]?.attributes).toEqual({
			name: "documentLoad",
			"user.id": "u_1",
			"user.email": "zoe@acme.com",
		});
	});

	// A span that started after a workspace switch already carries the new org,
	// and the batch may still hold spans from before it. Filling only what is
	// missing keeps each span with the identity it was created under.
	test("a span that already has an attribute keeps its own value", async () => {
		const { exporter, sent } = fakeExporter();
		scrubOnExport(exporter, {
			scrubQueryStrings: false,
			identity: () => ({ "user.id": "u_1", "org.id": "org_new" }),
		});

		exporter.export([{ attributes: { "org.id": "org_old" } }], () => {});

		expect(sent[0]?.[0]?.attributes).toEqual({ "org.id": "org_old", "user.id": "u_1" });
	});

	test("nobody identified leaves the spans exactly as they were", async () => {
		const { exporter, sent } = fakeExporter();
		scrubOnExport(exporter, { scrubQueryStrings: false, identity: () => null });

		exporter.export([{ attributes: { a: 1 } }], () => {});

		expect(sent[0]?.[0]?.attributes).toEqual({ a: 1 });
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

// Seven asset spans per page load, the same seven every load, is most of what a
// browser emits and almost none of what anyone reads. The floor drops the cache
// hits and keeps anything a person actually waited on.
describe("the asset floor", () => {
	const asset = (ms: number, extra: Partial<Span> = {}): Span =>
		({
			name: "resourceFetch",
			attributes: {},
			duration: [Math.floor(ms / 1000), (ms % 1000) * 1e6],
			...extra,
		}) as Span;

	test("a fast asset is dropped and a slow one is kept", () => {
		const { exporter, sent } = fakeExporter();
		scrubOnExport(exporter, { scrubQueryStrings: false, assetFloorMs: 100 });

		exporter.export([asset(12), asset(430)], () => {});

		expect(sent[0]).toHaveLength(1);
		expect(sent[0]?.[0]?.duration?.[1]).toBe(430e6);
	});

	test("only assets are ever dropped", () => {
		const { exporter, sent } = fakeExporter();
		scrubOnExport(exporter, { scrubQueryStrings: false, assetFloorMs: 100 });

		const click = { name: "click", attributes: {}, duration: [0, 0] } as unknown as Span;
		exporter.export([click, asset(3)], () => {});

		expect(sent[0]).toEqual([click]);
	});

	// A failed asset is the whole reason to look at asset spans, and Resource
	// Timing leaves no status code to find it by afterwards.
	test("an asset that failed is kept however fast it failed", () => {
		const { exporter, sent } = fakeExporter();
		scrubOnExport(exporter, { scrubQueryStrings: false, assetFloorMs: 100 });

		exporter.export([asset(4, { status: { code: 2 } })], () => {});

		expect(sent[0]).toHaveLength(1);
	});

	test("a batch of nothing but cache hits is not sent at all, and still reports success", () => {
		const { exporter, sent } = fakeExporter();
		scrubOnExport(exporter, { scrubQueryStrings: false, assetFloorMs: 100 });

		let result: unknown;
		exporter.export([asset(2), asset(9)], (r) => {
			result = r;
		});

		expect(sent).toHaveLength(0);
		expect(result).toEqual({ code: 0 });
	});

	// An unreadable span is not a reason to lose one.
	test("an asset with no usable duration is kept", () => {
		const { exporter, sent } = fakeExporter();
		scrubOnExport(exporter, { scrubQueryStrings: false, assetFloorMs: 100 });

		exporter.export([{ name: "resourceFetch", attributes: {} } as unknown as Span], () => {});

		expect(sent[0]).toHaveLength(1);
	});

	test("a floor of zero leaves the exporter untouched", () => {
		const { exporter } = fakeExporter();
		const original = exporter.export;
		scrubOnExport(exporter, { scrubQueryStrings: false, assetFloorMs: 0 });
		expect(exporter.export).toBe(original);
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
