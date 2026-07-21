---
type: Reference
title: pi session jsonl provider-error shape
description: How provider/session errors appear in pi's session logs for session-tail error detection.
timestamp: 2026-07-21T15:00:00Z
---

# pi session jsonl provider-error shape

In pi session logs (`~/.pi/agent/sessions/-<home with / replaced by ->--/*.jsonl`), a provider failure appears as a `type:"message"` entry whose assistant message has `stopReason:"error"` and an `errorMessage` string, usually with empty content and zero usage.

For session-tail error detection, treat it as a trailing error when the last message entry has `stopReason:"error"` and there is no later normal message.
