import assert from "node:assert/strict";
import { chromium } from "playwright";

type Value = { stringValue?: string; intValue?: number };
type Attributes = { key: string; value: Value }[];
type Span = {
	name: string;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	attributes: Attributes;
};
type Payload = {
	resourceSpans?: { resource: { attributes: Attributes }; scopeSpans: { spans: Span[] }[] }[];
};
const attrs = (list: Attributes) =>
	Object.fromEntries(list.map(({ key, value }) => [key, value.stringValue ?? value.intValue]));
const flatten = (payloads: Payload[]) =>
	payloads
		.flatMap((p) => p.resourceSpans ?? [])
		.flatMap((r) =>
			r.scopeSpans.flatMap((s) =>
				s.spans.map((span) => ({
					...span,
					values: { ...attrs(r.resource.attributes), ...attrs(span.attributes) },
				})),
			),
		);
const received: { primary: Payload[]; secondary: Payload[] } = { primary: [], secondary: [] };
let failSecondary = false;
let apiRequests = 0;
const collector = (name: keyof typeof received) =>
	Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const headers = {
				"access-control-allow-origin": "*",
				"access-control-allow-headers": "*",
				"access-control-allow-methods": "POST, OPTIONS",
			};
			if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
			if (name === "secondary" && failSecondary)
				return new Response("unavailable", { status: 503, headers });
			assert.equal(
				request.headers.get("authorization"),
				name === "primary" ? "op_synthetic_browser_test_00000000" : "synthetic-secondary-token",
			);
			received[name].push(await request.json());
			return Response.json({}, { headers });
		},
	});
const primary = collector("primary");
const secondary = collector("secondary");
const bundle = await Bun.build({
	entrypoints: ["test/browser/entry.ts"],
	target: "browser",
	format: "esm",
});
assert.ok(bundle.success, String(bundle.logs));
const app = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/bundle.js")
			return new Response(bundle.outputs[0], { headers: { "content-type": "text/javascript" } });
		if (path.startsWith("/api/")) {
			apiRequests++;
			return Response.json({ ok: true });
		}
		return new Response(
			`<!doctype html><html><body><h1>RUM fixture</h1><script>window.fixture=${JSON.stringify({ primary: primary.url.origin, secondary: secondary.url.origin })}</script><script type="module" src="/bundle.js"></script></body></html>`,
			{ headers: { "content-type": "text/html" } },
		);
	},
});
const browser = await chromium.launch({
	executablePath: process.env.RUM_BROWSER_EXECUTABLE,
	headless: true,
});
try {
	const context = await browser.newContext();
	await context.route("**/*", (route) =>
		new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
	);
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(`${app.url.origin}/?token=secret-page`);
	await page.waitForFunction(() => (window as unknown as { ready: boolean }).ready);
	assert.deepEqual(
		await page.evaluate(() => (window as unknown as { rumStatus: unknown }).rumStatus),
		{ started: true, identified: true, backends: [] },
	);
	await page.evaluate("window.runJourney()");
	await page.waitForTimeout(1200);
	await page.evaluate("window.flush()");
	await page.waitForTimeout(300);
	assert.equal(apiRequests, 2);
	assert.deepEqual(errors, []);
	const left = flatten(received.primary);
	const right = flatten(received.secondary);
	assert.ok(left.length > 5);
	assert.deepEqual(
		left.map((s) => s.spanId).sort(),
		right.map((s) => s.spanId).sort(),
		"every span reaches both destinations exactly once",
	);
	assert.equal(new Set(left.map((s) => s.spanId)).size, left.length);
	for (const spans of [left, right]) {
		assert.equal(spans.filter((s) => s.name === "documentLoad").length, 1);
		assert.equal(
			spans.filter((s) => String(s.values["http.url"]).includes("/api/people/")).length,
			1,
		);
		assert.equal(spans.filter((s) => String(s.values["http.url"]).includes("/api/xhr")).length, 1);
		const session = await page.evaluate("window.session()");
		for (const name of [
			"documentLoad",
			"routeChange",
			"business-action",
			"named-action",
			"Error: controlled-error",
		]) {
			const span = spans.find((s) => s.name === name);
			assert.ok(span, name);
			assert.equal(span.values["session.id"], session);
			assert.equal(span.values["user.id"], "test-user");
			assert.equal(span.values["service.version"], "browser-fixture");
			assert.equal(span.values["deployment.environment.name"], "test");
		}
		const serialized = JSON.stringify(spans);
		assert.ok(
			!serialized.includes("secret-") && !serialized.includes("person%40example.com"),
			"redact before both exports",
		);
		assert.ok(serialized.includes("filter=active"), "preserve useful query context");
		assert.ok(
			!spans.some((s) => String(s.values["http.url"]).includes("/v1/traces")),
			"collector POSTs are excluded",
		);
	}
	await page.evaluate("window.logout(); window.flush()");
	await page.waitForTimeout(300);
	for (const name of ["primary", "secondary"] as const) {
		const logout = flatten(received[name]).find((s) => s.name === "after-logout");
		assert.ok(logout);
		assert.equal(logout.values["user.id"], "");
		assert.equal(logout.values["org.id"], "");
	}
	// A failed secondary cannot block successful OnePatch batches.
	failSecondary = true;
	await page.evaluate("window.runJourney()");
	await page.waitForTimeout(1200);
	await page.evaluate("window.flush()");
	await page.waitForTimeout(300);
	assert.equal(flatten(received.primary).filter((s) => s.name === "business-action").length, 2);
	assert.equal(flatten(received.secondary).filter((s) => s.name === "business-action").length, 1);
	assert.equal(apiRequests, 4);
	assert.deepEqual(errors, []);
	console.log(
		`Browser dual-destination regression passed (${await browser.version()}); session, identity, URL redaction, single request spans, both collectors, and secondary failure verified.`,
	);
	await context.close();
} finally {
	await browser.close();
	app.stop(true);
	primary.stop(true);
	secondary.stop(true);
}
