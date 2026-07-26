# oas-okf

Official [OAS](https://github.com/OAS-Framework/oas) knowledge-layer integration for [Open Knowledge Format](https://github.com/google/open-knowledge). It provides:

- idempotent soul scaffolding for an OKF knowledge bundle;
- per-instance `STATE.md`, `log.md`, and `notes/` continuity;
- the `okf` and `memory-harvest` skills plus a zero-dependency validator;
- `oas okf harvest`, which launches an ephemeral harvester to promote pending notes; and
- lifecycle instructions that keep the kernel memory-format agnostic.

## Requirements

The capability has no external host-command requirement. It requires OAS `>=0.19.0`, whose frozen package-runtime boundary provides schema-v1 `oas spawn ... --json` envelopes and capability-defined agents.

The harvest command invokes only that structured CLI boundary. It never discovers the kernel root or imports private kernel files. [`KERNEL-API-NEEDS.md`](KERNEL-API-NEEDS.md) records the now-satisfied historical inventory.

## Acquire and activate

Acquisition does not activate the capability. After a release tag and catalog entry exist, install, trust the executable surface, and activate it deliberately:

```bash
oas install oas.okf --dir /path/to/scope
oas trust oas.okf --dir /path/to/scope
oas use oas.okf --global --dir /path/to/scope
oas doctor /path/to/scope --soul <soul-name>
```

A pinned Git source may be used before catalog publication:

```bash
oas install git:https://github.com/OAS-Framework/oas-okf.git@v1.4.0 --dir /path/to/scope
```

Do not publish that tag yet: the released-0.19.0 consumer probe gate remains open.

## Use

Spawned instances receive the selected OKF skills and instructions automatically. They keep `STATE.md` current, append milestones to `log.md`, capture learned concepts in `notes/`, and after committing run:

```bash
oas okf harvest
```

The command skips safely when there are no pending notes or when a harvester for the source instance is already running. Otherwise it resolves the packaged `memory-harvest` capability agent and spawns through `oas spawn --json`; task instructions use mode-0600 temporary files removed on every outcome.

## Development

```bash
npm test
```

This validates `oas-package.json` and the enumerated `oas.json`, checks package-relative resource containment, and exercises the standalone lifecycle behavior. The full acquire → lock → trust → activate → spawn probe is documented in [`SCHEMA-STATUS.md`](SCHEMA-STATUS.md) and remains pending released OAS 0.19.0 consumer fixtures.

Release and checksum conventions are defined by the official-package staging convention in the source staging branch.
