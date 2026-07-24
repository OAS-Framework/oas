---
type: Concept
title: Desktop deployment reader and mutation degradation after kernel bridge removal
description: Removing the desktop server's direct lib/core.mjs bridge split app-owned tolerant read discovery in deployment.mjs from mutation requests, which validate first and then degrade with a stable cli-unavailable 503 until the CLI adapter lands.
tags: [desktop, backend, deployment, packaging, cli-boundary]
timestamp: 2026-07-24
---

# Boundary

The packaged desktop backend must not depend on a framework checkout through
`FRAMEWORK_ROOT`/`lib/core.mjs`. Removing that bridge established that the
server's durable in-process surface is read-only deployment discovery, owned by
`packages/desktop/server/deployment.mjs`.

The app-owned reader covers the read seams the desktop server needs: resolving
`oas-config` into team context, computing team agent roots, ensuring a requested
root is one of the watched roots, listing local and capability agents, finding
local/capability agent definitions, parsing frontmatter, expanding capability
skill manifest paths, and listing instances. It is not a general kernel port.

# Reader behavior

The reader deliberately differs from the kernel where a packaged app must be
more tolerant or more self-contained:

- root discovery is read-only; `findAgentsRoot` never scaffolds missing state;
- malformed `oas-config`, `soul.yaml`, or capability manifests degrade to "not
  visible" because the desktop app observes deployments it does not own;
- marketplace manifest handling does not use hoisted framework-resource
  resolution, because a packaged app has no framework checkout;
- capability manifest paths still keep the realpath containment guard so
  manifest entries cannot escape their package root.

# Mutation boundary

`spawnInstance` was the desktop server's mutation seam and did not move into the
reader. `POST /api/spawn` / `spawnAgent` keeps the validation half in process —
the `agentsRoot` allowlist and agent resolution still fail with meaningful
client errors — but, until the compatible CLI adapter lands, a request that
reaches the mutation boundary throws a stable `{ code: "cli-unavailable" }` and
maps to HTTP 503.

Keep this validation-vs-degradation distinction testable before the CLI exists:
unknown roots or agents should remain validation failures, while unavailable OAS
mutation capability is a stable service-unavailable degradation.

# Verification and regression traps

`test/desktop-deployment.test.mjs` proves reader parity against `lib/core.mjs` on
the live repo for team scope, roots, souls, capability agents, and instance
names. That comparison is valid while `packages/desktop` still lives in-tree;
when the desktop package moves out, freeze the comparison into fixtures instead.

Absence regressions that grep shipped sources for `lib/core.mjs` or
`FRAMEWORK_ROOT` also match explanatory comments. When a comment trips the
absence test, reword the comment (for example, "kernel module" or
"framework-root override") rather than weakening the test.

# Related

- [desktop backend architecture](/architecture/desktop-backend-architecture.md)
  describes the server surface that consumes this reader.
- [spawn endpoint](/architecture/spawn-endpoint.md) records the request contract
  and the CLI-unavailable degradation.
- [agent brain endpoint](/architecture/agent-brain-endpoint-and-view.md) uses the
  reader's agent lookup, manifest expansion, and frontmatter parsing seams.
