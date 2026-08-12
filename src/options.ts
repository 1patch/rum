/**
 * Option resolution for `@onepatch/rum`.
 *
 * Everything a caller can get wrong is caught HERE, at startup, with a message
 * that names the fix. The OnePatch agent writes these calls from the
 * `rum-instrument` skill, so a silently-wrong option would surface days later
 * as "there is no RUM data" rather than as something anyone can act on.
 */

import { originMatcher } from "./probe.js";

/** A write-only tenant ingest token. Deliberately safe to ship in a bundle. */
const TOKEN_SHAPE = /^op_[A-Za-z0-9_-]{16,}$/;

/** Hosts where plain http is a normal thing to be pointing at. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

export type RumOptions = {
	/** Your tenant's OnePatch ingest URL, e.g. `https://acme.logger.onepatch.dev`. */
	ingestUrl: string;
	/**
	 * Your tenant's `op_…` ingest token. Write-only, append-only, scoped to one
	 * tenant — it is designed to ship in a frontend bundle, like a Sentry DSN.
	 */
	ingestToken: string;
	/**
	 * A name for this frontend. Becomes `service.name`. Keep it stable: it is
	 * the first column of the telemetry sort key, so every query pivots on it.
	 */
	appName: string;
	/**
	 * `production`, `staging`, … Becomes `deployment.environment.name`.
	 *
	 * Read it from the same source your backend reads its own environment from.
	 * Two halves of one trace labelled differently means every env-filtered query
	 * returns half an answer.
	 */
	environment?: string;
	/**
	 * The build this is. Becomes `service.version`, and should be the commit sha —
	 * every framework exposes one at build time (`VERCEL_GIT_COMMIT_SHA`,
	 * `GITHUB_SHA`, `git rev-parse HEAD`).
	 *
	 * Required, because without it "did the error rate rise?" has no companion
	 * question "which deploy?", and that is the question anyone actually asks.
	 */
	appVersion: string;
	/**
	 * Cross-origin backends whose traces should join the browser's, as bare
	 * origins: `["https://api.acme.com"]`.
	 *
	 * Same-origin requests are always joined and do not belong here. Listing an
	 * origin is a request, not a guarantee — see `skipBackendCheck`.
	 */
	connectTracesTo?: string[];
	/**
	 * Skip the startup check that each `connectTracesTo` origin actually accepts
	 * the `traceparent` header. Only set this if you already know they do:
	 * sending the header to a backend whose CORS policy rejects it makes the
	 * browser block the request outright, which breaks your app, not just its
	 * telemetry.
	 */
	skipBackendCheck?: boolean;
	/**
	 * URLs to leave untraced entirely. Exact strings, or patterns.
	 *
	 * Your OnePatch ingest origin is always added to this list — telemetry that
	 * traces its own delivery is a feedback loop, not data.
	 */
	ignoreUrls?: (string | RegExp)[];
	/**
	 * Keep query strings on recorded URLs. Off by default, because query strings
	 * carry password-reset tokens, invite codes and email addresses, and telemetry
	 * storage is permanent. Turn it on only if you know your URLs are clean.
	 */
	keepQueryStrings?: boolean;
	/**
	 * Also forward `console.*` calls. Off by default: console lines carry
	 * personal data far more often than spans do.
	 */
	captureConsole?: boolean;
	/** Log what the SDK is doing. Useful while wiring this up; noisy after. */
	debug?: boolean;
};

export type ResolvedRumOptions = {
	tracesUrl: string;
	ingestToken: string;
	appName: string;
	environment: string | undefined;
	appVersion: string | undefined;
	/** Normalised, de-duplicated, same-origin entries removed. */
	crossOriginBackends: string[];
	checkBackends: boolean;
	/** The caller's list, plus a matcher for our own ingest origin. */
	ignoreUrls: (string | RegExp)[];
	scrubQueryStrings: boolean;
	captureConsole: boolean;
	debug: boolean;
	/** True when `tracesUrl` is plain http, which the underlying SDK gates. */
	insecureIngest: boolean;
	/**
	 * Things that will make the data harder to use later but are not worth
	 * refusing to start over. Reported once, at startup.
	 */
	warnings: string[];
};

export class RumConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RumConfigError";
	}
}

function required(value: unknown, option: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new RumConfigError(`${option} is required and must be a non-empty string.`);
	}
	return value.trim();
}

/**
 * Accept an ingest URL in any of the shapes a person or an agent might paste:
 * with or without a trailing slash, with or without the `/v1/traces` suffix the
 * OTLP spec appends. Return the exact traces endpoint.
 */
function resolveTracesUrl(raw: string): { tracesUrl: string; insecure: boolean } {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new RumConfigError(
			`ingestUrl is not a URL: ${JSON.stringify(raw)}. Expected something like "https://acme.logger.onepatch.dev".`,
		);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new RumConfigError(`ingestUrl must be http or https, got ${parsed.protocol}`);
	}
	const insecure = parsed.protocol === "http:";
	if (insecure && !LOCAL_HOSTS.has(parsed.hostname)) {
		throw new RumConfigError(
			`ingestUrl uses plain http on a remote host (${parsed.hostname}). Ingest must be https everywhere except localhost.`,
		);
	}
	const path = parsed.pathname.replace(/\/+$/, "");
	const base = path.endsWith("/v1/traces") ? path.slice(0, -"/v1/traces".length) : path;
	return { tracesUrl: `${parsed.origin}${base}/v1/traces`, insecure };
}

/**
 * Cross-origin propagation targets must be explicit origins. A wildcard here
 * would attach `traceparent` to every third-party request the page makes —
 * Stripe, analytics, a CDN — and any one of them refusing the header breaks
 * that request. There is no safe way to express "everywhere", so we refuse to
 * let anyone write it.
 */
function resolveBackends(raw: string[] | undefined, pageOrigin: string | undefined): string[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		throw new RumConfigError("connectTracesTo must be an array of origin strings.");
	}
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") {
			throw new RumConfigError(
				`connectTracesTo entries must be origin strings like "https://api.acme.com", got ${typeof entry}. Patterns are not accepted: list each backend.`,
			);
		}
		const trimmed = entry.trim();
		if (trimmed.includes("*")) {
			throw new RumConfigError(
				`connectTracesTo entry ${JSON.stringify(trimmed)} contains a wildcard. List each backend origin explicitly — a wildcard would attach trace headers to every third-party request the page makes, and any backend that rejects the header blocks its request.`,
			);
		}
		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			throw new RumConfigError(
				`connectTracesTo entry ${JSON.stringify(trimmed)} is not a URL. Use a full origin, e.g. "https://api.acme.com".`,
			);
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			throw new RumConfigError(
				`connectTracesTo entry ${JSON.stringify(trimmed)} must be http or https.`,
			);
		}
		// Same-origin already propagates unconditionally and needs no CORS at
		// all, so an entry for it is redundant rather than wrong. Drop it.
		if (parsed.origin === pageOrigin) continue;
		if (!out.includes(parsed.origin)) out.push(parsed.origin);
	}
	return out;
}

export function resolveOptions(
	options: RumOptions,
	pageOrigin?: string | undefined,
): ResolvedRumOptions {
	if (options === null || typeof options !== "object") {
		throw new RumConfigError("startRum() needs an options object.");
	}

	const { tracesUrl, insecure } = resolveTracesUrl(required(options.ingestUrl, "ingestUrl"));

	const ingestToken = required(options.ingestToken, "ingestToken");
	if (!TOKEN_SHAPE.test(ingestToken)) {
		throw new RumConfigError(
			"ingestToken does not look like a OnePatch ingest token (expected `op_` followed by at least 16 url-safe characters). Copy it from your OnePatch settings page — and note that no other credential belongs in a frontend bundle.",
		);
	}

	const appName = required(options.appName, "appName");
	if (appName.length > 64) {
		throw new RumConfigError("appName must be 64 characters or fewer.");
	}

	const environment = options.environment?.trim() || undefined;
	const appVersion = options.appVersion?.trim() || undefined;

	// Neither of these is worth refusing to start over — a page with unattributable
	// telemetry is still far better than a page with none, and this library's first
	// rule is that it never becomes the reason something stopped working.
	const warnings: string[] = [];
	if (appVersion === undefined) {
		warnings.push(
			"appVersion is not set, so no span can be attributed to a deploy. Pass the commit sha your build already exposes (VERCEL_GIT_COMMIT_SHA, GITHUB_SHA, `git rev-parse HEAD`).",
		);
	}
	if (environment === undefined) {
		warnings.push(
			"environment is not set, so these spans land with a blank env and drop out of every env-filtered query. Pass the same value your backend uses.",
		);
	}

	return {
		tracesUrl,
		ingestToken,
		appName,
		environment,
		appVersion,
		crossOriginBackends: resolveBackends(options.connectTracesTo, pageOrigin),
		checkBackends: options.skipBackendCheck !== true,
		// Prepended, not appended: the SDK walks this list in order, and the entry
		// that matters most is the one that keeps the exporter's own POSTs from
		// being traced — which would generate spans, whose delivery generates spans.
		ignoreUrls: [originMatcher(new URL(tracesUrl).origin), ...(options.ignoreUrls ?? [])],
		scrubQueryStrings: options.keepQueryStrings !== true,
		captureConsole: options.captureConsole === true,
		debug: options.debug === true,
		insecureIngest: insecure,
		warnings,
	};
}
