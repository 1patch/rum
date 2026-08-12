/**
 * Who is this? The single most valuable thing to stamp on browser telemetry,
 * because the question that starts an investigation is almost always "what did
 * THIS customer just do", not "what happened on the site".
 */

export type RumAttributeValue = string | number | boolean;

export type RumAttributes = Record<string, RumAttributeValue>;

export type RumUser = {
	/** Your own stable identifier for the person. */
	id?: string;
	email?: string;
	/** Display name. */
	name?: string;
	/** The account, workspace, or tenant they are acting in. */
	orgId?: string;
	orgName?: string;
	/** Anything else worth filtering sessions by, e.g. `plan: "enterprise"`. */
	[key: string]: RumAttributeValue | undefined;
};

/**
 * Friendly key in, OpenTelemetry-conventional attribute out. The conventional
 * names are what queries and dashboards are written against, so they are not
 * negotiable per-customer; the friendly names exist so nobody has to remember
 * them at the call site.
 */
const ATTRIBUTE_NAMES: Record<string, string> = {
	id: "user.id",
	email: "user.email",
	name: "user.name",
	orgId: "org.id",
	orgName: "org.name",
};

/** Clearing a field is meaningful, so an explicit `null` maps to an empty string. */
export function userAttributes(user: RumUser): RumAttributes {
	if (user === null || typeof user !== "object") return {};
	const out: RumAttributes = {};
	for (const [key, value] of Object.entries(user)) {
		if (value === undefined) continue;
		const name = ATTRIBUTE_NAMES[key] ?? key;
		if (value === null) {
			out[name] = "";
		} else if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			out[name] = value;
		}
		// Anything else — an object, an array, a function — is dropped rather
		// than stringified. A span attribute reading "[object Object]" is worse
		// than an absent one.
	}
	return out;
}
