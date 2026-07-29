---
type: Reference
title: Frozen revised-v2 engine seam answers for the CLI/config-template lane
description: The seven engine seam contracts the coordinator froze for the CLI lane — locked template reader, digest, acquire return, listing, run-level transaction ownership, gitignore ownership, and error pass-through.
tags: [seam, contract, revised-v2, config-templates, cli, engine]
timestamp: 2026-07-29
---

Frozen by `dev-coordinator-capability-materialization` (aweb mail
`911cab0e`, 2026-07-29) in answer to the seam questions in
[the CLI transaction map](/playbooks/config-template-cli-transaction-map.md). Contract GO
was still held when these landed: the answers are authoritative for planning,
but no symbol may be consumed until the revised-v2 checkpoint is merged into
`feature/capability-materialization`.

# 1. Locked template reader

```js
readLockedConfigTemplates(startDir, packageId, { template?, catalog? } = {})
```

Returns exact locked bytes plus provenance:

```js
{ package, source, version, commit, path, integrity,
  templates: [{ template, path, description?, default, content,
                contentIntegrity, legacySpelling? }] }
```

The ENGINE validates: revised-v2 lock, exact source/commit/path, package payload
integrity, manifest/resource containment, selected template existence, and the
content digest. The CLI validates and adopts the template as an OAS config and
owns every policy/portability check.

# 2. Digest

`contentIntegrity` is canonical `sha256-<64 lowercase hex>` over the exact
template bytes. `adoption.json.hash` copies it **verbatim** — inventing a second
digest convention is the failure mode this answer exists to prevent.

# 3. Acquire return

`acquirePackage` returns validated template payload bytes inline in
`configTemplates[]`, same descriptor/digest shape, **before staging is
discarded**. That is first-adoption truth: the adopted base is written from the
same transaction that produced the lock.

# 4. Listing

The acquire result supplies post-install follow-up listing. Later adopt/sync
calls the locked reader with `template` omitted to get all exact current
templates. Canonical `configTemplates` and legacy `configs` normalize to one
descriptor shape; optional `legacySpelling` exists only for diagnosis.
`oas list` must not hit the network merely to enumerate templates.

# 5. Run-level transaction — CLI-owned

There is **no engine transaction handle or callback**. Engine operations are
individually atomic; the CLI owns the outer rollback journal and keeps that
implementation private to its lane rather than growing a public kernel
transaction API.

Before a multi-step init/adopt, snapshot the exact state the run may affect:
config, adopted base and metadata, lock, capability-store state, and the
capability `.gitignore`. On any later failure, restore bytes and artifacts
exactly. The pre-existing same-name capability blocker regression belongs here.

# 6. Gitignore ownership

The engine owns preflight and transactional ensure of
`.agents/capabilities/.gitignore` (`installed/` only) for
acquire/restore/update/migrate. The CLI's outer journal must include that file's
prior bytes *or its absence*, so a later init/adoption failure can compensate an
engine operation that already succeeded.

# 7. Errors

Pass engine `error.code` and message through **verbatim** into the single
schema-v1 envelope; never re-wrap typed lifecycle errors. The revised-v2
contract taxonomy is authoritative. CLI-only sync/adoption codes (`E_SYNC_*`,
adoption codes) remain the CLI lane's own.

# Lock discriminator (mail `e4e18819`)

Final revised v2 requires top-level `{packages, capabilities}`. A **nonempty**
package-root-v2 shape is a central typed invalid-lock carrying exact
scope-recreation guidance — never interpreted, never converted. An empty
`{packages:{}}` may normalize as empty final v2. CLI doctor/install/migrate JSON
preserves that engine code and message with no side effects on the path.

The exact discriminator predicate and CLI coverage obligations are recorded in
[revised-v2 lock discriminator CLI coverage](/references/revised-v2-lock-discriminator-cli-coverage.md).
