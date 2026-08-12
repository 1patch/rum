/**
 * Is this backend willing to receive a `traceparent` header?
 *
 * Why this exists at all: joining a browser span to a backend span means
 * attaching `traceparent` to the outgoing request. On a cross-origin request
 * that turns it into a preflighted request, and if the backend's
 * `Access-Control-Allow-Headers` does not cover `traceparent`, the browser
 * refuses to send the request AT ALL. The customer loses the API call, not just
 * the correlation. That failure mode is why Sentry defaults to same-origin only
 * and why Datadog ships its equivalent option with no default.
 *
 * So we ask first. We cannot read `Access-Control-Allow-Headers` from
 * JavaScript — it is not an exposed response header — but we do not need to.
 * We only need the browser's verdict on the preflight, and the browser gives us
 * that for free: a rejected preflight rejects the `fetch`, while an accepted one
 * resolves with whatever status the server returned, 404 very much included.
 */

/** The W3C spec's own example id, with the sampled flag off so nothing records it. */
const INERT_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00";

/**
 * A path chosen to be uninteresting. We expect a 404 and that is a pass — the
 * only thing being tested is whether the preflight cleared.
 */
export const PROBE_PATH = "/.well-known/onepatch-rum-probe";

export type BackendCheck = {
	origin: string;
	/** True when the browser let a `traceparent`-bearing request through. */
	allowed: boolean;
	detail: string;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<{ status: number }>;

type Attempt = { ok: boolean; status?: number; error?: string };

async function attempt(
	url: string,
	fetchImpl: FetchLike,
	init: RequestInit,
	timeoutMs: number,
): Promise<Attempt> {
	const controller = typeof AbortController === "function" ? new AbortController() : undefined;
	const timer = setTimeout(() => controller?.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, {
			method: "GET",
			mode: "cors",
			cache: "no-store",
			redirect: "manual",
			signal: controller?.signal,
			...init,
		});
		return { ok: true, status: response.status };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Decide, from up to three deliberately boring cross-origin GETs, whether this
 * origin can safely be sent `traceparent`.
 *
 * The first probe is the obvious one. The other two exist because of a sharp
 * asymmetry in CORS: a response of `Access-Control-Allow-Headers: *` satisfies a
 * request that sends no credentials, but is *illegal* for one that does. So a
 * single credential-less probe can pass against a backend where propagating
 * would still break the app's real, cookie-bearing requests.
 *
 * Rather than guess, we ask whether credentialed requests reach this origin at
 * all:
 *
 *  1. `traceparent`, no credentials — fails: the header is not allowed. Stop.
 *  2. credentials, no custom header — fails: this origin cannot receive
 *     credentialed requests from this page in the first place (an origin
 *     answering `Access-Control-Allow-Origin: *` cannot, by rule), so the app is
 *     not making any, and there is nothing for propagation to break. Connect.
 *  3. credentials *and* `traceparent` — fails where step 2 passed: credentialed
 *     requests do reach this origin, but not carrying `traceparent`. This is the
 *     wildcard trap, and the only safe answer is to leave the origin alone.
 *
 * Nothing here can distinguish "the preflight was refused" from "the host is
 * unreachable", and both lead to the same decision, so we do not pretend to.
 */
export async function checkBackend(
	origin: string,
	fetchImpl: FetchLike,
	timeoutMs = 4000,
): Promise<BackendCheck> {
	const url = `${origin}${PROBE_PATH}`;
	const traceparentHeader = { traceparent: INERT_TRACEPARENT };

	const plain = await attempt(
		url,
		fetchImpl,
		{ credentials: "omit", headers: traceparentHeader },
		timeoutMs,
	);
	if (!plain.ok) {
		return {
			origin,
			allowed: false,
			detail: `no traceparent: ${plain.error}. Either this origin's Access-Control-Allow-Headers omits "traceparent", or it was unreachable.`,
		};
	}

	const credentialed = await attempt(url, fetchImpl, { credentials: "include" }, timeoutMs);
	if (!credentialed.ok) {
		return {
			origin,
			allowed: true,
			detail: `preflight accepted (probe returned ${plain.status}); this origin takes no credentialed requests, so none can be affected`,
		};
	}

	const both = await attempt(
		url,
		fetchImpl,
		{ credentials: "include", headers: traceparentHeader },
		timeoutMs,
	);
	if (!both.ok) {
		return {
			origin,
			allowed: false,
			detail:
				'this origin accepts credentialed requests but rejects "traceparent" on them, which is what a wildcard Access-Control-Allow-Headers does. Propagating here would break requests that send cookies. Name "traceparent" explicitly in that backend\'s Access-Control-Allow-Headers.',
		};
	}

	return {
		origin,
		allowed: true,
		detail: `preflight accepted with and without credentials (probe returned ${plain.status})`,
	};
}

/**
 * Match a whole origin and everything under it. Origins go through `RegExp`
 * rather than a plain string because OpenTelemetry compares string matchers by
 * strict equality against the full request URL, which would only ever match a
 * bare origin with no path.
 */
export function originMatcher(origin: string): RegExp {
	return new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[/?#]|$)`);
}
