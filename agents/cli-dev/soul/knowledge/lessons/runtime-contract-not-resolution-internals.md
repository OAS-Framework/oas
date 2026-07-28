---
type: Lesson
title: Verify a runtime dependency; do not reimplement the runtime's resolution rules
description: Resolving pi extension entry points meant copying pi's globs, exclusions, conventional directories and relocatable roots — two of three reviewer findings vanished once OAS verified the package instead and let pi resolve the files.
tags: [pi, runtime, capabilities, design, fail-closed]
timestamp: 2026-07-27
---

# Lesson

To pass `-e <path>` under `--no-extensions`, OAS had to answer "where is this package's
extension file?" That looks like a lookup. It is actually pi's package resolution
algorithm, and the copy was wrong in three ways at once:

- `pi.extensions` entries can be **globs with exclusions**, not literal paths;
- a package with **no `pi` manifest** still exposes extensions through conventional
  directories;
- the roots are **relocatable**, and `PI_PACKAGE_DIR` is pi's own asset dir — *not*
  `pi install` output — so using it as the package root breaks Nix/Guix-style hosts
  entirely.

When the founder ruled that ambient pi extensions stay enabled (operators run shared
cross-agent extensions like web search and formatting), the `-e` flags became unnecessary,
and with them the entire resolution problem. Two of three reviewer findings dissolved at
the root rather than being patched.

# The rule

Depend on a runtime's *contract* (is this package installed?), not on its *internals*
(where did it put the files?). Verification is a question the runtime already answers;
resolution is an algorithm you would have to keep in sync forever.

What OAS keeps: the package must be installed, absence fails the spawn with the exact
consent command, and the requirement is recorded in `instance.json` provenance with
`loadedBy: "runtime-discovery"` so the record does not imply OAS selected the file.

# Related

The remediation for a failed spawn must actually work: `--runtime pi` on a claude-default
soul printed `oas install --accept-requirement pi:<pkg>`, but runtime scoping filtered that
requirement out of the install run, so it installed nothing and the retry failed
identically. Explicitly naming a requirement now overrides scoping — naming it IS the
statement that this host needs it. Any "run X to fix this" message deserves a test that
runs X.

See also [runtime-package requirements](/lessons/runtime-package-requirements.md) and
[targeted capability requirements](/lessons/aggregate-requirements-targeted-capabilities.md).
