---
type: Reference
title: Strict curriculum scoping and maintainer ruling
description: Launch-path facts and maintainer rulings for strict instance curriculum enforcement: Pi strict mode is viable, Claude requires a real-runtime spike, repo AGENTS files stay visible but not auto-loaded, and parity acceptance gates README claims.
tags: [skills, launch, pi, claude, curriculum, ruling]
timestamp: 2026-07-26
---

# Strict curriculum scoping and maintainer ruling

Launch-path facts and maintainer rulings gathered while scoping strict instance
curriculum enforcement:

- Pi: `--no-skills` disables discovery; explicit `--skill <path>` still loads.
  At capture time, `spawnInstance` already passed `--skill <home>/.agents/skills`
  for ambient coexistence, so strict mode means adding `--no-skills` plus a
  capability probe. The approved Pi mechanism is the scoped `--no-skills` probe,
  explicit selected skills, fail-closed behavior, doctor diagnostics, and a
  planted-ambient clean-room test.
- Claude Code: `.claude/skills` is already a curated symlink, but personal
  `~/.claude/skills`, plugins, and ancestor directories can leak in. Candidate
  isolation is a per-instance `CLAUDE_CONFIG_DIR`; it needs a spike and should
  fail closed on unverifiable versions. The Claude spike comes before production
  implementation and must use real Claude, not shims, with evidence across
  user, ancestor, worktree, package, and plugin skill discovery;
  `CLAUDE.md`/`AGENTS.md` auto-context versus the generated instance file;
  isolated config-home auth and model behavior; capability-selected runtime
  extensions such as the aweb channel plugin surviving strict isolation as
  declared provenance; native tools preserved; and known-good plus
  unknown-version fail-closed behavior with doctor output. A version allowlist is
  acceptable initially, but must report the maintenance path and tested band;
  prefer a supported behavioral probe and do not monkeypatch.
- Sequencing: package-engine merges first; the strict-curriculum branch is cut
  from updated main, not from the package-engine feature branch, but remains in
  the same 0.19.0 release. Package-engine M2 must not claim strictness;
  `instance.json` surface evidence rides the curriculum PR, not M2.
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
