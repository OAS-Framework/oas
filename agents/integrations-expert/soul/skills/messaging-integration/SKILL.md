---
name: messaging-integration
description: >-
  Building a messaging-layer OAS integration (Slack, Matrix, custom chat) —
  per-instance identity lifecycle via spawn/retire hooks, the OAS_* env
  contract, team boundedness, and meta round-trip. Use when integrating a
  messaging/comms system or debugging identity minting. Triggers: "messaging
  integration", "spawn hook", "identity minting", "OAS_META", "retire hook".
---

# Messaging-layer integrations

Messaging gives each instance a **unique identity on a shared layer** plus a
way to reach its team. The kernel owns naming (unique instance names); your
integration maps names to comms identities. Load integration-craft first.
Template: `capabilities/oas-aweb/` — read `bin/oas-aweb.mjs` fully.

## The hooks contract (exact)

The kernel runs your `hooks.spawn` / `hooks.retire` with cwd = the instance
home and env:

| Var | Content |
|---|---|
| `OAS_EVENT` | `spawn` \| `retire` |
| `OAS_CAPABILITY` | namespaced package ID |
| `OAS_LAYER` | `messaging` |
| `OAS_INSTANCE` | instance name — use it as the identity alias |
| `OAS_HOME` | instance home dir |
| `OAS_AGENT` | agent (soul) name |
| `OAS_CONTEXT` | resolution context (the soul's target repo) |
| `OAS_WORKSPACE` | the agents root's parent — the team boundary |
| `OAS_SETTINGS` | JSON of the config's `settings:` block |
| `OAS_META` | (retire) JSON your spawn hook returned as `meta` |

Output — last stdout line as JSON:
`{ "meta": {...persisted}, "brief": "one TASK.md line", "warning": "..." }`.
`meta` lands in instance.json under your capability ID and round-trips
to retire via OAS_META. Exit codes are advisory: **failures warn, never
block a spawn** — design for graceful degradation (missing CLI, no root
workspace, network down ⇒ warning + no identity, not a crash).

## Team boundedness (hard-won rule — do not relax)

When locating the "authority" that mints identities (root workspace, admin
token, home server): search ONLY bounded candidates —
instance home → its git repo root → OAS_CONTEXT (+ its git root) →
OAS_WORKSPACE. **Never walk past the workspace** (e.g. to a laptop-level
credential): an authority above the workspace belongs to a different team,
and minting into it is a silent cross-team leak. Always pass the target
team/channel **explicitly** (settings pin, else the authority's active
team) and verify what you actually joined; mismatch ⇒ warning.

## Retire ordering (why it exists)

Retire hooks run **before** the home dir is deleted, because identity
material (keys, tokens) usually lives in the home — self-deregistration
needs it. Deregister from inside; treat "already gone" as success. If your
platform defers deletion (staleness windows), warn and move on — never
retry-loop in the hook.

## Skills: prefer native

If the framework ships official agent skills (as aweb does via `@awebai/pi`),
depend on the package and reference its skills in your manifest rather than
writing your own — yours will drift, theirs won't. Write skills only for
what's OAS-specific (identity conventions, boundaries).

## Testing extras

- Full lifecycle against the real platform once: spawn → identity visible
  team-side → message a human → retire → identity gone.
- Boundedness negative test: put a credential/root ABOVE the workspace,
  none inside → your hook must refuse, not leak.
- Kill the CLI from PATH → resolve + spawn → requires-warning appears, spawn
  succeeds without identity.
