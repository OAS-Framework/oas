---
type: Playbook
title: CLI transaction map for config-template adoption, sync, and fresh classic init
description: What each config-template and init command must do in order, which writes must be atomic together, and the exact engine seams the CLI lane needs frozen before it can consume them.
tags: [cli, config, templates, adoption, sync, init, transactions, seams]
timestamp: 2026-07-29
---

Mapped during the engine contract freeze, from the accepted decision
`capability-materialization-and-config-template-sync.md` plus the current
0.19 surface in `bin/oas.mjs` (`initPackage`, `configDiffCmd`) and
`lib/packages.mjs`.

# Durable artifacts the CLI owns

```text
<scope>/oas-config.yaml                                        # zero or one active config
<scope>/.agents/config-templates/adopted/<package-id>/<template-name>/
    oas-config.yaml                                            # exact adopted base, commit-safe
    adoption.json                                              # package/template/source/version/commit/path/hash
```

At most one adopted base per scope survives any operation. The adopted base is
the *exact template bytes*, not the local config: sync's three-way comparison is
meaningless if the base drifts toward the local file.

# Per-command transactions

**`oas install <package>`** — installs every exported capability, applies no
template. Reports available templates as an optional follow-up. No config write,
no adopted-base write. This is a report-only relationship to templates.

**`oas init --package <src> --config <name>`** (first adoption) — order matters:
1. acquire/stage and validate the whole payload; project capabilities; write the
   exact lock;
2. select the template (explicit name → single marked default → only template →
   otherwise ambiguous);
3. validate the template as a config (schema + capability supply + layer
   agreement + no scope-escaping paths) BEFORE any durable write;
4. write, atomically together: local `oas-config.yaml`, the adopted base copy,
   `adoption.json`;
5. any failure after step 1 rolls back only this run's writes and leaves
   pre-existing bytes byte-identical.

**`oas config diff`** — read-only. Base + local + template from the current exact
lock → merge plan → render. Never writes, never merges.

**`oas config sync`** — plan first, present the complete plan, then mutate:
backup the current config → apply selected regions → write config → update the
adopted base to the template just synced against → update `adoption.json`. The
adopted base advances ONLY on success; on any failure the config, base, and
metadata are byte-identical to their pre-run bytes.

**`oas config sync --reset`** — preview every local change that will be lost,
require strong confirmation (or an explicit noninteractive acceptance flag),
back up, then replace config + base + metadata atomically.

**`oas config adopt <other.package> --config <name>`** — base switch. Rebases the
one local config against the new base; on success exactly one adopted base
remains (the old one is removed in the same commit step); on failure the prior
config, base, and metadata are unchanged.

**Fresh classic `oas init`** — one run-level transaction spanning config, lock,
flat capability artifacts, provenance files, `.agents/capabilities/.gitignore`,
and any newly created anchor. The rollback set is *this run's* changes only; a
pre-existing same-name installed capability must come back byte-identical.

# Ordering rules that are easy to get wrong

* Validation strictly precedes durable writes — the 0.19 code already does this
  for profiles and it must survive the rewrite.
* Acquisition ≠ activation ≠ executable trust ≠ requirement consent. Four
  separate decisions; adopting a template grants none of the others.
* Mid-init the config chain cannot see the scope being initialized (there is no
  `oas-config.yaml` yet), so own-scope lock/manifest visibility must be read
  directly rather than through `resolveOasConfig`. This bit the 0.19 lane twice
  already.
* Exactly one stdout JSON envelope per run, success or failure; human progress
  prose goes to stderr in JSON mode.

# Engine seams this lane needs frozen

Coordinator-frozen revised-v2 answers are recorded in
[frozen revised-v2 engine seam answers](/references/frozen-revised-v2-engine-seam-answers.md).
The original questions remain here as the CLI lane's transaction map.

Recorded as questions for the coordinator, not assumptions:

1. **Locked-template reader** — signature and return shape for reading a
   template from the *current exact lock* without a persistent package root.
   The CLI needs bytes plus provenance (package, version, commit, source, path,
   and a content digest). Does it also validate, or is validation the caller's?
2. **Digest spelling** — `adoption.json`'s `hash` must be the digest the engine
   already computes for the template payload, in the engine's format, so doctor
   can compare without a second hashing convention.
3. **Staged acquire return** — does the staged transaction hand back template
   payload *bytes* inline? If staging is discarded before the CLI reads, the
   adopted base cannot be written from the same transaction that produced the
   lock, which breaks "the base is the exact locked template".
4. **Template listing** — a flat listing per locked package (name, description,
   default marker) for post-install follow-up reporting and for `config adopt`.
   Does it normalize the legacy 0.19 `configs` spelling to `configTemplates`?
5. **Run-level transaction handle** — can CLI-owned writes (config, adopted
   base, metadata) register compensations with the engine's init transaction, or
   must the CLI run its own rollback journal around the engine call? This
   decides whether the fresh-init rollback guarantee is one mechanism or two.
6. **`.gitignore` ownership** — does the engine write
   `.agents/capabilities/.gitignore` during materialization, or does the CLI? The
   assertion (`installed/` only; never `owned/`, never the adopted-templates
   path) belongs to whichever side writes it.
7. **Typed lifecycle error codes** — the list to pass through verbatim, so the
   CLI does not re-wrap engine failures as prose.

The byte-preserving merge core needs none of these, which is why it was built
first — see [byte-preserving three-way config merge](/lessons/byte-preserving-three-way-config-merge.md).
