---
type: Decision
title: OAS development team — PR-only flow, review capability, capability-defined agents, model preference lists
status: accepted
description: The OAS repo gets a real development team (webpanel-dev, tui-dev, cli-dev on fable-5 high, a dev-coordinator, and oas-expert as maintainer) with PR-only merges to main gated by the maintainer's pr-review skill; a marketplace oas.review capability ships a fresh reviewer agent (gpt-5.6-sol) plus code-review and security-review skills with a post-commit injection; two kernel contracts enable it — capability-defined agents (manifest agents: field, read-only package souls, locally homed instances) and model preference lists (comma-separated provider fallbacks probed at spawn).
tags: [team, review, pr, capability-agents, model-fallback, kernel]
timestamp: 2026-07-21
---

Decided with the founder, 2026-07-21.

# The team

| Soul | Role | Mode | Model (preference list) |
|---|---|---|---|
| webpanel-dev | oas.web expert | worktree | github-copilot/claude-fable-5:high → anthropic |
| tui-dev | Control Pane expert | worktree | same |
| cli-dev | kernel/CLI expert | worktree | same |
| dev-coordinator | multi-dev feature planning + PRs | checkout | same |
| reviewer (oas.review) | fresh post-commit review | attached | github-copilot/gpt-5.6-sol:high → openai |
| oas-expert | maintainer + vision | checkout | (unchanged) |

Copilot-authenticated models are the default; the second entry falls back to
the native provider when copilot is unavailable — resolved at spawn. That
spawn-time contract does not cover mid-session provider/auth failures; see
[Copilot-proxied models fail mid-session](/lessons/copilot-auth-fragility.md).

# Flow

Developers work in worktrees; **the dev team merges to main only through
PRs**. Single-dev features: the developer opens the PR. Multi-dev features:
the coordinator owns the feature branch and PR. The **maintainer
(oas-expert) commits directly to main** — amended by the founder 2026-07-21;
the PR gate exists to review the dev team's work, not to slow the
maintainer's stewardship (framework changes still go through the human per
the soul's boundaries). Every substantive commit triggers the
injected review discipline: spawn the fresh reviewer attached to the work
tree; NEEDS CHANGES blocks readiness. The maintainer (oas-expert) reviews
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

Developer souls were seeded via a fan-out workflow mining the oas-expert pi
sessions that built each surface: 11 concepts (cli-dev), 8 (tui-dev),
10 (webpanel-dev) — architecture, decisions-by-reference, hard-won gotchas
(bracketed-paste sends, stale-response races, OSC 11 timing, init-acquisition
ordering). All bundles OKF-validated.
