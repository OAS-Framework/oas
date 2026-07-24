---
type: Lesson
title: Review loops need a scope ratchet
description: Once review findings shift from product or security defects to test-strength issues, fix minimally and scope further review to product correctness and security instead of extending a test-of-test spiral.
tags: [review, testing, process, judgment]
timestamp: 2026-07-24
---

# Review loops need a scope ratchet

On the `desktop-dist` slice, five post-commit review rounds began with real,
exploitable privileged-surface defects: harvest cwd steering through
`instance.json`, symlinked `local-agents` widening `/api/file`, guard
re-resolution TOCTOU, and an argv placeholder collision. Those fixes and their
mutation-tested regressions were worth the review rounds.

By rounds four and five, the findings had shifted category: a test did not fail
when the fix was reverted, then a fake CLI fixture did not actually hang. The
operator flagged the loop as overboard because it had become testing tests.

# Scope ratchet

Security-boundary fixes deserve a reversion-fails-test check. The mutation gaps
were real, and three regressions stayed green under reversion, so do this before
requesting review rather than spending extra review rounds to discover it.

When a review round contains only test-strength findings, treat that as the
loop's natural end: fix the finding minimally, scope re-review explicitly to
product correctness and security, and do not add speculative assertions beyond
what closes the finding.

Wall-time matters. An 8-second-timeout integration assertion is a real CI cost;
prefer asserting the mechanism, such as the fixture staying alive and the
candidate being rejected, over re-measuring production constants.

Consumer-parity evidence, such as running the packaged artifact and recording
its behavior, is a different and often better confidence source than adding more
unit tests near the end of a slice.

# Related concepts

- [Security regressions must exercise behavior, not source strings](/lessons/behavioral-security-regressions.md)
- [Regression tests must exercise the layer that had the bug](/lessons/regression-tests-bug-layer.md)
- [Fake CLI fixtures need absolute-path launchers under hostile PATH](/lessons/fake-cli-fixtures-hostile-path.md)
