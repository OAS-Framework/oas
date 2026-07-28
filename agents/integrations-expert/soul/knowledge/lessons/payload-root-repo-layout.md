---
type: Lesson
title: OAS payload-root repository layout (oas-package/) for official packages
description: How to split an official OAS package repo into a distributed oas-package/ payload root and repo-only dev tooling under the merged PR57 configurable-path kernel contract.
tags: [packaging, payload-root, oas-package, distribution, integration-craft]
timestamp: 2026-07-28
---

# OAS payload-root repository layout

Under the merged PR57 kernel contract, a public OAS package repository separates
its **distributed payload** from **repo-only tooling**. The kernel constant
`DEFAULT_PACKAGE_PATH = "oas-package"` (lib/core.mjs) makes `oas-package/` the
default contained package root selected inside a Git/catalog source; local
`path:` sources point at the EXACT `oas-package/` directory (which must contain
`oas-package.json`).

## What goes where

Inside `oas-package/` (the installed bytes — packageIntegrity hashes this subtree,
excluding .git/node_modules/oas-lock.json):
- `oas-package.json` (distribution manifest — marks the package root)
- the enumerated capability dir (`capabilities/<name>/`), or for a flat
  single-capability package (`"capabilities": ["."]`) the `oas.json` + `skills/`
  sit directly in `oas-package/`
- declared config profiles (`configs/<profile>/oas-config.yaml`)
- the distribution-required MIT `LICENSE`

Repo root, OUTSIDE the payload (never installed): `schemas/` (dev/CI copies of the
canonical package-engine schemas), `scripts/` (validate-manifests, sync tools,
catalog-selectors), `test/`, `.github/`, `README.md`, `SCHEMA-STATUS.md`, dev
`package.json`, and later `agents/<pkg>-expert/soul` (owner soul — NEVER inside
oas-package/).

## Path-resolution rules that bite

- Repo tooling (`validate-manifests.mjs`) resolves `repoRoot = script/..` then
  `payloadRoot = repoRoot/oas-package`; manifests + capability/config resources
  validate against the PAYLOAD root and the symlink-containment boundary is the
  payload root, but schemas are read from `repoRoot/schemas`. It is fine for
  repo-only tooling to know its payload dir name; runtime package CONTENT must
  never hardcode it (resource paths are payload-relative).
- Standalone tests: `REPO = test/..`, `ROOT = REPO/oas-package`. Read payload
  from ROOT, read schemas/scripts/test-fixtures from REPO. Negative manifest
  fixtures must mirror the `oas-package/` layout (write the synthetic manifest to
  `fixture/oas-package/oas-package.json`, schemas+scripts at fixture root).
- Co-located local dependencies point at sibling PAYLOAD roots. From
  `packaging/oas-dev/oas-package/`, the sibling okf payload is
  `../../oas-okf/oas-package` (up out of oas-package/, up out of oas-dev/, into
  the sibling repo's oas-package/). A deterministic catalog-selector script reads
  each sibling's own release version for the publication swap.

## Consumer-probe evidence (real engine, no shim)

`oas install path:<repo>/oas-package` and `oas install file://<repo>[#oas-package]`
both acquire; installed artifact = payload only; v2 lock records `path="."` for a
local exact dir and `path="oas-package"` for git/default, each with sha256
integrity. `file://<repo>#.` (repo root) fails `invalid-package-manifest` because
there is no oas-package.json at the root — proving the repo root is NOT a package
root. Packages above the running kernel floor fail-closed `incompatible-oas`
(release-pending), never silently.
