---
type: Decision
title: OAS development team — PR-only flow, review capability, capability-defined agents, model preference lists
status: accepted
description: The OAS repo uses Claude Code Opus developers for kernel, Desktop, and UX work, with GPT-5.6 Sol coordinator, reviewer, and maintainer roles; developers deliver through PRs gated by the maintainer review flow.
tags: [team, review, pr, capability-agents, model-fallback, kernel]
timestamp: 2026-07-27
---

Decided with the founder, 2026-07-21; team/runtime assignment amended by the
founder 2026-07-27 after the Desktop succession completed.

# The team

| Soul | Role | Mode | Runtime / model |
|---|---|---|---|
| cli-dev | kernel/CLI expert | worktree | Claude Code / `opus` |
| oas-desktop-engineer | Desktop full-stack expert | worktree | Claude Code / `opus` |
| ux-designer | product UX specialist | worktree | Claude Code / `opus` |
| dev-coordinator | multi-dev feature planning + PRs | checkout | Pi / github-copilot gpt-5.6-sol → OpenAI |
| reviewer (oas.review) | fresh post-commit review | attached | Pi / github-copilot gpt-5.6-sol → OpenAI |
| oas-expert | maintainer + vision | checkout | Pi / github-copilot gpt-5.6-sol → OpenAI |

Claude's `opus` alias deliberately tracks Claude Code's current Opus default
(Opus 5 at this decision). OAS does not pin the dated provider model ID.
Coordinator, reviewer, and maintainer retain the explicit
`github-copilot/gpt-5.6-sol:high, openai/gpt-5.6-sol:high` preference list.
That spawn-time fallback contract does not cover mid-session provider/auth
failures; see [Copilot-proxied models fail mid-session](/lessons/copilot-auth-fragility.md).

The retired `webpanel-dev` and `tui-dev` souls were removed after their useful
knowledge moved into `oas-desktop-engineer`; their product surfaces had already
been superseded by OAS Desktop.

# Flow

Developers work in worktrees; **the dev team merges to main only through
PRs**. Single-dev features: the developer opens the PR. Multi-dev features:
the coordinator owns the feature branch and PR. The **maintainer
(oas-expert) commits directly to main** — amended by the founder 2026-07-21;
the PR gate exists to review the dev team's work, not to slow the
maintainer's stewardship (framework changes still go through the human per
the soul's boundaries). Every substantive commit triggers the
injected review discipline: spawn the fresh reviewer attached to the work
tree; NEEDS CHANGES blocks readiness. That narrow reviewer protocol reflects
the first [multi-agent run failure modes](/lessons/multi-dev-run-failure-modes.md):
reviewers stay ephemeral/diff-only and communicate by aweb mail so developer
self-review does not replace fresh eyes. The maintainer (oas-expert) reviews
every PR with the **pr-review** soul skill — four gates: product direction
(against recorded decisions), correctness (full local gate re-run),
security (trust-boundary lens), mergeability — merging or returning to the
PR owner. Enforcement is discipline + maintainer gate, not git hooks
(consistent with work-mode philosophy); GitHub branch protection can be
added later.

# Kernel contracts added (v0.16.0)

1. **Capability-defined agents**: manifest `agents: ["agents/reviewer"]` —
   package-relative soul dirs. Resolution on *declaration* in the config
   chain (not per-soul binding: a developers-targeted capability must still
   let anyone spawn the reviewer). The package soul is read-only (`_soulDir`
   split from `_dir`): fresh identity per spawn, no accumulated memory —
   exactly right for service agents. Instances home under the scope's
   `local-agents/<name>/instances/`; retire handles the soul-less local home.
2. **Model preference lists**: `model:` accepts comma-separated
   `provider/id[:thinking]` entries; spawn resolves the first available (pi
   probed via `pi --list-models`, non-pi runtimes take the first entry).
   Thinking level rides the pi pattern string — no separate kernel field.

# Review skill sources

code-review distills Google's engineering-practices review standard
("approve when it improves overall code health"; two-pass reading;
severity-ranked actionable findings). security-review follows the OWASP
code-review model organized by trust boundary (injection, secrets,
authn/z, supply chain), ranked by exploitability with attack-scenario
discipline. Both live in oas.review; the reviewer runs both, stricter
verdict wins.

# Knowledge seeding

Developer souls were originally seeded via a fan-out workflow mining the
sessions that built each surface. The donor TUI/web knowledge was later
migrated topic-by-topic into the Desktop owner before those souls were removed.
The current developer bundles remain OKF-validated.
