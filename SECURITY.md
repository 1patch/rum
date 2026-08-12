# Security

## Reporting

Email **security@onepatch.dev**. We reply within one business day. Please don't
open a public issue for anything exploitable.

## What this package can see

`@onepatch/rum` runs in your visitors' browsers, so it is worth being precise
about what it touches.

- It reads page navigations, clicks, unhandled errors, web vitals and the timing
  of `fetch`/XHR calls the page makes.
- It **strips query strings and fragments** from every URL attribute before
  export, replacing them with `?<scrubbed>`. Password-reset tokens, invite
  codes and email addresses in links do not leave the browser. `keepQueryStrings:
  true` opts out; don't.
- It does not read form values, `localStorage`, cookies, or the DOM's text
  content, and it takes no screenshots or DOM recordings.
- It sends to exactly one endpoint — the `tracesUrl` you configure — and ignores
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
