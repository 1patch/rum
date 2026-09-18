import { describe, expect, test } from "bun:test";
import { mirrorExports } from "./mirror.js";

function fake() {
	const batches: unknown[][] = [];
	const calls: string[] = [];
	const exporter = {
		export(spans: unknown[], callback: (result: { code: number }) => void) {
			batches.push(spans);
			callback({ code: 0 });
		},
		async forceFlush() {
			calls.push("flush");
		},
		async shutdown() {
			calls.push("shutdown");
		},
	};
	return { exporter, batches, calls };
}

describe("additional trace destinations", () => {
	test("sends the same batch once to every destination", () => {
		const primary = fake();
		const secondary = fake();
		const exporter = mirrorExports(primary.exporter, [secondary.exporter]);
		const batch = [{ attributes: { "session.id": "test-session", "url.full": "[redacted]" } }];
		const results: unknown[] = [];
		exporter.export(batch, (result) => results.push(result));
		expect(exporter).toBe(primary.exporter);
		expect(primary.batches).toEqual([batch]);
		expect(secondary.batches).toEqual([batch]);
		expect(results).toEqual([{ code: 0 }]);
	});

	test.each(["pending", "failed", "throws"])(
		"a %s secondary does not delay or resend the primary",
		(mode) => {
			const primary = fake();
			const secondary = fake();
			secondary.exporter.export = (_spans, callback) => {
				if (mode === "throws") throw new Error("secondary unavailable");
				if (mode === "failed") callback({ code: 1 });
			};
			const exporter = mirrorExports(primary.exporter, [secondary.exporter]);
			const results: unknown[] = [];
			exporter.export([], (result) => results.push(result));
			expect(primary.batches).toHaveLength(1);
			expect(results).toEqual([{ code: 0 }]);
		},
	);

	test("primary failure does not suppress secondary delivery", () => {
		const primary = fake();
		const secondary = fake();
		primary.exporter.export = (_spans, callback) => callback({ code: 1 });
		const results: unknown[] = [];
		mirrorExports(primary.exporter, [secondary.exporter]).export([], (r) => results.push(r));
		expect(secondary.batches).toHaveLength(1);
		expect(results).toEqual([{ code: 1 }]);
	});

	test("flush and shutdown visit all destinations even when one rejects", async () => {
		const primary = fake();
		const secondary = fake();
		primary.exporter.forceFlush = async () => {
			throw new Error("primary flush failed");
		};
		const exporter = mirrorExports(primary.exporter, [secondary.exporter]);
		await expect(exporter.forceFlush()).rejects.toThrow("primary flush failed");
		await exporter.shutdown();
		expect(secondary.calls).toEqual(["flush", "shutdown"]);
		expect(primary.calls).toEqual(["shutdown"]);
	});
});
