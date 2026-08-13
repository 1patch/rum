# Releasing

```sh
# bump "version" in package.json, commit, then:
git tag v0.1.1 && git push origin v0.1.1
gh release create v0.1.1 --generate-notes
```

The release event runs `.github/workflows/publish.yml`, which re-runs the whole
gate, checks the tag against `package.json`, waits for a reviewer to approve the
`npm` environment, and publishes with provenance. The tag must match
`package.json` or the job fails before publishing.

Two things worth knowing when a release looks stuck. The `npm` environment's
required-reviewer rule is the approval gate, so a queued job is usually waiting
on a human, not broken. And npmjs.com serves the README from the published
tarball — a docs-only change on `main` is invisible on the package page until a
version ships.

No `NPM_TOKEN` secret should exist in this repo. If OIDC is ever unavailable,
publish from a laptop with 2FA rather than adding one — a long-lived token in
Actions is the single thing most likely to end up publishing something we
didn't write.
