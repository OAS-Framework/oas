---
type: Lesson
title: The release bump PR is blocked by an org-level Actions restriction — check main, not the run
description: The org-level Actions restriction blocks the tag-driven release's version-bump PR, sometimes as a failed step and sometimes silently under a fully green run, so the rescue trigger is "bump not on main" rather than "run failed".
tags: [releases, github-actions, org-policy, gotcha]
timestamp: 2026-08-25
---

During a release, the workflow's final create-and-merge version-bump PR step
can fail with `GraphQL: Resource not accessible by integration
(createPullRequest)`. That failure is not the repository-level "Allow GitHub
Actions to create and approve pull requests" toggle: in this repo that setting
is locked by the OAS-Framework organization policy. The repo API returned 409
"disabled by the organization", and changing the organization setting requires
an organization admin token with `admin:org` scope.

**The same restriction has two surfaces.** Until v0.20.0 the known failure
mode was a run with `conclusion=failure` whose only failed step was the
bump-PR create.
On the v0.20.1 release (run `32888965280`, 2026-08-25) it produced a silent
one instead: the run finished **fully green**, the `release-bump/v0.20.1`
branch was pushed, and **no PR existed** — main still carried the previous
version with nothing failing anywhere. A green release run is therefore
evidence for npm publish + GitHub Release only.

# The lesson

1. **Check publish state first.** The npm publishes complete before the bump-PR
   step. A bump-PR failure does not mean a broken release; verify with
   `npm view @oas-framework/oas version` before deciding whether to retag or
   rerun.
2. **Do not chase the repo toggle.** If the repo API says the Actions PR
   setting is disabled by the organization, only an organization admin can
   relax it.
3. **Verify the bump on main after EVERY release, whatever the run
   concluded.** The trigger for the rescue below is "the bump is not on main",
   not "the run failed":
   ```bash
   npm view @oas-framework/oas version          # publish happened
   git show origin/main:package.json            # did the bump land?
   gh pr list --search release                  # is there a bump PR at all?
   git branch -r | grep release-bump            # branch pushed without a PR?
   ```
   A pushed `release-bump/vX.Y.Z` branch with no PR is the silent surface:
   apply the manual rescue exactly as for the old failing-run surface.
4. **Rescue the bump PR manually while the org restriction remains:**
   ```bash
   gh pr create --base main --head release-bump/vX.Y.Z \
     --title "release: vX.Y.Z version bump" --body "..."
   gh pr merge release-bump/vX.Y.Z --squash --delete-branch
   git pull   # bring the bump into the local checkout
   ```
5. **Related Pi install cleanup gotcha:** after installing a new
   `@oas-framework/pi` version, `pi remove npm:@oas-framework/pi@OLD` removes
   both settings entries because removal matches by package name, not by the
   full install spec. Reinstall the new version after any remove.

# Related

- [npm EOTP failure in tag-driven release CI](/lessons/npm-eotp-in-tag-release.md)
- [Deployment probes catch what static checks miss](/lessons/release-verification.md)
