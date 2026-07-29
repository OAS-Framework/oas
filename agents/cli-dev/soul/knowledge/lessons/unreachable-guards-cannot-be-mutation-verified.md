---
type: Lesson
title: A guard no mutant can kill is telling you an invariant already holds
description: A defensive check that survives its own removal mutant is either untestable dead weight or a sign the real guarantee lives elsewhere — find which, then either delete it or pin the ordering that makes it redundant.
tags: [testing, mutation-testing, fail-closed, engine]
timestamp: 2026-07-29
---

While hardening `approveCapability` I added two checks: verify the artifact's
provenance, and — before dereferencing it — refuse when the capability's
provider package row is missing from the lock.

The provenance check died to its removal mutant immediately. The
missing-provider check did **not**: with it removed, the case still failed
closed with the same `invalid-lock` code.

The reason is worth keeping. `readPackageLocks` strict-parses every capability
entry and *already* refuses a row whose provider is not in the same packages
map, so `approveCapability` can never observe an absent provider. My guard was
unreachable. Adding a message assertion would have "killed" the mutant while
testing nothing but my own wording.

The right move in a security fix is to delete the unreachable branch and pin the
**ordering that makes it unnecessary**: the regression now asserts that a lock
with the provider row deleted is refused by the strict parse, with that parser's
own message, before any provenance work happens. That is what licenses the
unguarded dereference one line later — and if someone weakens the strict parse,
this case fails rather than silently relying on a guard nobody kept.

The general rule: when a mutant survives, do not reach for a stronger assertion
first. Ask why the behaviour did not change. Usually the answer is that some
other layer already guarantees it — in which case the guard should go and the
guarantee should be the thing under test.
