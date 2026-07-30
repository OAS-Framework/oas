---
type: Lesson
title: Integrity alone cannot see a disputed origin, so trust must check provenance separately
description: A repaired integrity hash makes a tampered .oas-installation.json invisible to the engine's approval path, so the CLI refuses on the lock/provenance disagreement before delegating to approveCapability.
tags: [cli, trust, integrity, capability-materialization, fail-closed]
timestamp: 2026-07-29
---

A materialized capability carries `.oas-installation.json` inside its artifact:
capability id, version, providing package, package version, source, commit,
package path, and capability path. `verifyCapabilityInstallation` checks every
one of those fields against the lock rows the artifact was projected from, and
treats any disagreement as `invalid-lock` — neither the artifact nor the lock
silently wins.

The usual argument is that integrity already covers this because the provenance
file lives inside the hashed tree. That is true but insufficient. An attacker or
bad merge that edits the provenance file and then updates the lock integrity to
the new hash leaves a state where every byte matches its recorded digest and
only the story disagrees. The measured failure was that `oas trust` approved such
a capability, because `approveCapability` verifies integrity and nothing else.

That is the wrong moment to be permissive: approval unlocks the executable
surface. `oas trust` now computes the capability's health first — missing,
drifted, provenance, then untrusted — and refuses with the disagreement before
it delegates. The lock remains `trusted: false`.

Two design points carry forward:

- **The check order is not cosmetic.** A missing artifact cannot be hashed;
  drifted bytes make an existing approval meaningless, so trust is not also
  reported for it; provenance is only worth reading once the bytes are the
  locked ones. Reporting "untrusted" for a drifted capability would send the
  operator to `oas trust`, which is the wrong repair.
- **One helper, both commands.** `doctor` and `list` share `capabilityHealth`,
  so a disagreement gets the same code and wording wherever it surfaces. Before
  that, provenance was only consulted deep inside `capabilityTrust`, where it
  reached the operator as a bare "untrusted" with no hint of what was actually
  wrong.

This sharpens the trust boundary recorded for
[catalog-first classic init](/lessons/catalog-first-classic-init-costs.md):
package acquisition can leave executables untrusted until `oas trust`, but the
trust action itself must not treat matching bytes as enough when the bytes tell
a different origin story than the lock.

# Follow-up

Open with the engine lane: `approveCapability` itself should fail closed on the
provenance disagreement, since the contract says it must fail closed through the
engine. The CLI guard is correct regardless; it just should not be the only one.
