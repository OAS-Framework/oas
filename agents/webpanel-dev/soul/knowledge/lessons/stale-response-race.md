---
type: Lesson
title: Stale-response race in the chat poller — request generations, selection pinning, cache isolation
description: With multiple busy sessions, out-of-order async poll responses made the chat pane flicker between different instances' transcripts; the fix is a request-generation counter (chatReq), re-checking the selected instance on arrival, and clearing caches plus in-flight fetches on every instance switch.
tags: [oas-web, race-condition, chatReq, polling, gotcha]
timestamp: 2026-07-21
---

# The bug

The chat view polls every 1.5s (plus a 400ms fast loop after sends). Each
poll is an async fetch, and responses return **out of order** — a slow
response for instance A could land after switching to instance B, or after a
newer poll had already painted. Whichever response arrived last painted the
pane; with several busy sessions the view visibly ping-ponged between
transcripts.

# The fix — three guards in panel.html

1. **Request generations**: a module-level counter `chatReq`; every fetch
   takes a ticket (`const myReq = ++chatReq;`) and on arrival discards
   itself if `myReq !== chatReq`. A stale response can never paint.
2. **Selection pinning**: the selected instance name is captured at fetch
   start (`forSel`) and re-checked on arrival (`forSel !== sel` → discard).
3. **Cache isolation on switch**: selecting an instance clears the previous
   transcript cache (`lastChatSig = ""`), bumps `chatReq` to invalidate
   in-flight fetches, and clears `pendingSends` — so the optimistic-send
   path cannot re-render another session's content. The change-detection
   signature is also namespaced by instance.

# General lesson

Any polled multi-target view in the panel (chat, session, jira) needs all
three guards, not just one — generations alone don't cover optimistic local
state, and selection pinning alone doesn't cover two in-flight polls for the
same instance. Verification: flip rapidly between running sessions; each
pane must stay locked to its own transcript with zero cross-bleed.
