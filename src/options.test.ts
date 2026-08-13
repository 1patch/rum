import { describe, expect, test } from "bun:test";
import { RumConfigError, resolveOptions } from "./options.js";

const valid = {
	ingestUrl: "https://acme.logger.onepatch.dev",
	ingestToken: "op_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",
	appName: "acme-web",
	appVersion: "9f1c0aa",
	user: { id: "u_1" },
};

describe("ingestUrl", () => {
	test("becomes the OTLP traces endpoint", () => {
		expect(resolveOptions(valid).tracesUrl).toBe("https://acme.logger.onepatch.dev/v1/traces");
	});

	// The agent copies this value out of a settings page or a chat message, so
	// every plausible shape of the same URL has to land in the same place.
	test.each([
		"https://acme.logger.onepatch.dev",
		"https://acme.logger.onepatch.dev/",
		"https://acme.logger.onepatch.dev///",
		"https://acme.logger.onepatch.dev/v1/traces",
		"https://acme.logger.onepatch.dev/v1/traces/",
		"  https://acme.logger.onepatch.dev  ",
	])("%s normalises to one endpoint", (ingestUrl) => {
		expect(resolveOptions({ ...valid, ingestUrl }).tracesUrl).toBe(
			"https://acme.logger.onepatch.dev/v1/traces",
		);
	});

	test("a path prefix survives normalisation", () => {
		expect(resolveOptions({ ...valid, ingestUrl: "https://acme.dev/otel" }).tracesUrl).toBe(
			"https://acme.dev/otel/v1/traces",
		);
	});

	test("http on localhost is allowed, for local development", () => {
		const resolved = resolveOptions({ ...valid, ingestUrl: "http://localhost:4318" });
		expect(resolved.tracesUrl).toBe("http://localhost:4318/v1/traces");
		expect(resolved.insecureIngest).toBe(true);
	});

	test("http to a remote host is refused", () => {
		expect(() =>
			resolveOptions({ ...valid, ingestUrl: "http://acme.logger.onepatch.dev" }),
		).toThrow(RumConfigError);
	});

	test.each([undefined, "", "   ", "not-a-url", "ftp://acme.dev"])("%p is refused", (ingestUrl) => {
		expect(() => resolveOptions({ ...valid, ingestUrl: ingestUrl as string })).toThrow(
			RumConfigError,
		);
	});
});

describe("ingestToken", () => {
	test("a well-formed op_ token is accepted", () => {
		expect(resolveOptions(valid).ingestToken).toBe(valid.ingestToken);
	});

	// The shape check earns its keep by refusing anything that ISN'T the
	// write-only ingest token — the one credential that belongs in a bundle.
	test.each([
		"",
		"op_short",
		"sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
		"Bearer op_abc",
		undefined,
	])("%p is refused", (ingestToken) => {
		expect(() => resolveOptions({ ...valid, ingestToken: ingestToken as string })).toThrow(
			RumConfigError,
		);
	});
});

describe("appName", () => {
	test("is required", () => {
		expect(() => resolveOptions({ ...valid, appName: "" })).toThrow(RumConfigError);
	});

	test("is capped, because it becomes service.name", () => {
		expect(() => resolveOptions({ ...valid, appName: "a".repeat(65) })).toThrow(RumConfigError);
	});
});

describe("connectTracesTo", () => {
	test("defaults to nothing, so nothing can break", () => {
		expect(resolveOptions(valid).crossOriginBackends).toEqual([]);
		expect(resolveOptions(valid).checkBackends).toBe(true);
	});

	test("URLs reduce to origins", () => {
		expect(
			resolveOptions({
				...valid,
				connectTracesTo: ["https://api.acme.com/v2/things?x=1"],
			}).crossOriginBackends,
		).toEqual(["https://api.acme.com"]);
	});

	test("duplicates collapse", () => {
		expect(
			resolveOptions({
				...valid,
				connectTracesTo: ["https://api.acme.com", "https://api.acme.com/other"],
			}).crossOriginBackends,
		).toEqual(["https://api.acme.com"]);
	});

	test("the page's own origin is dropped — it propagates anyway", () => {
		expect(
			resolveOptions(
				{ ...valid, connectTracesTo: ["https://app.acme.com", "https://api.acme.com"] },
				"https://app.acme.com",
			).crossOriginBackends,
		).toEqual(["https://api.acme.com"]);
	});

	// This is the assertion that matters most in the file. A wildcard here would
	// attach traceparent to every third-party request the page makes, and any one
	// of those backends refusing the header cancels a real request.
	test.each([["*"], ["https://*"], ["https://*.acme.com"], ["*.acme.com"]])(
		"%s is refused as a wildcard",
		(entry) => {
			expect(() => resolveOptions({ ...valid, connectTracesTo: [entry] })).toThrow(/wildcard/);
		},
	);

	test("a regular expression is refused — origins must be explicit", () => {
		expect(() =>
			resolveOptions({ ...valid, connectTracesTo: [/api\.acme\.com/ as unknown as string] }),
		).toThrow(RumConfigError);
	});

	test.each(["api.acme.com", "", "ws://api.acme.com"])("%p is refused", (entry) => {
		expect(() => resolveOptions({ ...valid, connectTracesTo: [entry] })).toThrow(RumConfigError);
	});

	test("skipBackendCheck opts out of the startup check", () => {
		expect(resolveOptions({ ...valid, skipBackendCheck: true }).checkBackends).toBe(false);
	});
});

describe("defaults", () => {
	test("nothing optional is on", () => {
		const resolved = resolveOptions(valid);
		expect(resolved.captureConsole).toBe(false);
		expect(resolved.debug).toBe(false);
		expect(resolved.environment).toBeUndefined();
	});

	test("blank optional strings are treated as absent", () => {
		const resolved = resolveOptions({ ...valid, environment: "  ", appVersion: "" });
		expect(resolved.environment).toBeUndefined();
		expect(resolved.appVersion).toBeUndefined();
	});
});

describe("query strings", () => {
	// Off by default: the query and the fragment are usually the only place a URL
	// says which workflow / which run, and losing that costs more than it saves.
	test("are kept unless the caller opts in", () => {
		expect(resolveOptions(valid).scrubQueryStrings).toBe(false);
		expect(resolveOptions({ ...valid, scrubQueryStrings: true }).scrubQueryStrings).toBe(true);
	});
});

describe("ignoreUrls", () => {
	// Otherwise the exporter's own POSTs are traced as fetch spans, and delivering
	// those spans produces more spans. Nobody notices until the bill does.
	test("always ignores our own ingest origin, first", () => {
		const [ours] = resolveOptions(valid).ignoreUrls;
		expect(ours).toBeInstanceOf(RegExp);
		expect((ours as RegExp).test("https://acme.logger.onepatch.dev/v1/traces")).toBe(true);
		expect((ours as RegExp).test("https://api.acme.com/v1/traces")).toBe(false);
	});

	// The probe goes to the CALLER's backend, so the ingest-origin matcher above
	// never covers it. Untouched, every page load ships spans for requests this
	// library invented — noise in someone else's telemetry.
	test("always ignores our own CORS probe, on any origin", () => {
		const probe = resolveOptions(valid).ignoreUrls[1];
		expect(probe).toBeInstanceOf(RegExp);
		const m = probe as RegExp;
		expect(m.test("https://api.acme.com/.well-known/onepatch-rum-probe")).toBe(true);
		expect(m.test("https://other.example/.well-known/onepatch-rum-probe?cb=1")).toBe(true);
		// Not a blanket well-known match, and not a prefix match on a real route.
		expect(m.test("https://api.acme.com/.well-known/openid-configuration")).toBe(false);
		expect(m.test("https://api.acme.com/.well-known/onepatch-rum-probe/sub")).toBe(false);
	});

	test("the caller's own entries are kept", () => {
		const resolved = resolveOptions({ ...valid, ignoreUrls: ["https://plausible.io/api/event"] });
		expect(resolved.ignoreUrls).toHaveLength(3);
		expect(resolved.ignoreUrls[2]).toBe("https://plausible.io/api/event");
	});
});

describe("warnings", () => {
	test("nothing to say when the build is fully described", () => {
		expect(resolveOptions({ ...valid, environment: "production" }).warnings).toEqual([]);
	});

	// Both of these are attribution, not correctness: telemetry with no version and
	// no environment still arrives, it just can't answer "which deploy?" or "which
	// env?". So they warn rather than refuse — this library never becomes the
	// reason a page has no telemetry at all.
	test("a missing appVersion is a warning, not a refusal", () => {
		const resolved = resolveOptions({ ...valid, appVersion: "", environment: "production" });
		expect(resolved.warnings).toHaveLength(1);
		expect(resolved.warnings[0]).toContain("appVersion");
	});

	test("a missing environment is a warning, not a refusal", () => {
		const resolved = resolveOptions(valid);
		expect(resolved.warnings).toHaveLength(1);
		expect(resolved.warnings[0]).toContain("environment");
	});
});

describe("user", () => {
	// Identity is refused rather than warned about, unlike everything in the block
	// above, because optional-plus-a-warning is exactly what shipped — and our own
	// app's spans then went a week with nobody attached to them. Every refusal here
	// names both ways out.
	test("a person is accepted as-is", () => {
		expect(resolveOptions(valid).user).toEqual({ id: "u_1" });
	});

	test("a resolver is passed through, to be called at startup", () => {
		const resolver = () => ({ id: "u_2" });
		expect(resolveOptions({ ...valid, user: resolver }).user).toBe(resolver);
	});

	test('"anonymous" is the deliberate way to have nobody', () => {
		expect(resolveOptions({ ...valid, user: "anonymous" }).user).toBeNull();
	});

	test("omitting it refuses to start", () => {
		const { user: _omitted, ...withoutUser } = valid;
		expect(() => resolveOptions(withoutUser as typeof valid)).toThrow(RumConfigError);
		expect(() => resolveOptions(withoutUser as typeof valid)).toThrow(/user is required/);
	});

	// Every `RumUser` field is optional on purpose, so callers can stamp whatever
	// they have — which makes `{}` type-check. It has to be caught here instead.
	test("an empty object is refused, not silently accepted", () => {
		expect(() => resolveOptions({ ...valid, user: {} })).toThrow(/stamps nothing/);
	});

	test("attributes with no id and no email are refused", () => {
		expect(() => resolveOptions({ ...valid, user: { plan: "enterprise" } })).toThrow(
			/needs an `id` or an `email`/,
		);
	});

	test("null, a string, an array, a number are all refused", () => {
		for (const bad of [null, "u_1", ["u_1"], 42]) {
			expect(() => resolveOptions({ ...valid, user: bad as never })).toThrow(RumConfigError);
		}
	});
});
