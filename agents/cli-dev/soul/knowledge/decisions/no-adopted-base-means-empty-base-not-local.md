---
type: Decision
title: With no adopted base the merge base is empty, never the local file
description: Using the local config as the three-way base makes handcrafted lines look upstream-only, so a first adopt must use an empty base and surface overlap as conflicts.
tags: [config-templates, oas-cli, three-way-merge, data-loss]
timestamp: 2026-07-29
---

# The bug in one line

```js
const baseText = adopted ? adopted.baseText : localText;   // WRONG
```

In a three-way merge, `base === local` means there are no local changes. Every
difference between base and template is therefore classified as upstream and
applied without conflict. A first `oas config adopt` over a handcrafted
`oas-config.yaml` replaced the whole file without consent or a loss preview; the
backup was the only recovery path.

The fixed rule is:

```js
const baseText = adopted ? adopted.baseText : "";
```

With an empty base, every existing local byte is genuine local work. If the
package template also wants that region, the merge reports a conflict, and
noninteractive runs already require an explicit `--accept <id>=local|package`.

# What the surrounding commands do

- `oas config diff` requires an adopted base and refuses with
  `E_NO_ADOPTED_BASE` when none exists, so it is not the preview for a first
  adopt.
- `oas config sync --reset` also presupposes an adopted base and refuses the
  same way. It is not the destructive path for a never-adopted scope.
- The first-adopt refusal must therefore carry the guided preview. The
  `E_SYNC_AMBIGUOUS` message enumerates conflict ids; before an adopted base
  exists, that is the only place the ids exist.
- Taking the package side wholesale stays explicit and recoverable: pass
  `oas config adopt <pkg> --accept <id>=package` for each region, and the command
  still writes the `.bak`.

# Why existing tests missed it

The existing adoption tests started from `oas init --package`, which writes the
template into an empty scope and records the base in the same run. The dangerous
state is a real config never adopted from any package — the normal upgrade path
when installing a package into a repository already configured by hand.

See also [byte-preserving three-way config merge](/lessons/byte-preserving-three-way-config-merge.md), [the config-template transaction map](/playbooks/config-template-cli-transaction-map.md), and [the adopted-write symlink decision](/decisions/adopted-writes-never-follow-a-symlink.md).
