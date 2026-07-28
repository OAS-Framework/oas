---
type: Reference
title: Strict curriculum scoping and release gate rulings
description: Launch-path facts and maintainer rulings for strict instance curriculum enforcement, including the 0.19.0 release gate for complete active-capability resource materialization.
tags: [skills, launch, pi, claude, curriculum, ruling, release-gate]
timestamp: 2026-07-27
---

# Strict curriculum scoping and release gate rulings

Launch-path facts and maintainer rulings gathered while scoping strict instance
curriculum enforcement:

- Pi: verified on pi 0.80.10 that `--no-skills` disables discovered skills and
  keeps explicit `--skill <path>` entries, but extension `resources_discover`
  hooks still inject skills. Strict mode therefore needs `--no-skills --skill
  <home>/.agents/skills --no-extensions -e <selected extension> ...` plus
  `--no-context-files --no-prompt-templates` and explicit delivery of the
  generated instance `AGENTS.md` through `--append-system-prompt <file>`. Built-in
  tools survive; `--no-tools` must not be used for launch or skill-inventory
  probes. See [pi strict launch](/lessons/pi-strict-launch-requires-no-extensions.md).
  Do not enable that launch line before runtime extensions are capability
  resources, because the aweb Pi extension currently comes only from user-global
  Pi settings; see [the Pi runtime-extension blocker](/lessons/pi-strict-launch-blocked-on-runtime-extensions.md).
  The package-presence fix is a Pi runtime-package requirement, not a PATH-based
  host-command requirement; see [runtime-package requirements](/lessons/runtime-package-requirements.md).
- Claude Code: verified on Claude Code 2.1.220 that an isolated
  `CLAUDE_CONFIG_DIR` breaks OAuth/keychain auth. The working strict mechanism is
  `--setting-sources ""` against the deployment's real config dir, plus
  `--plugin-dir` for the composed instance skills as a session-only plugin,
  `--plugin-dir` for each selected provider plugin, `--settings <file>`, and
  `--append-system-prompt-file <home>/AGENTS.md`. This excludes user/project and
  ancestor skills, ambient plugins, and project/ancestor `CLAUDE.md` while keeping
  auth, built-ins, OAS-owned settings, and explicitly selected plugin MCP
  servers. Use `--debug-file` output, not model self-report, as the oracle. See
  [claude strict launch](/lessons/claude-strict-launch-setting-sources.md).
- Sequencing: package-engine merges first; the strict-curriculum branch is cut
  from updated main, not from the package-engine feature branch, but remains in
  the same 0.19.0 release. Package-engine M2 must not claim strictness;
  `instance.json` surface evidence rides the curriculum PR, not M2.
- After the fail-open defect in
  [work-tree-relative-capability-skills-fail-open](/lessons/work-tree-relative-capability-skills-fail-open.md),
  `oas-expert-oas-packages` relayed founder reinforcement that complete
  active-capability curriculum is an explicit release gate for the overall
  effort, not deferred past 0.19.0. The implementation must prove that every
  skill, injection, and plugin declared by capabilities active for the soul is
  resolved from locked/materialized sources rather than spawn-time disk state;
  each such resource is copied into the instance and recorded in provenance;
  the result is visible in fresh Pi and Claude real runtimes; missing required
  resources fail spawn closed with rollback and no zombie instance; and
  installed-but-inactive capabilities remain absent. The WS2 package-config
  branch stays scoped as-is; this implementation belongs to the separate
  strict-curriculum feature, with the package-config branch only owing the
  evidence and lesson. Resolving from locked/materialized sources removes the
  spawn-time race because materialization has a defined package-lifecycle
  completion point, unlike a bare path probe. The founder-decided sourcing for
  `oas-aweb` is to vendor reviewed, MIT-attributed copies of the three aweb
  Markdown skills with exact upstream repo/tag/commit provenance and
  deterministic sync tooling, not to ship `@awebai/pi`/`@awebai/aw` and their
  native/platform dependency closure just to obtain those skills.
- `instance.json` already records skills and instructions with source
  provenance; the strict-curriculum Decision's surface-recording requirement is
  a small additive extension.
- Repo/worktree `AGENTS.md` files are ruled visible as source but not auto-loaded
  as instruction injection. Only the generated instance `AGENTS.md` plus
  selected injections load; pin this with planted worktree and ancestor tests on
  both runtimes.
- Parity acceptance requires exactly the three kernel skills plus selected
  skills, generated instructions only, plugin survival, provenance evidence in
  `instance.json`, and no zombie home. The README "no skill noise" claim is
  blocked until both real-runtime gates pass.
- Before production implementation, deliver Claude spike evidence and the
  mechanism plan through the coordinator to the maintainer.
