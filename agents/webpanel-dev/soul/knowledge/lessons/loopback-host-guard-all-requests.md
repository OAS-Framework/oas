---
type: Lesson
title: Loopback Host guard must cover GET file-serving APIs too
description: The oas-web loopback Host check must run before every request, not just POSTs, because GET file-serving APIs such as /api/file and /api/diff can leak workspace files to a DNS-rebinding page.
tags: [oas-web, security, dns-rebinding, host-header]
timestamp: 2026-07-22
---

# The trap

The panel's original DNS-rebinding guard treated GETs as harmless roster or pane-capture reads, so the loopback `Host`/`Origin` guard ran only on POSTs.

That changed once GET file-serving APIs such as `/api/file` and `/api/diff` existed. A hostile page can DNS-rebind its own hostname to `127.0.0.1` and read workspace files over GET; same-origin policy does not help because the attacker owns that origin.

# Rule

Validate `Host` as loopback for **every** request at the top of the handler. Keep the additional `Origin` check for POSTs.

The regression shape is raw GET requests with `Host: attacker.example` against `/api/file`, `/api/diff`, and `/api/panel`; each must fail the loopback Host guard.

# Related concepts

- [oas-web architecture](/architecture/oas-web-architecture.md)
- [Raw key passthrough and the loopback Host/Origin guards](/architecture/raw-key-passthrough-and-host-guard.md)
- [Guard file-serving paths by realpathing requests and roots](/lessons/file-endpoint-realpath-guard.md)
