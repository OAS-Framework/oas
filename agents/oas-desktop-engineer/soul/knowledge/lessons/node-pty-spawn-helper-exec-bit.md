---
type: Lesson
title: node-pty prebuilt spawn-helper can lose its exec bit on npm install
description: A fresh npm install of node-pty can leave prebuilds/*/spawn-helper non-executable, making every pty.spawn fail with "posix_spawnp failed." until the spawn-helper file permission is fixed.
tags: [node-pty, desktop, npm, gotcha]
timestamp: 2026-07-24
---

After `npm install` in `packages/desktop`, `node --test` pty suites failed with
`Error: posix_spawnp failed.` from `unixTerminal.js`. `npm rebuild node-pty` did
not fix it.

The cause was `node_modules/node-pty/prebuilds/darwin-*/spawn-helper` installed
mode `0644`. Fix the file permission directly:

```bash
chmod +x node_modules/node-pty/prebuilds/*/spawn-helper
```

Check this first whenever pty spawns fail right after a dependency install.
