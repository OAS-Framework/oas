---
type: Decision
title: Instances symlink the soul rather than copy it
description: Instance homes link ./soul to the shared soul directory so all instances see one source of truth and harvest write-back propagates immediately.
tags: [architecture, memory, spawn, decision]
timestamp: 2026-07-10
---

Human asked whether instance creation should copy knowledge into the instance
instead of symlinking the soul. Answer: no — the symlink is deliberate.

- **One source of truth**: `soul/knowledge` is the durable versioned identity;
  a copy forks the moment either side changes.
- **Harvest write-back**: notes → harvester → soul bundle commit. With
  per-instance copies, promoted knowledge would never reach other or later
  instances without an invented sync mechanism.
- **Long-lived instances stay current** through the link when siblings'
  harvests land.
- **Write contention is handled by discipline**: instances do not edit
  `soul/knowledge` directly; they write `./notes/`, and the serialized
  harvester promotes.
- **Episodic divergence lives where it belongs**: `STATE.md`, `log.md`, and
  `notes/` in the instance home.

Open variant, with no use case yet: a snapshot or pinned-knowledge work mode
for isolation, at the cost of losing the live harvest loop.

This decision existed in code (`core.mjs` `symlinkSync`) but had not been
recorded in the knowledge base. It explains the soul-memory mechanics in
[Memory design](/architecture/memory-design.md).
