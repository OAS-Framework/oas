---
type: Lesson
title: A green repository OKF command can still carry producer warnings
description: Maintainer review must inspect OKF validator output, not only its exit status, because the repository aggregate command can exit zero while strict validation reports unreachable concepts.
tags: [okf, pr-review, validation]
timestamp: 2026-07-26
---

During PR #38 review, `npm run validate:okf` exited zero and ended with
“Strict OKF validation passed,” while one bundle section reported producer
warnings for unreachable new concepts. A maintainer gate that records only
command success would miss malformed navigation in committed knowledge.

For PRs that touch knowledge bundles, inspect the per-bundle counts and output,
and require zero producer warnings for changed bundles even when the aggregate
command is green. This complements the semantic consistency check in
[PR reviews need semantic knowledge consistency checks after branch-union harvests](/lessons/pr-review-knowledge-consistency-after-branch-union.md): strict validation and human review both need to see the details, not just a green summary.
