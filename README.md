# @onepatch/rum

Browser telemetry for [OnePatch](https://onepatch.dev). Page views, clicks, fetch and XHR spans, JS errors and web vitals — each one stamped with a session id and, where the backend accepts it, the same trace id the server span carries.

```sh
bun add @onepatch/rum   # or npm / pnpm / yarn
```

```ts
import { identifyUser, startRum } from "@onepatch/rum";

startRum({
  ingestUrl: "https://acme.logger.onepatch.dev",
  ingestToken: "op_…",
  appName: "acme-web",
  environment: "production",
  appVersion: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
  connectTracesTo: ["https://api.acme.com"],
});

// As soon as you know who is here:
identifyUser({ email: user.email, id: user.id, orgId: user.orgId });
```

The ingest token is write-only, append-only and scoped to your tenant. It is designed to ship in a frontend bundle, the same way a Sentry DSN does.

## What you get

One ordered, queryable record of what a person did — which page, which button, which request, which error, in sequence, under one session id. Ask "what did this customer just do" and the answer is a list you can read.

There is no session replay. No DOM is captured, no keystrokes, no form contents. That is a deliberate choice, not a missing feature: an investigation reads the action list, and skipping the recorder keeps the payload small, the privacy story ordinary, and retention uncomplicated.

## Options

| Option | |
| --- | --- |
| `ingestUrl` | Your tenant's OnePatch ingest URL. With or without a trailing `/v1/traces` — both work. |
| `ingestToken` | Your `op_…` token. |
| `appName` | Becomes `service.name`. Name it `<service>-web` after the backend it talks to, and keep it stable; every query pivots on it. |
| `environment` | `production`, `staging`, … Becomes `deployment.environment.name`. Read it from the same source your backend does. |
| `appVersion` | Required. Becomes `service.version`; pass the commit sha your build already exposes. |
| `connectTracesTo` | Cross-origin backends to join traces with, as explicit origins. See below. |
| `skipBackendCheck` | Skip the startup check on those origins. Read the next section first. |
| `ignoreUrls` | Extra URLs to leave untraced. Your ingest origin is always on this list. |
| `keepQueryStrings` | Keep query strings on recorded URLs. Off by default — see below. |
| `captureConsole` | Also forward `console.*`. Off by default — console lines carry personal data more often than spans do. |
| `debug` | Log what the SDK is doing. |

Functions: `startRum`, `identifyUser`, `recordAction`, `recordError`, `sessionId`, `stopRum`.

`identifyUser` takes `id`, `email`, `name`, `orgId`, `orgName` and anything else you want to filter sessions by. The first five become the conventional `user.*` / `org.*` attributes; the rest pass through as you wrote them.

`recordAction("ran-workflow", { workflowId })` names a step in your product's own vocabulary. Clicks and navigations are already captured; use this for the thing you would actually search for.

## connectTracesTo, and why it is opt-in per origin

Joining a browser span to a backend span means attaching a `traceparent` header to the request. Same-origin requests get this automatically, with nothing to configure and nothing at risk.

Cross-origin is different. Adding that header turns the request into a preflighted one, and if the backend's `Access-Control-Allow-Headers` does not cover `traceparent`, **the browser refuses to send the request at all**. You lose the API call, not just the correlation. This is why Sentry defaults to same-origin only, and why Datadog's equivalent option ships with no default.

So this library asks first. At startup it sends one deliberately boring request per listed origin, carrying a `traceparent`, and only enables propagation for the origins that accept it. An origin that refuses is left alone and logs a warning naming the fix. The worst case is a missing correlation; it is never a broken request.

That probe is the one bit of traffic you might not expect, so: it is a single `GET` to `/.well-known/onepatch-rum-probe` per origin per page load, with the trace flag off. A 404 is a pass — the only question being asked is whether the preflight cleared.

`await startRum(...)` returns which origins were connected, which is worth asserting on in a test:

```ts
const status = await startRum({ …, connectTracesTo: ["https://api.acme.com"] });
// status.backends → [{ origin: "https://api.acme.com", allowed: true, detail: "…" }]
```

Wildcards are refused. `connectTracesTo: ["https://*"]` would attach trace headers to every third-party request the page makes — your payment provider, your CDN, your analytics — and any one of them rejecting the header breaks that request. List the backends you own.

If you already know your CORS policy allows `traceparent`, `skipBackendCheck: true` connects without asking.

## Query strings are dropped

Every recorded URL — `location.href`, the URL of each fetch — has its query string and fragment removed before the span leaves the browser, leaving `https://app.acme.com/reset?<scrubbed>`. The path is the signal; the query string is where password-reset tokens, invite codes and email addresses live, and telemetry storage is permanent.

`keepQueryStrings: true` turns it off if you know your URLs are clean. There is no partial mode: an allowlist of "safe" parameters is a list somebody forgets to update.

## It will not break your page

Nothing exported here throws. A bad option is reported through the returned status and a `console.error`; calling `identifyUser` before `startRum` warns and does nothing; outside a browser `startRum` is a no-op, so importing this from server-rendered code is safe.

A telemetry SDK that white-screens a checkout page has done more damage than the data was worth.

## Size

130 KB gzipped, no session recorder.

## Built on OpenTelemetry

The collector accepts OTLP, so nothing here locks you in. Under the hood this wraps [`@hyperdx/otel-web`](https://github.com/hyperdxio/hyperdx-js) (Apache-2.0), which wraps the OpenTelemetry browser SDKs. This package exists to pin the defaults that matter, name the options in plain language, and make the propagation footgun unreachable.

Apache-2.0.

## Development

```sh
bun install
bun run check   # biome + typecheck + tests + build
```

Source lives at [github.com/1patch/rum](https://github.com/1patch/rum). Security reports: see [SECURITY.md](./SECURITY.md).
