---
type: Lesson
title: setup-node npm caching needs an explicit nested lock path
description: GitHub Actions setup-node fails before installation when npm caching is enabled but the repository's only lockfile is nested and cache-dependency-path is absent.
tags:
  - ci
  - github-actions
  - npm
  - packages
timestamp: 2026-07-26
---

# setup-node npm caching needs an explicit nested lock path

A standalone package kept its dependency-owning `package-lock.json` inside an inner capability directory so `node_modules` would materialize beside the capability manifest. Its workflow configured `actions/setup-node@v4` with `cache: npm` but no cache dependency path.

`setup-node` searches for dependency lockfiles at the repository root by default. With only a nested lock, the action fails with "Dependencies lock file is not found" before the later prefixed `npm ci` command can run.

When the lock is nested, configure both:

```yaml
with:
  node-version: 22
  cache: npm
  cache-dependency-path: capabilities/<capability>/package-lock.json
```

The cache path must point to the same lock consumed by the prefixed materialization command. A successful local `npm ci --prefix ...` does not exercise setup-node's earlier cache lookup, so review or workflow-level validation must cover this integration boundary.
