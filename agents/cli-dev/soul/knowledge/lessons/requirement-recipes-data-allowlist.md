---
type: Lesson
title: Requirement install recipes as data — allowlist plans, argv-only execution, PATH verify
description: Host-requirement installers are planned by an allowlisted manager table that validates package/formula names against strict regexes and returns argv arrays; consent, execution (execFileSync, no shell), and post-install PATH verification are separate steps so noninteractive fail-safe and per-requirement acceptance flags fall out naturally.
tags: [requirements, consent, security, install]
timestamp: 2026-07-26
---

# Lesson

The consented host-requirement gate decomposes cleanly into four pieces:

1. `normalizeRequirement` converges legacy `install: "url"` and structured
   `{ docs, methods[] }` inputs on one shape.
2. `requirementInstallPlan(req, { platform })` is the only place recipes become
   commands. `REQUIREMENT_MANAGERS` is an allowlist (`npm-global`, `brew`,
   `download-checksum` stubbed). Each manager validates its argument with a
   strict name regex, rejecting `;`, spaces, and `&&` as "not a plain
   package/formula name", and returns `{ argv, source, scope }` — never a shell
   string. Non-allowlisted managers are silently unavailable, never executed.
3. Consent lives at the CLI: interactive prompt per requirement showing exact
   argv, source, version, and user-level scope; `--accept-requirement <cmd>` for
   automation; noninteractive default is report and skip; `--no-requirements`
   skips the whole gate.
4. `runRequirementInstall(plan)` executes `execFileSync(argv[0], argv.slice(1))`,
   then re-checks PATH and reports `onPath` honestly.

Testing trick: put a fake `npm` shim on PATH that writes its argv to a file and
drops a fake binary into the same bin dir. That proves both "consent runs the
exact argv" and "PATH verification succeeds/fails honestly" without touching
the host.

Version extraction from `@scope/pkg@1.2.3` needs `/.@([^@]+)$/`, not
`split("@")`, because scoped packages start with `@`.
