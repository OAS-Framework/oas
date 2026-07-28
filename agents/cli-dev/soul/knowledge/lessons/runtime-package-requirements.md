---
type: Lesson
title: A runtime-package requirement is not a PATH requirement
description: Extending capability `requires` to cover runtime packages needed three separate changes — detection, post-install verification, and identity — because a pi package never appears on PATH and carries a version selector.
tags: [capabilities, requirements, pi, consent, contract]
timestamp: 2026-07-27
---

# Lesson

Founder ruling: using the aweb capability from Pi must **require** the aweb Pi package,
rather than silently depending on whatever the user has installed globally. That ambient
dependency is what made the Pi strict launch unshippable — see the
[Pi runtime-extension blocker](/lessons/pi-strict-launch-blocked-on-runtime-extensions.md).

The existing consent gate was reusable almost wholesale (per-requirement prompt with exact
argv/source/scope, `--accept-requirement`, `--no-requirements`, fail-closed on invalid or
conflicting plans, no shell/sudo/auth, doctor warning when declined). What did **not**
transfer was every place the old design assumed "a command on PATH":

1. **Detection** — `commandOnPath()` can never be true for a Pi package, so the
   requirement would be raised forever. Detection must read the runtime's own package
   list (`~/.pi/agent/settings.json` → `packages`, entries being a source string or
   `{ source }`).
2. **Post-install verification** — same function, same problem: every successful install
   would be reported as a failure.
3. **Identity** — package specs carry version selectors. `npm:@awebai/pi@latest` and
   `npm:@awebai/pi@0.2.1` must be ONE requirement, or two capabilities requesting the same
   package at different selectors would collide as a fake conflict. The selector is the
   **last** `@`, not the first — scoped names start with one.

Requirements are **runtime-scoped**, so a Claude-only deployment is never prompted to
install a Pi package.

# Fail-closed details worth keeping

- An unknown runtime or a non-plain package spec gets **no executable plan at all** and is
  reported as invalid with provenance — never consentable, mirroring the existing
  unsafe-command policy.
- Unreadable runtime settings read as "not installed". A parse failure must never become a
  false positive that skips a real requirement.

# Contract impact

`requires` gaining a second entry shape is a **manifest contract change**: the schema moved
to a `oneOf` of the host-command and runtime-package forms, and every deployment that
validates manifests is affected. Flagged to the maintainer rather than slipped in.

Still outstanding for the Pi strict launch: requiring the package makes it present and
consented, but `--no-extensions` also needs an explicit `-e <path>`, so spawn must resolve
the installed extension's path. Two steps, not one.

# Related

This extends the host-command [requirement recipe lesson](/lessons/requirement-recipes-data-allowlist.md)
without reusing its PATH detection and verification assumptions.
