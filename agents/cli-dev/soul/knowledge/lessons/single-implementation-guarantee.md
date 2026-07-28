---
type: Lesson
title: A guarantee copied into a second code path is a guarantee only on the first
description: Spawn has two rollback paths; six review rounds hardened the required-hook one into a quarantine while the post-launch one still deleted the home and its credential unconditionally.
tags: [kernel, rollback, invariants, duplication, fail-closed]
timestamp: 2026-07-27
---

# Lesson

`spawnInstance` can roll back in two places: a required capability hook fails before the
instance exists, or something fails AFTER it is already launched (re-pointing a parent
anchor). Six review rounds turned the first into a careful quarantine — retain the home,
record what is outstanding, let `oas retire` retry, never delete state that cleanup still
needs. The second kept its original shape: run compensation, append any failures to a prose
list, then `rmSync(home)` unconditionally.

So the terminal review reproduced, on a fully "fixed" branch, exactly the defect the branch
was about: the retire hook exited nonzero, that failure was RECORDED, and the home — with
the only credential able to undo the surviving remote state — was deleted anyway.

**When you establish a guarantee, find every path that owes it before declaring it kept.**
The tell is duplication: the two rollbacks shared the same probe helper, the same
`incomplete` accumulator, the same intent — and diverged precisely where it mattered. I read
the second path several times during those rounds without seeing it, because I was reading
for the bug I already knew about rather than asking which code has this obligation.

The fix is one implementation both call (`quarantineInstanceHome`), not two that agree today.
Two copies that agree are just a divergence that has not happened yet.

# Half a guarantee is the producer without the consumer

Extracting one quarantine producer for both rollback paths still left the guarantee broken,
because the CONSUMER never recognised the new case: `oas retire` parsed the marker only when
`instance.json` was absent. The post-launch rollback retains a home that already has one — it
is written before the anchor step — so retire ignored the quarantine, took the ordinary path
where hook failures do not retain, and deleted the credential anyway. Retained at rollback,
destroyed on the first failing retry.

**A guarantee spans producer AND consumer; fixing one is not fixing it.** The question to ask
after any "now we retain X" change is: who reads X, and does every reader recognise every way
it can appear?

My own regression passed because it made the retry SUCCEED — it flipped the hook's allow-flag
before retiring. The failing-retry case, with `instance.json` present, is exactly what the
quarantine exists for and exactly what went untested. Test the path that CONSUMES the fix, in
the state where the fix matters, which is the state where things are still broken.

A related trap in the same fix: the producer passed the compensation result as the cleanup
metadata, so a failed retire's `{retired:false}` overwrote the spawn's `{alias}` — discarding
the handle the retry needs to delete the remote identity. Diagnostics about a failure are not
a substitute for the state that failure left behind; keep them in separate fields.

# Scope the retention to what compensation OWNS

The first version quarantined on ANY unresolved item, which promptly failed an existing test:
a leftover temp file beside the ANCHOR is litter, not the child's external state, and
retaining a home for it converts an ordinary failure into a `--force` cleanup. The rule that
survives is: retain when compensation itself did not finish — a retire hook that failed, Git
the rollback could not undo, a window still running. Report the rest and move on.

**Fail closed on the state you are responsible for, not on every imperfection in sight.**
An over-broad safety rule gets weakened later by someone who is tired of it; a precise one
survives.
