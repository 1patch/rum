# Security

## Reporting

Email **security@onepatch.dev**. We reply within one business day. Please don't
open a public issue for anything exploitable.

## What this package can see

`@onepatch/rum` runs in your visitors' browsers, so it is worth being precise
about what it touches.

- It reads page navigations, clicks, unhandled errors, web vitals and the timing
  of `fetch`/XHR calls the page makes.
- It records the **full URL** of each page and request, query string and
  fragment included, because in a single-page app those are the only thing that
  says which screen the visitor was on. So if your URLs carry password-reset
  tokens, invite codes or email addresses, those values reach your telemetry.
  Set `scrubQueryStrings: true` to replace every query and fragment with
  `?<scrubbed>` before export — at the cost of collapsing distinct screens into
  one, since a hash-routed app keeps its route there too.
- It does not read form values, `localStorage`, cookies, or the DOM's text
  content, and it takes no screenshots or DOM recordings.
- It sends to exactly one endpoint — the `ingestUrl` you configure — and ignores
  its own requests so they can't feed back into your traces.

The ingest token you pass is a **write-only bearer** for one tenant's
append-only ingest, in the shape of a Sentry DSN. It is designed to ship in a
frontend bundle. It grants no read access to anything.

## Supply chain

- Two runtime dependencies, both OpenTelemetry-ecosystem.
- CI and publish workflows pin every GitHub Action **by commit sha**, install
  with `--frozen-lockfile --ignore-scripts`, and default to `contents: read`.
- Releases publish from a protected `npm` environment via npm trusted publishing
  — a short-lived OIDC token, no long-lived npm credential in this repo — and
  carry an npm [provenance
  attestation](https://docs.npmjs.com/generating-provenance-statements) you can
  verify against this repo and commit.
- `npm publish` ships only `dist/`, `README.md` and `LICENSE`.
