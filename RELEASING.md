# Releasing

Normal release, once trusted publishing is set up:

```sh
# bump "version" in package.json, commit, then:
git tag v0.1.1 && git push origin v0.1.1
gh release create v0.1.1 --generate-notes
```

The release event runs `.github/workflows/publish.yml`, which re-runs the whole
gate, checks the tag against `package.json`, waits for a reviewer to approve the
`npm` environment, and publishes with provenance. The tag must match
`package.json` or the job fails before publishing.

## One-time setup (a human has to do these)

1. **Claim the `@onepatch` npm scope** with 2FA enabled on the account. Both
   `@onepatch` and `@1patch` were unclaimed as of 2026-08-11.
2. **Publish `0.1.0` by hand**, from a laptop, with 2FA:
   ```sh
   bun install && bun run check
   npm pack && tar tzf onepatch-rum-0.1.0.tgz   # look at what ships
   npm publish
   ```
   npm's trusted publishing is configured per package, so the package has to
   exist before step 3.
3. **Configure trusted publishing** on npmjs.com → the package → Settings →
   Trusted Publishers: repository `1patch/rum`, workflow `publish.yml`,
   environment `npm`. Then set "Require two-factor authentication or granular
   access tokens" so a leaked classic token can't publish.
4. **Create the `npm` GitHub environment** (Settings → Environments) with
   yourself as a required reviewer, and restrict it to protected branches and
   tags. This is the approval gate; without it the workflow's `environment: npm`
   is a no-op label.

No `NPM_TOKEN` secret should exist in this repo. If OIDC is ever unavailable,
publish from a laptop as in step 2 rather than adding one — a long-lived token
in Actions is the single thing most likely to end up publishing something we
didn't write.
