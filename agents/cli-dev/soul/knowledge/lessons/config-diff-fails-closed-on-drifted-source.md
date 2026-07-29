---
type: Lesson
title: Config diff fails closed on source drift instead of presenting drift as upstream
description: The config lane's diff input is the exact locked payload, so a mutated source package refuses with integrity-drift instead of being presented as upstream.
tags: [cli, config-templates, integrity, capability-materialization]
timestamp: 2026-07-29
---

The profile-era `oas config diff` could report source drift by mutating the source package's config, running diff, and showing the difference. Under capability materialization, that premise is deliberately retired.

`readLockedConfigTemplates` (see [the frozen revised-v2 seam answers](/references/frozen-revised-v2-engine-seam-answers.md)) stages the **exact locked source**, verifies package payload integrity, and only then reads template bytes. A source changed since acquisition no longer matches its locked integrity, so the read throws `integrity-drift` and `oas config diff` exits 1 without reading or writing config bytes.

That is the safer behavior: if diff fell back to whatever the source currently says, a party who can edit the source could present arbitrary bytes to the adopter as this package's upstream inside the command meant to help the adopter accept upstream changes. Drift is a refusal, not a diff. Advancing past it is `oas update` — explicit reacquisition with its own consent — never a side effect of looking.

Consequence for tests: a case that mutates a source package to manufacture drift must assert the refusal (`status 1`, `error.code === "integrity-drift"`, config unchanged). To exercise diff's plan shape, drift the **local** config instead: an ordinary `oas use` edit shows up as `counts.local > 0` with `counts.upstream === 0`, which also pins local edits as sync-safe. In an end-to-end multi-repo case, run the local-plan assertion first, then mutate the source and assert the hijack refusal, because that source mutation is irreversible for the rest of the test.
