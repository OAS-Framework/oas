---
type: Lesson
title: Guard file-serving paths by realpathing requests and roots
description: The /api/file endpoint must realpath both the requested file and each allowed root, then require exact-root or root-plus-separator containment so dotdot, symlink, and sibling-prefix escapes fail closed.
tags: [oas-web, file-endpoint, security, path-traversal]
timestamp: 2026-07-22
---

# The guard shape

`/api/file` uses `resolveGuardedFile` (marker block `OASWEB_FILEGUARD` in
`bin/oas-web.mjs`) to compare canonical filesystem locations, not raw strings:

1. reject non-absolute requested paths with HTTP 400;
2. `realpath` the requested file, so missing files fail with HTTP 404 and
   symlinks or `..` segments are resolved by the kernel;
3. `realpath` every allowed root, because macOS roots such as `/tmp` or `/var`
   may themselves be symlinks;
4. allow only `real === root || real.startsWith(root + sep)`, so a sibling such
   as `/root-evil` cannot match root `/root`;
5. return HTTP 403 when the real requested path is outside all allowed roots.

# Allowed roots

For the desktop viewers, the file endpoint's allowed roots are the workspace
agents roots plus each known instance's home, `<home>/work`, and repo from the
roster snapshot.

# Rule

Any future file-serving endpoint must realpath both sides and include the
separator-aware containment check. String-normalizing the request path alone does
not close symlink, root-symlink, or sibling-prefix escapes.

# Related concepts

- [oas-web architecture](/architecture/oas-web-architecture.md)
- [Spawn endpoint root allowlist and empty-task semantics](/architecture/spawn-endpoint.md)
