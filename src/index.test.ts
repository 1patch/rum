/**
 * The behavioural contract, as opposed to the option-shape contract in
 * options.test.ts. Two things are being pinned here:
 *
 *  1. Nothing throws. A telemetry SDK that can take down the page it measures is
 *     a worse outcome than having no telemetry, so every entry point is checked
 *     against the ways a caller can misuse it.
 *  2. Trace propagation is off until a backend has been shown to accept it, and
 *     switching it on works by mutating the very array handed to OpenTelemetry.
 *     That mechanism is load-bearing and invisible, so it gets a direct test.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type InitOptions = {
	url?: string;
	apiKey?: string;
	applicationName?: string;
	deploymentEnvironment?: string;
	allowInsecureUrl?: boolean;
	instrumentations?: Record<string, unknown>;
	resourceAttributes?: Record<string, string>;
	ignoreUrls?: (string | RegExp)[];
	exporter?: { factory?: unknown };
};

const calls: {
	init: InitOptions[];
	globalAttributes: Record<string, unknown>[];
	actions: [string, unknown][];
	exceptions: unknown[];
	deinit: number;
} = { init: [], globalAttributes: [], actions: [], exceptions: [], deinit: 0 };

mock.module("@hyperdx/otel-web", () => ({
	default: {
		init: (options: InitOptions) => {
			calls.init.push(options);
		},
		setGlobalAttributes: (attributes: Record<string, unknown>) => {
			calls.globalAttributes.push(attributes);
		},
		addAction: (name: string, attributes?: unknown) => {
			calls.actions.push([name, attributes]);
		},
		recordException: (error: unknown) => {
			calls.exceptions.push(error);
		},
		getSessionId: () => "session_abc",
		provider: { resource: { attributes: {} as Record<string, unknown> } },
		deinit: () => {
			calls.deinit += 1;
		},
	},
}));

const { identifyUser, recordAction, recordError, sessionId, startRum, stopRum } = await import(
	"./index.js"
);

const valid = {
	ingestUrl: "https://acme.logger.onepatch.dev",
	ingestToken: "op_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",
	appName: "acme-web",
	appVersion: "9f1c0aa",
	environment: "production",
};

/** The one bit of the DOM this library reads at startup. */
function fakeWindow(origin = "https://app.acme.com"): void {
	(globalThis as { window?: unknown }).window = { location: { origin } };
}

function propagateUrls(index = 0): RegExp[] {
	const fetchConfig = calls.init[index]?.instrumentations?.fetch as {
		propagateTraceHeaderCorsUrls: RegExp[];
	};
	return fetchConfig.propagateTraceHeaderCorsUrls;
}

/**
 * These tests replace globals — `window` because the library reads the page
 * origin, `fetch` because the backend check uses it. Both are restored
 * afterwards: a stubbed `fetch` left behind leaks into every test file that runs
 * later in the same process, which shows up as unrelated suites failing.
 */
const realFetch = globalThis.fetch;

beforeEach(() => {
	calls.init = [];
	calls.globalAttributes = [];
	calls.actions = [];
	calls.exceptions = [];
	calls.deinit = 0;
	fakeWindow();
});

afterEach(() => {
	stopRum();
	(globalThis as { window?: unknown }).window = undefined;
	globalThis.fetch = realFetch;
});

describe("startRum", () => {
	test("passes the resolved configuration through", async () => {
		const status = await startRum({ ...valid, environment: "production" });
		expect(status.started).toBe(true);
		expect(status.error).toBeUndefined();
		expect(calls.init[0]?.url).toBe("https://acme.logger.onepatch.dev/v1/traces");
		expect(calls.init[0]?.apiKey).toBe(valid.ingestToken);
		expect(calls.init[0]?.applicationName).toBe("acme-web");
		expect(calls.init[0]?.deploymentEnvironment).toBe("production");
		expect(calls.init[0]?.allowInsecureUrl).toBe(false);
	});

	// Session replay is not merely off by default, it is not wired at all; and
	// every other switch is stated outright so that upgrading the underlying SDK
	// cannot quietly start capturing something new.
	test("names every instrumentation explicitly", async () => {
		await startRum(valid);
		const instrumentations = calls.init[0]?.instrumentations ?? {};
		expect(instrumentations.interactions).toBe(true);
		expect(instrumentations.errors).toBe(true);
		expect(instrumentations.document).toBe(true);
		expect(instrumentations.console).toBe(false);
		expect(instrumentations.websocket).toBe(false);
		expect(instrumentations.socketio).toBe(false);
		expect(instrumentations.longtask).toBe(false);
	});

	// The SDK's own `deploymentEnvironment` and `version` only reach span
	// attributes, under pre-1.27 names. Verified end to end against a real
	// collector and store: without these resource attributes the environment
	// column comes back empty and every env-filtered query loses the browser half
	// of the trace.
	test("environment and version land on the resource, where everything reads them", async () => {
		await startRum({ ...valid, environment: "production", appVersion: "9f1c0aa" });
		expect(calls.init[0]?.resourceAttributes).toEqual({
			"deployment.environment.name": "production",
			"service.version": "9f1c0aa",
		});
	});

	test("nothing set means no invented resource attributes", async () => {
		await startRum({ ...valid, environment: "", appVersion: "" });
		expect(calls.init[0]?.resourceAttributes).toEqual({});
	});

	// Left un-ignored, the exporter's own POSTs are traced as fetch spans, whose
	// delivery is traced as fetch spans.
	test("our own ingest origin is never traced", async () => {
		await startRum(valid);
		const [ours] = calls.init[0]?.ignoreUrls ?? [];
		expect((ours as RegExp).test("https://acme.logger.onepatch.dev/v1/traces")).toBe(true);
	});

	// The SDK's own attribute-remapping hook is never called by its default
	// exporter factory, so scrubbing has to arrive as a factory. If this stops
	// being passed, query strings ship verbatim and nothing else complains.
	test("a scrubbing exporter factory is handed to the SDK", async () => {
		await startRum(valid);
		expect(typeof calls.init[0]?.exporter?.factory).toBe("function");
	});

	// The vendor stamps `rum.sessionId`. Grouping a person's activity should not
	// require naming a competitor, and the id rotates mid-session, so the alias has
	// to read through rather than snapshot.
	test("the session id is also published as session.id, and stays live", async () => {
		const otel = (await import("@hyperdx/otel-web")).default as unknown as {
			provider: { resource: { attributes: Record<string, unknown> } };
			getSessionId: () => string;
		};
		otel.provider.resource.attributes = {};
		const original = otel.getSessionId;
		let current = "session_one";
		otel.getSessionId = () => current;
		try {
			await startRum(valid);
			expect(otel.provider.resource.attributes["session.id"]).toBe("session_one");
			current = "session_two";
			expect(otel.provider.resource.attributes["session.id"]).toBe("session_two");
		} finally {
			otel.getSessionId = original;
		}
	});

	test("captureConsole is the only way console capture turns on", async () => {
		await startRum({ ...valid, captureConsole: true });
		expect(calls.init[0]?.instrumentations?.console).toBe(true);
	});

	test("a bad option reports itself instead of throwing", async () => {
		const status = await startRum({ ...valid, ingestToken: "nope" });
		expect(status.started).toBe(false);
		expect(status.error).toContain("ingestToken");
		expect(calls.init).toHaveLength(0);
	});

	test("outside a browser it does nothing at all", async () => {
		(globalThis as { window?: unknown }).window = undefined;
		const status = await startRum(valid);
		expect(status.started).toBe(false);
		expect(calls.init).toHaveLength(0);
	});

	test("a second call is ignored rather than doubling up", async () => {
		await startRum(valid);
		const second = await startRum(valid);
		expect(second.error).toContain("already");
		expect(calls.init).toHaveLength(1);
	});

	test("an SDK that throws does not take the page with it", async () => {
		const otel = (await import("@hyperdx/otel-web")).default;
		const original = otel.init;
		otel.init = () => {
			throw new Error("boom");
		};
		try {
			const status = await startRum(valid);
			expect(status.started).toBe(false);
			expect(status.error).toContain("boom");
		} finally {
			otel.init = original;
		}
	});
});

describe("connectTracesTo", () => {
	test("propagation starts empty, so nothing can be broken by default", async () => {
		await startRum(valid);
		expect(propagateUrls()).toEqual([]);
	});

	test("a backend that accepts traceparent gets connected", async () => {
		globalThis.fetch = (async () => ({ status: 404 })) as unknown as typeof fetch;
		const status = await startRum({ ...valid, connectTracesTo: ["https://api.acme.com"] });
		expect(status.backends).toHaveLength(1);
		expect(status.backends[0]?.allowed).toBe(true);
		// The mechanism: the same array instance OpenTelemetry holds is the one
		// that gained a matcher. Re-initialising was never needed.
		expect(propagateUrls()).toHaveLength(1);
		expect("https://api.acme.com/v2/run").toMatch(propagateUrls()[0] as RegExp);
	});

	// The important half. A backend whose CORS policy omits traceparent must be
	// left alone: sending it anyway makes the browser cancel the customer's real
	// request, which is a product outage caused by telemetry.
	test("a backend that refuses the header is left unconnected", async () => {
		globalThis.fetch = (async () => {
			throw new TypeError("Failed to fetch");
		}) as unknown as typeof fetch;
		const status = await startRum({ ...valid, connectTracesTo: ["https://api.acme.com"] });
		expect(status.started).toBe(true);
		expect(status.backends[0]?.allowed).toBe(false);
		expect(propagateUrls()).toEqual([]);
	});

	// The wildcard trap: `Access-Control-Allow-Headers: *` satisfies a request
	// that sends no credentials but is illegal for one that does, so a backend can
	// look fine and still break every cookie-bearing request once propagation is
	// on. It must be left unconnected.
	test("a backend that allows traceparent only without credentials is left unconnected", async () => {
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			const traceparent = (init?.headers as Record<string, string> | undefined)?.traceparent;
			if (init?.credentials === "include" && traceparent) throw new TypeError("Failed to fetch");
			return { status: 404 };
		}) as unknown as typeof fetch;
		const status = await startRum({ ...valid, connectTracesTo: ["https://api.acme.com"] });
		expect(status.backends[0]?.allowed).toBe(false);
		expect(status.backends[0]?.detail).toContain("cookies");
		expect(propagateUrls()).toEqual([]);
	});

	test("each backend is decided on its own", async () => {
		globalThis.fetch = (async (url: string) => {
			if (url.startsWith("https://strict.acme.com")) throw new TypeError("Failed to fetch");
			return { status: 404 };
		}) as unknown as typeof fetch;
		const status = await startRum({
			...valid,
			connectTracesTo: ["https://open.acme.com", "https://strict.acme.com"],
		});
		const byOrigin = Object.fromEntries(status.backends.map((b) => [b.origin, b.allowed]));
		expect(byOrigin).toEqual({ "https://open.acme.com": true, "https://strict.acme.com": false });
		expect(propagateUrls()).toHaveLength(1);
	});

	test("skipBackendCheck connects without asking, and probes nothing", async () => {
		let probes = 0;
		globalThis.fetch = (async () => {
			probes += 1;
			return { status: 404 };
		}) as unknown as typeof fetch;
		const status = await startRum({
			...valid,
			connectTracesTo: ["https://api.acme.com"],
			skipBackendCheck: true,
		});
		expect(probes).toBe(0);
		expect(propagateUrls()).toHaveLength(1);
		expect(status.backends[0]?.detail).toContain("not checked");
	});

	test("the page's own origin needs no check — same-origin already propagates", async () => {
		let probes = 0;
		globalThis.fetch = (async () => {
			probes += 1;
			return { status: 404 };
		}) as unknown as typeof fetch;
		const status = await startRum({ ...valid, connectTracesTo: ["https://app.acme.com/api"] });
		expect(probes).toBe(0);
		expect(status.backends).toEqual([]);
	});
});

describe("recording", () => {
	test("identifyUser maps to conventional attributes", async () => {
		await startRum(valid);
		identifyUser({ email: "zoe@acme.com", orgId: "org_7" });
		expect(calls.globalAttributes[0]).toEqual({
			"user.email": "zoe@acme.com",
			"org.id": "org_7",
		});
	});

	test("recordAction and recordError pass through", async () => {
		await startRum(valid);
		recordAction("ran-workflow", { workflowId: "wf_42" });
		recordError(new Error("handled"));
		expect(calls.actions[0]).toEqual(["ran-workflow", { workflowId: "wf_42" }]);
		expect(calls.exceptions).toHaveLength(1);
	});

	test("sessionId is the key that ties a person's actions together", async () => {
		await startRum(valid);
		expect(sessionId()).toBe("session_abc");
	});

	// Calling these before startRum is the likeliest ordering mistake in a real
	// app — a module-scope identifyUser, an init inside a framework hook. It has
	// to warn, not throw.
	test("nothing throws before startRum", async () => {
		expect(() => identifyUser({ email: "zoe@acme.com" })).not.toThrow();
		expect(() => recordAction("too-early")).not.toThrow();
		expect(() => recordError(new Error("too early"))).not.toThrow();
		expect(sessionId()).toBeUndefined();
		expect(() => stopRum()).not.toThrow();
		expect(calls.globalAttributes).toHaveLength(0);
		expect(calls.actions).toHaveLength(0);
	});

	test("stopRum detaches and allows a restart", async () => {
		await startRum(valid);
		stopRum();
		expect(calls.deinit).toBe(1);
		const restarted = await startRum(valid);
		expect(restarted.started).toBe(true);
		expect(calls.init).toHaveLength(2);
	});
});
