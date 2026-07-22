---
type: Lesson
title: Release bump PR failure is an org-level Actions restriction
description: When tag-driven release publishing succeeds but the version-bump PR step fails with `Resource not accessible by integration`, the cause is the OAS-Framework org-level Actions restriction and the bump must be rescued manually.
tags: [releases, github-actions, gotcha]
timestamp: 2026-07-22
---

During a release, the workflow's final create-and-merge version-bump PR step
can fail with `GraphQL: Resource not accessible by integration
(createPullRequest)`. That failure is not the repository-level "Allow GitHub
Actions to create and approve pull requests" toggle: in this repo that setting
is locked by the OAS-Framework organization policy. The repo API returned 409
"disabled by the organization", and changing the organization setting requires
an organization admin token with `admin:org` scope.

# The lesson

1. **Check publish state first.** The npm publishes complete before the bump-PR
   step. A bump-PR failure does not mean a broken release; verify with
   `npm view @oas-framework/oas version` before deciding whether to retag or
   rerun.
2. **Do not chase the repo toggle.** If the repo API says the Actions PR
   setting is disabled by the organization, only an organization admin can
   relax it.
3. **Rescue the bump PR manually while the org restriction remains:**
   ```bash
   gh pr create --base main --head release-bump/vX.Y.Z \
     --title "release: vX.Y.Z version bump" --body "..."
   gh pr merge release-bump/vX.Y.Z --squash --delete-branch
   git pull   # bring the bump into the local checkout
   ```
4. **Related Pi install cleanup gotcha:** after installing a new
   `@oas-framework/pi` version, `pi remove npm:@oas-framework/pi@OLD` removes
   both settings entries because removal matches by package name, not by the
   full install spec. Reinstall the new version after any remove.

# Related

- [npm EOTP failure in tag-driven release CI](/lessons/npm-eotp-in-tag-release.md)
- [Deployment probes catch what static checks miss](/lessons/release-verification.md)
