---
type: Lesson
title: Overlapping instance-home scans must dedupe canonical homes
description: listAgents(root) already includes local souls from localAgentBases(root), so all-match instance enumerators that also scan localAgentBases for capability fallbacks must dedupe by canonical home or local instances look duplicated.
tags: [kernel, enumeration, local-agents, capability-agents, dedupe, relations]
timestamp: 2026-07-25
---

# Lesson

The OAS kernel's instance-home discovery paths can overlap. `listAgents(root)`
already returns local souls discovered from `localAgentBases(root)`, while the
capability-agent fallback also walks `localAgentBases(root)` to find
`local-agents/<name>/instances/` homes for capability-defined agents without a
local soul. A scanner that runs both phases can visit the same local-soul
instance directory twice.

First-match APIs such as `findInstanceHome` hid that overlap because they
returned the first hit. All-match APIs such as `findInstanceHomes` must not pass
raw phase results onward: duplicate visits to the same canonical home look like
two intra-root candidates, which makes a valid relation to a local-soul instance
appear inherently ambiguous.

Rules:

- Dedupe every all-matches enumerator by canonical home (`realpath` with a
  resolve-path fallback) before applying ambiguity policy.
- When converting a first-match lookup to an all-matches lookup, audit the scan
  phases for overlap that first-match semantics silently tolerated.
- Name-resolution regression tests need a local-soul fixture, not only
  persistent agents or cross-repo/team roots; local souls exercise the
  `listAgents` plus local fallback overlap path.

# Related

This is a construction gotcha for the all-match posture in
[lineage-edge-ambiguity-posture](/lessons/lineage-edge-ambiguity-posture.md).
The capability-agent home fallback is summarized in
[capability-defined-agents](/architecture/capability-defined-agents.md), and
the fixture requirement belongs with the [test conventions](/playbooks/test-conventions.md).
