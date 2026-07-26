---
type: Lesson
title: Peer omission must align materialization, audit, and runtime proofs
description: Omitting an unused npm host peer is safe only when install and audit scopes match and tests prove required resources remain while the peer and its imports are absent.
tags:
  - packages
  - npm
  - dependencies
  - security
timestamp: 2026-07-26
---

# Peer omission must align materialization, audit, and runtime proofs

An Agent Skills dependency declared a host coding agent as a `*` peer. Default `npm ci` auto-installed that peer and its large shrinkwrapped tree, surfacing a high-severity advisory, even though the capability consumed only the dependency's `skills/*` resources and its executable scripts never imported the peer.

A bounded peer-omission closure worked with all of these conditions together:

1. Materialize with `npm ci --omit=dev --omit=peer --ignore-scripts`.
2. Audit the same closure with `npm audit --omit=dev --omit=peer --ignore-scripts`.
3. Prove every declared skill still exists after materialization.
4. Prove the host peer is absent from `node_modules`.
5. Inspect every declared command/hook entrypoint and reject imports of the omitted peer.
6. Keep the dependency version/lock unchanged; peer omission is a closure decision, not an implicit upgrade.
7. Make the security disposition conditional: if the runtime contract later materializes the peer, the original advisory gate reactivates.

The lock can still describe omitted peer packages while the materialized runtime closure excludes them. Therefore integrity and release evidence must state both the checked lock and the exact omission flags.
