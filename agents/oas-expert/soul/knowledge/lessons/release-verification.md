---
type: Lesson
title: Deployment probes catch what static checks miss
description: After every release, run a real probe on the deployed artifacts (create→spawn→hook→retire); a grep-level "verification" once passed a SyntaxError that broke the whole knowledge integration.
tags: [releases, verification, gotcha]
timestamp: 2026-07-10
---

Shipping v0.6.0, a task-template string in the okf integration embedded
unescaped backticks inside a JS template literal. The file no longer parsed —
which broke EVERY entry point of that script (spawn hooks, harvest), not just
the changed line. Pre-publish "verification" had been a grep for the new text
plus running a different code path; both passed.

# The lesson

1. **A parse error has file-wide blast radius.** One bad character in a
   shared script takes down all its hooks/commands. Verify the artifact, not
   the diff.
2. **Syntax-check everything shipped, mechanically.** `node --check` on every
   `.mjs` in the tarball is nearly free; it now runs in the release CI before
   publish. Greps and "it printed the right JSON on path X" are not parse
   checks.
3. **Probe the deployment, not the checkout.** After `npm i -g` of a release:
   fresh temp workspace → `oas init` → `create` → `spawn --no-launch` (does
   the knowledge hook scaffold memory?) → integration command (`oas okf
   harvest` with a pending note) → `retire`. Five commands, catches whole
   classes of packaging/regression bugs that unit-level checks miss.
4. **Escaping in generated text**: strings that themselves contain code-ish
   syntax (backticked commands in briefings) are a recurring hazard inside
   template literals — escape or build them from concatenation.
