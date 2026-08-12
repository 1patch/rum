/**
 * Query strings are where secrets end up.
 *
 * A browser span records the URL it was on or the URL it fetched, verbatim.
 * Real applications put password-reset tokens, magic-link codes, invite codes,
 * email addresses and internal ids in query strings — so shipping URLs
 * unmodified means shipping those into long-term telemetry storage, where they
 * are searchable and, by our own retention promise, permanent.
 *
 * The path is kept because the path is the signal (which page, which route). The
 * query and the fragment are dropped, with the fact that something was dropped
 * recorded rather than silently erased, so nobody debugging a route mismatch is
 * left wondering whether a URL ever had parameters. Opt back in per-app with
 * `keepQueryStrings: true` when the team knows their URLs are clean.
 */

/** Attribute keys whose values are URLs, as emitted by the browser instrumentations. */
const URL_KEYS = new Set([
	"http.url",
	"http.request.url",
	"url.full",
	"location.href",
	"document.referrer",
	"http.referrer",
]);

/** A key we should treat as a URL even if it isn't in the list above. */
function looksLikeUrlKey(key: string): boolean {
	const lower = key.toLowerCase();
	return (
		URL_KEYS.has(lower) ||
		lower.endsWith(".url") ||
		lower.endsWith("_url") ||
		lower.endsWith(".href") ||
		lower.endsWith("_href")
	);
}

/**
 * Drop the query and fragment from one URL, leaving a marker when either was
 * present. Anything that doesn't parse as an http(s) URL is returned untouched —
 * this must never mangle a value it doesn't understand.
 */
export function stripQuery(value: string): string {
	if (value.length === 0) return value;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return value;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return value;
	const had = url.search.length > 0 || url.hash.length > 0;
	if (!had) return value;
	url.search = "";
	url.hash = "";
	// `?<scrubbed>` reads as "there were parameters here" to a human and keeps the
	// value obviously non-original to a query.
	return `${url.toString()}?<scrubbed>`;
}

/**
 * Rewrite the URL-shaped attributes of one span in place. Returns the number of
 * values changed, which the debug log reports so the behaviour is observable
 * rather than mysterious.
 */
export function scrubAttributes(attributes: Record<string, unknown>): number {
	let changed = 0;
	for (const key of Object.keys(attributes)) {
		const value = attributes[key];
		if (typeof value !== "string" || !looksLikeUrlKey(key)) continue;
		const stripped = stripQuery(value);
		if (stripped !== value) {
			attributes[key] = stripped;
			changed += 1;
		}
	}
	return changed;
}
