import { describe, expect, test } from "bun:test";
import { userAttributes } from "./user.js";

describe("userAttributes", () => {
	// The friendly names exist so nobody has to remember the conventional ones at
	// a call site. The conventional names are what every query is written
	// against, so this mapping is the contract.
	test("friendly names become OpenTelemetry attributes", () => {
		expect(
			userAttributes({
				id: "user_42",
				email: "zoe@acme.com",
				name: "Zoe",
				orgId: "org_7",
				orgName: "Acme",
			}),
		).toEqual({
			"user.id": "user_42",
			"user.email": "zoe@acme.com",
			"user.name": "Zoe",
			"org.id": "org_7",
			"org.name": "Acme",
		});
	});

	test("unknown keys pass through untouched", () => {
		expect(userAttributes({ plan: "enterprise", seats: 12, trialing: false })).toEqual({
			plan: "enterprise",
			seats: 12,
			trialing: false,
		});
	});

	test("absent fields are omitted, not sent empty", () => {
		expect(userAttributes({ email: "zoe@acme.com", name: undefined })).toEqual({
			"user.email": "zoe@acme.com",
		});
	});

	// No cast needed here any more, and that is the point: `null` was always the
	// way to clear a key, but the type didn't allow it, so the first person to need
	// it read our source and wrote `orgId: ""` instead.
	test("an explicit null clears the attribute", () => {
		expect(userAttributes({ email: null })).toEqual({ "user.email": "" });
	});

	// The case that makes clearing matter: an absent key leaves the OLD value on
	// every later span, so a member who leaves a workspace stays tagged with it.
	test("leaving a workspace clears the org, while omitting it would not", () => {
		expect(userAttributes({ id: "u_1", orgId: null, orgName: null })).toEqual({
			"user.id": "u_1",
			"org.id": "",
			"org.name": "",
		});
		expect(userAttributes({ id: "u_1" })).toEqual({ "user.id": "u_1" });
	});

	// "[object Object]" in a span attribute is worse than no attribute: it looks
	// like data and answers nothing.
	test("values that are not primitives are dropped", () => {
		expect(
			userAttributes({
				email: "zoe@acme.com",
				team: { id: 1 } as unknown as string,
				tags: ["a"] as unknown as string,
			}),
		).toEqual({ "user.email": "zoe@acme.com" });
	});

	test("a non-object argument is survivable", () => {
		expect(userAttributes(null as unknown as Record<string, string>)).toEqual({});
	});
});
