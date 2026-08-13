/**
 * Who is this? The single most valuable thing to stamp on browser telemetry,
 * because the question that starts an investigation is almost always "what did
 * THIS customer just do", not "what happened on the site".
 */

export type RumAttributeValue = string | number | boolean;

export type RumAttributes = Record<string, RumAttributeValue>;

/**
 * A `RumUser` field. `null` clears a key that was set earlier; leaving it out
 * means "don't touch it".
 *
 * That distinction is load-bearing on an update: `identifyUser({ id })` after a
 * workspace switch leaves the OLD `org.id` on every subsequent span, because an
 * absent key is not a removal. Pass `null` for what no longer applies. The first
 * caller to hit this wrote `orgId: ""` — correct behaviour, discovered by
 * reading our source, which is one reader further than anybody should have to go.
 */
export type RumAttributeUpdate = RumAttributeValue | null;

export type RumUser = {
	/** Your own stable identifier for the person. */
	id?: RumAttributeUpdate;
	email?: RumAttributeUpdate;
	/**
	 * Display name. Worth passing: an id is unreadable in a list of traces, and
	 * matching one back to a person is the first step of every lookup.
	 */
	name?: RumAttributeUpdate;
	/** The account, workspace, or tenant they are acting in. */
	orgId?: RumAttributeUpdate;
	/** Its name, for the same reason `name` is worth passing. */
	orgName?: RumAttributeUpdate;
	/** Anything else worth filtering sessions by, e.g. `plan: "enterprise"`. */
	[key: string]: RumAttributeUpdate | undefined;
};

/**
 * Called once at startup, and awaited: return who the person is as soon as your
 * app knows. `null` means "nobody is signed in right now" — a login page, a
 * cold load before the session request lands — which is honest, and which
 * `identifyUser` fixes the moment it changes.
 */
export type RumUserResolver = () => RumUser | null | Promise<RumUser | null>;

/**
 * Identity is a REQUIRED startup option, in one of three shapes: the person, a
 * resolver for the person, or the literal `"anonymous"`.
 *
 * It is required because the alternative — an optional field and a second
 * `identifyUser` call to remember — is exactly what we shipped on our own app,
 * and our own browser spans went a week with no one attached to them. Telemetry
 * that can't answer "what did this person just do" is missing the R and the U in
 * RUM. `"anonymous"` is a real answer for a site with no login; it just has to be
 * one somebody typed on purpose.
 */
export type RumIdentity = RumUser | RumUserResolver | "anonymous";

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
