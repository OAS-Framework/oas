---
type: Lesson
title: Electron renderer native ESM dependencies need importmaps, CSP hashes, and real browser ESM
description: Bare imports in the unbundled Electron renderer need an importmap, the importmap's inline script needs a CSP hash, and highlight.js must be bundled from its dual-package shim into browser-loadable ESM.
tags: [desktop, electron, esm, importmap, csp, highlight.js]
timestamp: 2026-07-22
---

When desktop shell renderer views use bare imports such as `marked`,
`dompurify`, or `highlight.js` without bundling app code, keep the dependency
loading path explicit and browser-compatible. Pair this with the [Desktop shell
view-host contract and layout](/playbooks/desktop-shell-layout.md).

- Add an importmap in `index.html` that maps bare specifiers to files the
  renderer can load. `marked` (`lib/marked.esm.js`) and `dompurify`
  (`dist/purify.es.mjs`) ship real browser ESM, so mapping is enough for them.
- An inline `<script type="importmap">` is blocked by `default-src 'self'`.
  Add its `sha256` to `script-src`, and recompute the hash whenever the
  importmap block changes because whitespace counts.
- `highlight.js` is a dual-package trap: its `es/*.js` files import
  `../lib/common.js`, which is CommonJS that Node's ESM loader can bridge but a
  browser cannot. Bundle `es/common.js` with esbuild into a flat real-ESM file
  such as `renderer/vendor/highlight.mjs` from the postinstall
  `build-vendor.mjs` step; keep the generated vendor dir gitignored.

Symptom chain to recognize: first `Failed to resolve module specifier` when the
importmap is missing, then `does not provide an export named 'default'` when the
browser reaches the CommonJS behind the highlight.js shim.
