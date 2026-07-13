---
type: Lesson
title: OKF injection was write-biased — read-side consultation must be explicit
description: The okf injection taught capture/harvest thoroughly but consultation of soul/knowledge only in one passing line; agents need an explicit consult-index-first instruction.
tags: [okf, injections, knowledge, design]
timestamp: 2026-07-10
---

Human asked whether agents actually know to *use* their soul's knowledge.
Audit of `integrations/oas-okf/injects/okf.md` showed the injection was
heavily write-biased: session protocol (`STATE.md`/`log.md`), note capture,
and harvest were explicit, but reading `soul/knowledge/` was only a single
descriptive sentence. Souls like oas-expert compensated in their own
`AGENTS.md` operating loop, but that is per-soul discipline, not a framework
guarantee.

Fix in v0.6.2: add a "Consult before you work" paragraph to the injection —
open `./soul/knowledge/index.md` at session start and before non-trivial
tasks, follow only relevant links, and treat prior decisions, lessons, and
playbooks as binding context. Re-deriving what the soul already knows is a
bug.

General lesson: memory contracts must be symmetric. Teaching agents to write
memory without equally explicit read-side instructions produces knowledge
that accumulates but is never consulted. This complements the selective-read
contract in [Memory design](/architecture/memory-design.md).
