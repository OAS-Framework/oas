---
type: Lesson
title: identity_mismatch with green doctors is a recipient-cache defect
description: When aweb mail arrives as trust_status=identity_mismatch but read-only doctors pass on both sender and recipient, treat it as a recipient-side cached-key or verification defect rather than evidence of compromise.
tags: [aweb, trust, identity, diagnostics, security]
timestamp: 2026-07-25
---

# Lesson

During macos-correct-installers coordination, every mail from `dev-coordinator-1` arrived with `trust_status=identity_mismatch` and `verified=false`, yet both sides' `aw doctor --online --verbose` passed all authoritative checks: certificate auth, team read, server row matching local membership, signing-key/certificate match, signature dry-runs, and E2E assertion.

The correct classification, once both doctors are green, is recipient-cache or verification defect. Continue only benign coordination on the existing thread, where content is supported by thread continuity; require independent chat confirmation for sensitive instructions such as version cuts, authority changes, or protected refs.

Verification is about authorship, not correctness. A persistent mismatch with clean local state is an infrastructure signal, not automatically an attack, and should not trigger ad hoc key rotation or certificate replacement.
