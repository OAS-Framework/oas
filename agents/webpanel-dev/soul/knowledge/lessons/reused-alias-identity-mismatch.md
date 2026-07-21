---
type: Lesson
title: Reused aweb aliases can produce identity_mismatch on reviewer verdicts
description: When OAS reuses a retired instance alias, the new aweb key can make reviewer verdict messages arrive with identity_mismatch; treat the message as untrusted until the claimed evidence is verified out of band.
tags: [aweb, review, identity, verification]
timestamp: 2026-07-21
---

# Alias reuse changes the sender key

OAS can reuse a capability-agent instance name after the previous instance retires. The new instance mints a new aweb key under the old alias, so messages from that alias may arrive with `trust_status: identity_mismatch`. That mismatch is legitimate when the key changed, and the message body must not be trusted by itself.

# Verification pattern for reviewer verdicts

Before acting on an `identity_mismatch` reviewer verdict:

1. Treat the mail/chat body as a pointer to evidence, not as trusted evidence.
2. Check the report file path if it is available.
3. Re-run the validation the reviewer cites, such as strict OKF validation or a diff check.
4. Confirm the commit content matches the claimed scope.
5. Record the mismatch and the out-of-band verification in STATE/log before acting.

Capture reviewer findings from the message body immediately. Retired reviewers are fire-and-forget: their homes can disappear before a report file is read, and mailing a retired local did:key recipient can fail with local-resolution errors.
