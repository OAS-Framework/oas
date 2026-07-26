---
type: Reference
title: Strict curriculum scoping facts
description: Key launch-path facts gathered while scoping strict instance curriculum enforcement: pi can combine --no-skills with explicit --skill, Claude Code isolation needs CLAUDE_CONFIG_DIR plus a version-probed allowlist, and enforcement belongs in spawnInstance command-line construction.
tags: [skills, launch, pi, claude, scoping]
timestamp: 2026-07-26
---

# Strict curriculum scoping facts

Launch-path facts gathered while scoping strict instance curriculum enforcement:

- Pi: `--no-skills` disables discovery; explicit `--skill <path>` still loads.
  At capture time, `spawnInstance` already passed `--skill <home>/.agents/skills`
  for ambient coexistence, so strict mode means adding `--no-skills` plus a
  `pi --help` capability probe.
- Claude Code: `.claude/skills` is already a curated symlink, but personal
  `~/.claude/skills`, plugins, and ancestor directories can leak in. Candidate
  isolation is a per-instance `CLAUDE_CONFIG_DIR`; it needs a spike and should
  fail closed on unverifiable versions.
- Engine spawn-probe fixtures use `launch: false`, so package-engine M2 does not
  depend on strict mode. Sequencing strict curriculum as a separate dependent
  branch is safe, while still release-coupled to 0.19.0.
- `instance.json` already records skills and instructions with source
  provenance; the strict-curriculum Decision's surface-recording requirement is
  a small additive extension.
