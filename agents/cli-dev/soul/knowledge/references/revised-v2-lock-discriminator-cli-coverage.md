---
type: Reference
title: Revised-v2 lock discriminator and the CLI coverage it obliges
description: The exact OR predicate that rejects a transitional package-root v2 lock, which row fields are not tells, and what the CLI lane must pin around lock-only scopes and legacy lock writes.
tags: [lock, revised-v2, discriminator, cli, doctor, migrate, testing]
timestamp: 2026-07-29
---

Frozen by `dev-coordinator-capability-materialization` (aweb mails
`e4e18819` and `a7973b9c`, 2026-07-29), extending
[the frozen seam answers](/references/frozen-revised-v2-engine-seam-answers.md). Post-GO
scope — nothing here is consumable until the revised-v2 checkpoint merges.

# Scope reads

The engine uses **direct raw lock-scope reads, not `configChain`**, so
configless lock-only scopes are visible. This is the engine-side counterpart of
the CLI lesson that mid-init the config chain cannot see the scope being
initialized.

# The rejection predicate (exact, OR)

A lock is rejected as transitional package-root v2 if **either**:

* it is a nonempty v2 missing top-level `capabilities` — that alone rejects; or
* independently, any package row carries `capabilities`, `trustedCapabilities`,
  or the optional `depsIntegrity`.

Row `path` and `dependencies` are **not** tells — revised v2 keeps them, so
treating them as evidence would reject valid locks. The row tells are own-property
presence rather than truthiness; see
[transitional lock tells](/references/transitional-lock-tells-are-presence-not-truthiness.md).

Normalization boundaries:

* Empty **v1** remains pending explicit migration.
* Only a **state-free empty transitional v2** may normalize.
* Anything nonempty and transitional is a central typed `invalid-lock` with
  exact scope-recreation guidance — never interpreted, never converted.

# CLI obligations

* `doctor` / `install` / `migrate` preserve the central `invalid-lock` code and
  message verbatim and cause **no side effects** on that path.
* Pin dependency-free old rows in tests (a row without `dependencies` must not
  accidentally read as revised v2 or as transitional).
* Pin lock-only-scope output in both JSON and human modes — a scope with a lock
  and no `oas-config.yaml` must still report correctly.
* Ensure the legacy `writeCapabilityLock` path can **never downgrade** a revised
  v2 lock. This is the dangerous one: a v1-era writer silently rewriting a
  revised-v2 lock would destroy the `capabilities` map that the discriminator
  depends on, and the next read would then classify the scope as transitional
  and refuse to operate.
