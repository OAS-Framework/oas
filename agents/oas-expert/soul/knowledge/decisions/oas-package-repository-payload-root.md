---
type: Decision
title: OAS package repositories select an explicit payload root
description: A Git repository may contain arbitrary development content while OAS copies, hashes, locks, and installs only a configured package subtree whose official convention is oas-package/.
tags: [packages, distribution, integrity, git, repository-layout]
timestamp: 2026-07-28
---

# OAS package repositories select an explicit payload root

The founder superseded the proposed special-case exclusion for top-level `agents/`. A package source now selects one contained payload root inside its Git checkout. The recommended and official directory is `oas-package/`; custom paths and an explicit repository-root package remain supported.

The selected directory contains `oas-package.json` and is the integrity/materialization boundary. OAS fetches one exact commit, resolves the configured path inside that checkout, and copies, hashes, locks, and installs only that subtree. Repository-level owner souls, CI, docs, and other development files are not distributed and cannot churn package integrity. Multiple catalog entries may select different package roots from one repository.

Catalog and Git source provenance must carry the package path explicitly, and lock v2 records it alongside the exact commit and integrity. Bare install restores that exact tuple; catalog or branch movement does not update it. `oas update <package-id>` remains the explicit operation that resolves a newer source and rewrites the lock.

This follows the locally verified Claude Code marketplace pattern: marketplace entries select local plugin directories or structured Git subdirectories rather than treating an entire marketplace repository as one installed plugin. OAS keeps its stricter exact-lock, containment, trust, and independently targetable capability contracts.
