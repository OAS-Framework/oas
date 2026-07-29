---
type: Lesson
title: Compose atomic engine operations with an outer command rollback journal
description: A multi-step CLI command can preserve subsystem boundaries by journaling surrounding state instead of exposing the engine's internal transaction as a public callback or handle.
tags: [transactions, cli, packages, coordination]
timestamp: 2026-07-29
---

# Compose atomic engine operations with an outer command rollback journal

An engine operation can be atomic by itself while a CLI command that calls it and then writes config/adoption files is not. One option is to expose a two-phase engine handle or commit callback, but that leaks transaction lifetime into policy consumers and complicates a previously clean seam.

A simpler split is:

- the engine atomically owns capability artifacts, lock writes, and required Git-ignore maintenance;
- the CLI snapshots the exact outer-command state before calling it, including config/base metadata, lock bytes, affected installed artifacts, and ignore bytes/absence;
- if a later CLI step fails, the CLI restores its outer journal byte-for-byte; and
- each side tests its own rollback plus an integration blocker where pre-existing same-name state is touched.

This keeps the engine API ordinary and lets init/adoption define a larger transaction without inventing a public transaction protocol.

Related: [Node recursive cpSync can bypass JavaScript cleanup on unreadable trees](/lessons/node-recursive-cpsync-can-bypass-javascript-cleanup.md), [Config synchronization must preserve untouched local bytes](/lessons/config-sync-must-preserve-untouched-bytes.md).
