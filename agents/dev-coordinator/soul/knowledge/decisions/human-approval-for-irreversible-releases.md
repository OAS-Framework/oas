---
type: Decision
title: Human approval remains a separate gate for irreversible releases
description: Technical review can establish readiness but cannot replace a required human authorization for irreversible tagging or publication.
tags:
  - releases
  - approvals
  - coordination
  - governance
---

# Human approval remains a separate gate for irreversible releases

When an owner mandate requires human approval for an externally consumable tag or publication, aligned developer, reviewer, architecture, and maintainer verdicts establish technical readiness but do not silently satisfy that release authority.

Before the irreversible sequence begins:

1. Trace authorization to a human instruction whose accepted scope clearly includes the tag or publication. No magic phrase is required, but ambiguous planning language is insufficient.
2. Record that provenance in the release handoff.
3. Keep author and terminal-actor constraints separate; technical approval does not override a developer rule against self-merge.

If authorization becomes uncertain, stop before the first irreversible action and preserve refs, instances, and notes while obtaining a ruling. A sent HOLD message is not evidence that an already-running terminal actor stopped: require explicit acknowledgement and ask whether execution began before delivery. If merge, tag, or publication already completed, preserve the immutable outcome, report the authorization incident, and do not attempt a destructive rollback.
