/**
 * `@onepatch/rum` — browser telemetry for OnePatch.
 *
 * What you get: page views, clicks, fetch/XHR spans, JS errors and web vitals,
 * all stamped with a session id, and — for backends that accept it — the same
 * trace id the server span carries, so one trace covers the button and the query
 * behind it.
 *
 * What this is not: a session replay recorder. No DOM is captured. The artifact
 * is a queryable, ordered list of what someone did, which is what an
 * investigation actually reads.
 *
 * Design rule that outranks every other consideration here: **this library must
 * never break the page it is measuring.** Nothing below throws. A
 * misconfiguration is reported through the returned status and a console error,
 * because a telemetry SDK that white-screens a checkout page has done far more
 * damage than the data was worth.
 */

import Rum from "@hyperdx/otel-web";
import { exporterOption } from "./exporter.js";
import {
	type ResolvedRumOptions,
	RumConfigError,
	type RumOptions,
	resolveOptions,
} from "./options.js";
import { type BackendCheck, checkBackend, originMatcher } from "./probe.js";
import { type RumAttributes, type RumUser, userAttributes } from "./user.js";

export type { RumOptions } from "./options.js";
export { RumConfigError } from "./options.js";
export type { BackendCheck } from "./probe.js";
export type { RumAttributes, RumIdentity, RumUser, RumUserResolver } from "./user.js";

const PREFIX = "[onepatch/rum]";

/**
 * How long the first batch of spans will wait for identity before going out
 * anyway.
 *
 * Long enough for a session request on a slow connection, short enough that
 * telemetry from a page someone bounces off still arrives. The wait also ends
 * early — the moment identity settles, or the moment the page starts to go
 * away — so this ceiling is only reached when a resolver hangs.
 */
const IDENTITY_GRACE_MS = 3000;

type Gate = { wait: Promise<void>; open: () => void };

function newGate(): Gate {
	let open: () => void = () => {};
	const wait = new Promise<void>((resolve) => {
		open = () => resolve();
	});
	return { wait, open };
}

/**
 * Release the identity gate when the page starts to go away, so a slow resolver
 * can never turn a hold into lost telemetry. `pagehide` covers navigation and
 * the back/forward cache; `visibilitychange` covers a tab-switch on mobile,
 * which is where a page is most often killed without ever firing `pagehide`.
 *
 * Feature-detected rather than assumed: this file is also reached from
 * server-rendered code paths and from tests with a minimal `window`.
 */
function openGateOnPageExit(gate: Gate): void {
	try {
		window.addEventListener?.("pagehide", gate.open, { once: true });
		const doc = globalThis.document;
		doc?.addEventListener?.("visibilitychange", () => {
			if (doc.visibilityState === "hidden") gate.open();
		});
	} catch {
		// A gate that only opens on identity or the timer is still correct.
	}
}

export type RumStatus = {
	/** True when telemetry is flowing. */
	started: boolean;
	/**
	 * True when a person is attached to these spans. False when you passed
	 * `user: "anonymous"`, or your resolver returned `null` because nobody was
	 * signed in yet — assert on it in the test that covers your logged-in path.
	 */
	identified: boolean;
	/** Present only when something was wrong. Worth asserting on in a test. */
	error?: string;
	/** One entry per cross-origin backend in `connectTracesTo`. */
	backends: BackendCheck[];
};

type Started = {
	options: ResolvedRumOptions;
	/**
	 * Handed to OpenTelemetry by reference and mutated afterwards as backend
	 * checks come back. OpenTelemetry copies only the first level of an
	 * instrumentation config and re-reads it per request, so pushing here turns
	 * propagation on for an origin without re-initialising anything.
	 */
	propagateTo: RegExp[];
};

let started: Started | undefined;

function warn(message: string): void {
	console.warn(`${PREFIX} ${message}`);
}

/**
 * Start collecting. Safe to call from code that also runs on a server: outside a
 * browser it does nothing and says so.
 *
 * The returned promise resolves once every backend in `connectTracesTo` has been
 * checked, and never rejects. Awaiting it is optional — telemetry is already
 * flowing by the time it is returned — but a test should await it to see which
 * backends will be trace-joined.
 */
export async function startRum(options: RumOptions): Promise<RumStatus> {
	if (typeof window === "undefined") {
		return {
			started: false,
			identified: false,
			error: "not a browser environment; startRum() did nothing",
			backends: [],
		};
	}

	if (started !== undefined) {
		warn("startRum() was called twice. The second call was ignored.");
		return {
			started: true,
			identified: false,
			error: "startRum() was already called",
			backends: [],
		};
	}

	let resolved: ResolvedRumOptions;
	try {
		resolved = resolveOptions(options, window.location?.origin);
	} catch (error) {
		const message = error instanceof RumConfigError ? error.message : String(error);
		console.error(`${PREFIX} not started. ${message}`);
		return { started: false, identified: false, error: message, backends: [] };
	}

	for (const message of resolved.warnings) warn(message);

	const propagateTo: RegExp[] = [];

	// Built before `init`, because the exporter it gates is built inside it. The
	// document-load spans exist before any session request can have answered, so
	// without this hold the head of every session is anonymous no matter how
	// promptly identity arrives.
	const gate = newGate();
	const graceTimer = setTimeout(gate.open, IDENTITY_GRACE_MS);
	openGateOnPageExit(gate);

	try {
		Rum.init({
			url: resolved.tracesUrl,
			apiKey: resolved.ingestToken,
			applicationName: resolved.appName,
			allowInsecureUrl: resolved.insecureIngest,
			debug: resolved.debug,
			ignoreUrls: resolved.ignoreUrls,
			// Environment and version are passed ONLY as resource attributes, and the
			// SDK's own `deploymentEnvironment` / `version` options are deliberately
			// not used. Those options reach SPAN attributes under three names the
			// semantic conventions have moved on from — `environment`,
			// `deployment.environment` and `app.version` — so setting them alongside
			// the resource attributes stamped the same two facts three extra times per
			// span, in places no query looks. Environment and version describe the
			// thing emitting, not one span; the resource is where a backend filters on
			// them, and where the server half of the same trace carries them.
			resourceAttributes: resourceAttributes(resolved),
			// Opt-in only (`scrubQueryStrings`). See ./exporter.ts for why this has to
			// happen at the exporter rather than through the SDK's own remapping hook.
			exporter: exporterOption({
				scrubQueryStrings: resolved.scrubQueryStrings,
				onScrub: resolved.debug
					? (count) => console.info(`${PREFIX} scrubbed query strings from ${count} attributes`)
					: undefined,
				waitFor: gate.wait,
				identity: () => stamped,
			}),
			// Every switch is set explicitly, including the ones being turned
			// off, so that a version bump of the underlying SDK cannot quietly
			// start capturing something new.
			instrumentations: {
				document: true,
				errors: true,
				interactions: true,
				webvitals: true,
				visibility: true,
				fetch: { propagateTraceHeaderCorsUrls: propagateTo },
				xhr: { propagateTraceHeaderCorsUrls: propagateTo },
				console: resolved.captureConsole,
				connectivity: false,
				longtask: false,
				postload: false,
				socketio: false,
				websocket: false,
			},
		});
	} catch (error) {
		// Nothing is collecting, so nothing is held — but leave no timer behind.
		clearTimeout(graceTimer);
		gate.open();
		const message = error instanceof Error ? error.message : String(error);
		console.error(`${PREFIX} not started. ${message}`);
		return { started: false, identified: false, error: message, backends: [] };
	}

	publishSessionId();

	started = { options: resolved, propagateTo };

	// Identity and the backend checks are independent, and both are already
	// running behind live telemetry: every span held by the gate gets the stamp
	// when it goes out, whether it started before identity or after.
	const [backends, identified] = await Promise.all([
		connectBackends(resolved, propagateTo),
		applyIdentity(resolved.user).finally(() => {
			clearTimeout(graceTimer);
			gate.open();
		}),
	]);
	return { started: true, identified, backends };
}

/**
 * Everything identity has stamped so far, for spans that started before it.
 *
 * The underlying SDK applies global attributes in `onStart`, so a span already
 * open when identity lands never receives them — see `identity` in
 * ./exporter.ts, which reads this on the way out. Latest write wins here,
 * matching what a span starting now would get.
 */
let stamped: RumAttributes | null = null;

/** The one place identity is written, so the exporter's copy can't drift. */
function stamp(attributes: RumAttributes): void {
	stamped = { ...(stamped ?? {}), ...attributes };
	Rum.setGlobalAttributes(attributes);
}

/**
 * Stamp the identity the caller was required to supply.
 *
 * A resolver that throws is reported and otherwise survived — the caller's auth
 * code failing is not a reason for this library to stop collecting, and it is the
 * one shape here that runs someone else's code.
 */
async function applyIdentity(user: ResolvedRumOptions["user"]): Promise<boolean> {
	if (user === null) return false;
	if (typeof user !== "function") {
		stamp(userAttributes(user));
		return true;
	}
	let resolvedUser: RumUser | null;
	try {
		resolvedUser = await user();
	} catch (error) {
		warn(
			`the \`user\` resolver threw, so these spans have nobody attached: ${error instanceof Error ? error.message : String(error)}. Call identifyUser() once your session resolves.`,
		);
		return false;
	}
	if (resolvedUser === null || resolvedUser === undefined) return false;
	stamp(userAttributes(resolvedUser));
	return true;
}

/** The resource attributes the SDK won't set itself, and everything else reads. */
function resourceAttributes(resolved: ResolvedRumOptions): Record<string, string> {
	const attributes: Record<string, string> = {};
	if (resolved.environment !== undefined) {
		attributes["deployment.environment.name"] = resolved.environment;
	}
	if (resolved.appVersion !== undefined) attributes["service.version"] = resolved.appVersion;
	return attributes;
}

/**
 * Republish the session id as `session.id`, the OpenTelemetry name for it.
 *
 * The underlying SDK stamps it as `rum.sessionId`, which means every query that
 * groups a person's activity — the one thing a session id is for — has to name a
 * vendor-specific key. Worse, the id rotates (on inactivity and on a hard
 * lifetime cap), so copying the current value once would go stale mid-session.
 * The SDK's own attribute is a live getter for exactly that reason, so this
 * defines a second getter over the same source rather than a snapshot.
 *
 * Best-effort: a version bump that stops exposing `provider` costs the alias and
 * nothing else, so a failure here is logged in debug and otherwise ignored.
 */
function publishSessionId(): void {
	try {
		const attributes = (
			Rum as unknown as { provider?: { resource?: { attributes?: Record<string, unknown> } } }
		).provider?.resource?.attributes;
		if (attributes === undefined) return;
		Object.defineProperty(attributes, "session.id", {
			get: () => Rum.getSessionId(),
			configurable: true,
			enumerable: true,
		});
	} catch {
		// Nothing here is worth failing startup over.
	}
}

/**
 * Turn on trace propagation for the cross-origin backends that will accept it.
 *
 * Note the ordering: telemetry is already flowing before any of this runs, and
 * propagation switches on per origin as each check clears. Requests made in that
 * window simply go unjoined. Losing the first few correlations is the right
 * trade against the alternative, which is sending a header a backend might
 * reject and having the browser cancel a real request.
 */
async function connectBackends(
	options: ResolvedRumOptions,
	propagateTo: RegExp[],
): Promise<BackendCheck[]> {
	if (options.crossOriginBackends.length === 0) return [];

	if (!options.checkBackends) {
		for (const origin of options.crossOriginBackends) propagateTo.push(originMatcher(origin));
		return options.crossOriginBackends.map((origin) => ({
			origin,
			allowed: true,
			detail: "not checked (skipBackendCheck was set)",
		}));
	}

	return Promise.all(
		options.crossOriginBackends.map(async (origin) => {
			const check = await checkBackend(origin, fetch);
			if (check.allowed) {
				propagateTo.push(originMatcher(origin));
			} else {
				warn(`${origin} will not be trace-joined — ${check.detail}`);
			}
			if (options.debug && check.allowed) {
				console.info(`${PREFIX} ${origin} trace-joined — ${check.detail}`);
			}
			return check;
		}),
	);
}

/**
 * Update who the person is: a sign-in, an org switch, a profile edit. Applies to
 * every span from here on, including ones already buffered but not yet sent; the
 * last call wins per key.
 *
 * The FIRST identity does not belong here — it is the required `user` option on
 * `startRum`, so that no app can be wired without someone deciding what identity
 * means for it. This is the update path.
 */
export function identifyUser(user: RumUser): void {
	if (started === undefined) {
		warn("identifyUser() was called before startRum(). Nothing was recorded.");
		return;
	}
	stamp(userAttributes(user));
}

/**
 * Record something the person did that the DOM cannot tell you on its own —
 * "submitted-onboarding", "ran-workflow". Clicks and navigations are already
 * captured; use this for the step that has a name in your product's vocabulary.
 */
export function recordAction(name: string, attributes?: RumAttributes): void {
	if (started === undefined) {
		warn(
			`recordAction(${JSON.stringify(name)}) was called before startRum(). Nothing was recorded.`,
		);
		return;
	}
	Rum.addAction(name, attributes);
}

/** Record an error you handled, and would otherwise have swallowed. */
export function recordError(error: unknown, attributes?: RumAttributes): void {
	if (started === undefined) {
		warn("recordError() was called before startRum(). Nothing was recorded.");
		return;
	}
	Rum.recordException(error, attributes);
}

/**
 * The current session id, the key that ties one person's actions together.
 * Useful to attach to a support ticket or a bug report.
 */
export function sessionId(): string | undefined {
	if (started === undefined) return undefined;
	return Rum.getSessionId();
}

/** Stop collecting and detach. Mainly for tests and for hot reloading. */
export function stopRum(): void {
	if (started === undefined) return;
	started = undefined;
	stamped = null;
	Rum.deinit();
}
