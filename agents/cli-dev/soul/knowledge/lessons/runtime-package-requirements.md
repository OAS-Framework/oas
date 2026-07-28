---
type: Lesson
title: A runtime-package requirement is not a PATH requirement
description: Runtime package and plugin requirements need per-runtime detection, identity, plan shape, and post-install verification rather than PATH-style assumptions.
tags: [capabilities, requirements, pi, claude-code, consent, contract]
timestamp: 2026-07-28
---

# Lesson

Founder ruling: using the aweb capability from Pi must **require** the aweb Pi package,
rather than silently depending on an undeclared host installation.

The existing consent gate was reusable almost wholesale (per-requirement prompt with every
ordered argv step and source, `--accept-requirement`, `--no-requirements`, fail-closed on
invalid or conflicting plans, no shell/sudo/auth, doctor warning when declined). What did
**not** transfer was every place the old design assumed "a command on PATH":

1. **Detection and post-install verification** — `commandOnPath()` can never prove a Pi
   package is installed. OAS asks the selected runtime through `pi list --no-approve`,
   requires a matching package row with a real install location, and uses the same probe
   after installation. A settings row records configuration intent only; when Pi cannot be
   run it may support diagnostics, but remains unverified and never satisfies presence.
2. **Resource filters** — settings still matter when they explicitly filter extensions.
   An entry with no `extensions` key is accepted because runtime extension discovery remains
   unfiltered. `extensions: []` disables the required surface, and any non-empty extension
   filter is unverifiable without reimplementing Pi's resolver, so both explicit forms fail
   closed. Filters on unrelated resources such as skills do not invalidate the extension
   requirement.
3. **Identity** — package specs carry version selectors. `npm:@awebai/pi@latest` and
   `npm:@awebai/pi@0.2.1` must be ONE requirement, or two capabilities requesting the same
   package at different selectors would collide as a fake conflict. The selector is the
   **last** `@`, not the first — scoped names start with one.

# Extending the kind to a second runtime

Adding Claude beside pi was not a copy-paste of the Pi package shape:

- **Identity is per-runtime.** A Claude plugin id is `name@marketplace`, where `@` separates
  the source. Reusing npm's version-selector stripping would collapse plugins from different
  marketplaces into one identity. Spec validation is per-runtime for the same reason.
- **Install plans can be a sequence.** A Claude marketplace must be registered before the
  plugin installs, so a single `argv` is not enough. Both steps belong in the consent prompt:
  agreeing to a plugin also means agreeing to the third-party source it comes from.
- **Installed is not enabled.** `claude plugin list` reports a Status line; a disabled plugin
  is installed but inert, so it must not satisfy a requirement.

The founder's ruling that OAS must not exclude the operator's Claude configuration is not
permission to silently add to it. Verified-not-installed at spawn is the boundary.

Requirements are **runtime-scoped**, so a deployment is only prompted for packages or plugins
that the selected runtime can actually use.

# Fail-closed details worth keeping

- An unknown runtime or a non-plain package spec gets **no executable plan at all** and is
  reported as invalid with provenance — never consentable, mirroring the existing
  unsafe-command policy.
- A failed runtime probe or unreadable fallback settings read as "not verified installed".
  Configuration intent and parse failures must never become false positives that skip a
  real requirement.

# Contract impact

`requires` gaining a second entry shape is a **manifest contract change**: the schema moved
to a `oneOf` of the host-command and runtime-package forms, and every deployment that
validates manifests is affected. Flagged to the maintainer rather than slipped in.

Pi's final launch posture deliberately keeps globally configured extensions enabled while
curtailing ambient skills, context files, and prompt templates. OAS therefore does **not**
add `--no-extensions`, explicit `-e` paths, or a private copy of Pi's extension-resolution
algorithm. It verifies the required package through Pi and records runtime discovery
honestly in provenance.

# Related

This extends the host-command [requirement recipe lesson](/lessons/requirement-recipes-data-allowlist.md)
without reusing its PATH detection and verification assumptions. The
[runtime contract lesson](/lessons/runtime-contract-not-resolution-internals.md) explains
why package verification replaced extension-path reconstruction.
