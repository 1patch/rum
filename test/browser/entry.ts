import HyperDX from "@hyperdx/otel-web";
import { trace } from "@opentelemetry/api";
import { identifyUser, recordAction, recordError, sessionId, startRum } from "../../src/index";

const w = window as typeof window & {
	fixture: { primary: string; secondary: string };
	ready: boolean;
	rumStatus: Awaited<ReturnType<typeof startRum>>;
	runJourney: () => Promise<void>;
	flush: () => Promise<void>;
	logout: () => void;
	session: () => string | undefined;
};

const starting = startRum({
	ingestUrl: w.fixture.primary,
	ingestToken: "op_synthetic_browser_test_00000000",
	appName: "compatibility-web",
	environment: "test",
	appVersion: "browser-fixture",
	user: async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
		return { id: "test-user", orgId: "test-org" };
	},
	additionalTraceDestinations: [
		{
			url: `${w.fixture.secondary}/v1/traces`,
			headers: { authorization: "synthetic-secondary-token" },
		},
	],
	redactUrl: (url) =>
		url.replace(/([?&#]token=)[^&#]*/g, "$1[redacted]").replace(/person%40example.com/g, "[email]"),
});
if (new URLSearchParams(location.search).has("logout-during-startup")) {
	identifyUser({ id: null, orgId: null });
}
w.rumStatus = await starting;
w.session = sessionId;
w.flush = () => {
	const provider = HyperDX.provider;
	if (!provider) throw new Error("RUM provider missing");
	return provider.forceFlush();
};
w.runJourney = async () => {
	history.pushState({}, "", "/journey?token=secret-navigation&filter=active");
	await trace
		.getTracer("existing-business-helper")
		.startActiveSpan("business-action", async (span) => {
			try {
				const response = await fetch(
					"/api/people/person%40example.com?token=secret-fetch&filter=active",
				);
				await response.text();
			} finally {
				span.end();
			}
		});
	await new Promise<void>((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("GET", "/api/xhr?token=secret-xhr&filter=active");
		request.onload = () => resolve();
		request.onerror = () => reject(new Error("XHR failed"));
		request.send();
	});
	recordAction("named-action");
	recordError(new Error("controlled-error"));
};
w.logout = () => {
	identifyUser({ id: null, email: null, name: null, orgId: null, orgName: null });
	recordAction("after-logout");
};
w.ready = true;
