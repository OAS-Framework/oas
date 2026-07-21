---
type: Playbook
title: Testing the pane — pure exported functions and fake snapshots
description: The pane is verified without a TTY or tmux by unit-testing exported pure functions (parseOsc11, buildConstellation, parsers, readMarkdownSection, relativeAge) and by calling renderFrame directly with a hand-built snapshot at multiple terminal sizes.
tags: [control-pane, testing, verification]
timestamp: 2026-07-20
---

The testability strategy is structural: every non-trivial computation is an
**exported pure function**, so `test/control-pane-model.test.mjs` covers the
pane end-to-end without spawning a terminal, tmux, or git.

What to test and how:

- **Parsers** (model.mjs): `parseTmuxWindows`, `parseGitStatus` (branch,
  ahead/behind, dirty count), `parseGitDiffStat`, `readMarkdownSection`
  (including placeholder `_..._` lines being dropped and nested `## Task`
  headings matching), `relativeAge` with an injected `now`.
- **`buildConstellation`**: nesting, orphan-as-root, and the cycle-safety
  invariant (no instance may disappear).
- **`renderFrame`** with a **fake snapshot** — a hand-built object with one
  instance, `rows`, counts, `tmuxAvailable: true` — rendered at several
  `[width, height]` pairs. Assert: output has exactly `height` lines, contains
  the instance name, at wide sizes contains header facts and the branch chip,
  preserves SGR from the preview while stripping `\x1b[2J`, and `rowMap`
  points at card 0. This works headless because `applyTheme(false)` runs at
  module load.
- **`parseOsc11`** shapes: 16-bit xterm reply, ST terminator, 8-bit reply,
  garbage → `undefined`.

Run and full-repo verification:

```bash
node --test test/control-pane-model.test.mjs   # or the repo's full `node --test`
```

When changing the pane, extend these tests in kind — a new render feature gets
a `renderFrame` assertion; a new parser gets direct input/output cases. What
remains untested by design is the interactive loop (`startControlPane`), kept
thin: input decoding lives in `parseInput`, all layout in `renderFrame`.
