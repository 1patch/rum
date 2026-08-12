import { describe, expect, test } from "bun:test";
import { checkBackend, originMatcher, PROBE_PATH } from "./probe.js";

type Recorded = { url: string; init?: RequestInit };

/**
 * A fake browser. `refuse` decides which of the three probes the "browser"
 * rejects, standing in for a preflight the real one would refuse.
 */
function fakeFetch(refuse: (init: RequestInit | undefined) => boolean, log: Recorded[] = []) {
	const impl = async (url: string, init?: RequestInit) => {
		log.push({ url, init });
		if (refuse(init)) throw new TypeError("Failed to fetch");
		return { status: 404 };
	};
	return { impl, log };
}

const hasTraceparent = (init: RequestInit | undefined) =>
	(init?.headers as Record<string, string> | undefined)?.traceparent !== undefined;
const isCredentialed = (init: RequestInit | undefined) => init?.credentials === "include";

describe("checkBackend", () => {
	test("a backend that allows traceparent in every mode is connected", async () => {
		const { impl } = fakeFetch(() => false);
		const check = await checkBackend("https://api.acme.com", impl);
		expect(check.allowed).toBe(true);
		expect(check.origin).toBe("https://api.acme.com");
	});

	// A 404 is the expected outcome and must not be read as a failure: the probe
	// path is deliberately one that does not exist. What is being tested is
	// whether the browser let a traceparent-bearing request leave at all.
	test("a 404 still counts as allowed", async () => {
		const { impl } = fakeFetch(() => false);
		expect((await checkBackend("https://api.acme.com", impl)).detail).toContain("404");
	});

	test("a backend that refuses the header is not connected, and says why", async () => {
		const { impl } = fakeFetch(hasTraceparent);
		const check = await checkBackend("https://api.acme.com", impl);
		expect(check.allowed).toBe(false);
		expect(check.detail).toContain("traceparent");
	});

	test("it stops after one probe once the header is refused", async () => {
		const { impl, log } = fakeFetch(hasTraceparent);
		await checkBackend("https://api.acme.com", impl);
		expect(log).toHaveLength(1);
	});

	// The `Access-Control-Allow-Origin: *` case. Such a backend cannot receive
	// credentialed requests from a browser at all, so the app is provably not
	// sending any and propagation cannot break one.
	test("an origin that takes no credentialed requests is connected anyway", async () => {
		const { impl, log } = fakeFetch(isCredentialed);
		const check = await checkBackend("https://api.acme.com", impl);
		expect(check.allowed).toBe(true);
		expect(check.detail).toContain("no credentialed requests");
		expect(log).toHaveLength(2);
	});

	// The trap this whole function exists for: a wildcard
	// `Access-Control-Allow-Headers` satisfies a credential-less request but is
	// illegal for a credentialed one. A single naive probe would pass here and
	// then break every cookie-bearing request the app makes.
	test("an origin that takes credentials but rejects traceparent on them is refused", async () => {
		const { impl, log } = fakeFetch((init) => isCredentialed(init) && hasTraceparent(init));
		const check = await checkBackend("https://api.acme.com", impl);
		expect(check.allowed).toBe(false);
		expect(check.detail).toContain("cookies");
		expect(check.detail).toContain("Access-Control-Allow-Headers");
		expect(log).toHaveLength(3);
	});

	test("the probes are cross-origin GETs on the probe path", async () => {
		const { impl, log } = fakeFetch(() => false);
		await checkBackend("https://api.acme.com", impl);
		for (const { url, init } of log) {
			expect(url).toBe(`https://api.acme.com${PROBE_PATH}`);
			expect(init?.method).toBe("GET");
			expect(init?.mode).toBe("cors");
		}
		const headers = log[0]?.init?.headers as Record<string, string> | undefined;
		const traceparent = headers?.traceparent;
		expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
	});

	test("a hung backend gives up rather than hanging the caller", async () => {
		const check = await checkBackend(
			"https://api.acme.com",
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
			10,
		);
		expect(check.allowed).toBe(false);
	});
});

describe("originMatcher", () => {
	// OpenTelemetry compares string matchers by strict equality against the whole
	// request URL, so an origin has to become a pattern or it matches nothing.
	test("matches the origin and everything under it", () => {
		const matcher = originMatcher("https://api.acme.com");
		expect("https://api.acme.com").toMatch(matcher);
		expect("https://api.acme.com/").toMatch(matcher);
		expect("https://api.acme.com/v2/things").toMatch(matcher);
		expect("https://api.acme.com?x=1").toMatch(matcher);
	});

	test("does not match a neighbouring host that merely starts the same", () => {
		const matcher = originMatcher("https://api.acme.com");
		expect(matcher.test("https://api.acme.com.evil.test/")).toBe(false);
		expect(matcher.test("https://api.acme.community/")).toBe(false);
		expect(matcher.test("http://api.acme.com/")).toBe(false);
		expect(matcher.test("https://other.acme.com/")).toBe(false);
	});

	test("a dot in the host is not a wildcard", () => {
		expect(originMatcher("https://a.acme.com").test("https://axacme.com/")).toBe(false);
	});

	test("a port is part of the origin", () => {
		const matcher = originMatcher("http://localhost:3000");
		expect("http://localhost:3000/api").toMatch(matcher);
		expect(matcher.test("http://localhost:30001/api")).toBe(false);
	});
});
