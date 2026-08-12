/**
 * What this suite is really protecting: a customer's password-reset token ending
 * up in a telemetry store that we promise never to expire.
 */

import { describe, expect, test } from "bun:test";
import { scrubAttributes, stripQuery } from "./scrub.js";

describe("stripQuery", () => {
	test("drops the query and says it did", () => {
		expect(stripQuery("https://app.acme.com/reset?token=s3cret")).toBe(
			"https://app.acme.com/reset?<scrubbed>",
		);
	});

	test("drops the fragment too, since routers put state there", () => {
		expect(stripQuery("https://app.acme.com/#/invite/abc123")).toBe(
			"https://app.acme.com/?<scrubbed>",
		);
	});

	test("a URL with nothing to drop is returned byte-identical", () => {
		expect(stripQuery("https://app.acme.com/orders/17")).toBe("https://app.acme.com/orders/17");
	});

	// The rule that keeps this from ever being the cause of a weird value: if we
	// don't understand it, we don't touch it.
	test.each(["", "not a url", "acme.com/x?y=1", "data:text/plain,hi", "mailto:a@b.com?subject=x"])(
		"%p is left alone",
		(value) => {
			expect(stripQuery(value)).toBe(value);
		},
	);
});

describe("scrubAttributes", () => {
	test("rewrites the keys the browser instrumentations actually emit", () => {
		const attributes: Record<string, unknown> = {
			"http.url": "https://api.acme.com/run?apiKey=abc",
			"location.href": "https://app.acme.com/p?email=a@b.com",
			"url.full": "https://api.acme.com/v2?x=1",
		};
		expect(scrubAttributes(attributes)).toBe(3);
		expect(attributes["http.url"]).toBe("https://api.acme.com/run?<scrubbed>");
		expect(attributes["location.href"]).toBe("https://app.acme.com/p?<scrubbed>");
		expect(attributes["url.full"]).toBe("https://api.acme.com/v2?<scrubbed>");
	});

	// An SDK version bump inventing `whatever.url` shouldn't reopen the hole.
	test("any key that names a url is covered", () => {
		const attributes: Record<string, unknown> = {
			"some.new.url": "https://a.dev/x?t=1",
			redirect_href: "https://a.dev/y?t=1",
		};
		expect(scrubAttributes(attributes)).toBe(2);
		expect(attributes["some.new.url"]).toBe("https://a.dev/x?<scrubbed>");
		expect(attributes.redirect_href).toBe("https://a.dev/y?<scrubbed>");
	});

	test("leaves everything that isn't a url alone", () => {
		const attributes: Record<string, unknown> = {
			target_xpath: "//*[@id='run']",
			"http.status_code": 500,
			"user.email": "a@b.com",
			"http.method": "GET",
		};
		expect(scrubAttributes(attributes)).toBe(0);
		expect(attributes.target_xpath).toBe("//*[@id='run']");
		expect(attributes["user.email"]).toBe("a@b.com");
	});

	test("non-string values on url-shaped keys are not mangled", () => {
		const attributes: Record<string, unknown> = { "http.url": 42 };
		expect(scrubAttributes(attributes)).toBe(0);
		expect(attributes["http.url"]).toBe(42);
	});
});
