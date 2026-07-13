---
type: Lesson
title: npm EOTP failure in tag-driven release CI
description: CI npm publish fails with EOTP when NPM_TOKEN is subject to 2FA-on-publish; use a granular package read/write token, and treat repo renames as irrelevant to npm publish authority.
tags: [npm, releases, ci, gotcha]
timestamp: 2026-07-13
---

During the v0.8.0 release, the tag-driven Release workflow failed at
`npm publish` with `EOTP` ("requires a one-time password"). The run was the
first release from the renamed `OAS-Framework/oas` repo, but the repo name was
not the cause: npm publish authority comes from the npm token's account and
package/org scope, not from the GitHub repository running the workflow.

# The lesson

1. **EOTP means the token is OTP-constrained.** If CI hits `EOTP` at
   `npm publish`, the `NPM_TOKEN` secret is a token type subject to the npm
   account's 2FA-on-writes policy.
2. **Use a granular package token.** Create a granular npm access token with
   read/write access for the `@oas-framework` packages/org, then update the
   GitHub Actions secret (`gh secret set NPM_TOKEN`).
3. **Rerun; do not retag for EOTP alone.** `EOTP` happens before publish, so
   no package version was consumed. Rerun the failed workflow jobs with
   `gh run rerun <id> --failed`; the existing tag is still safe to use.
4. **Repo migration is orthogonal.** Moving or renaming the GitHub repo does
   not by itself affect npm publishing; only the token's npm-side authority
   matters.

# Related

- [Deployment probes catch what static checks miss](/lessons/release-verification.md)
