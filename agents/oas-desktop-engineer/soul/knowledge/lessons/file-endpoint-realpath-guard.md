---
type: Lesson
title: Guard file-serving paths by realpathing requests and roots
description: The /api/file endpoint must admit only trusted or lstat-validated roots, then realpath both the requested file and each allowed root with exact-root or root-plus-separator containment.
tags: [desktop-backend, file-endpoint, security, path-traversal, local-souls]
timestamp: 2026-07-24
---

# The guard shape

`/api/file` uses `resolveGuardedFile` (marker block `OASWEB_FILEGUARD` in
`packages/desktop/server/oas-web.mjs`) to compare canonical filesystem locations, not raw strings:

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
agents roots plus each workspace's sibling `local-agents/` directory and each
known instance's home, `<home>/work`, and repo from the roster snapshot. Local
souls live outside the agents root, so omitting the sibling `local-agents/` root
makes brain and markdown views 403 on their files.

Allowed roots are trusted anchors once `resolveGuardedFile` realpaths them. Before
adding a root whose unresolved path comes from opened-workspace content (for
example a workspace-derived `local-agents/` sibling), validate the candidate
itself:

- `lstatSync(base).isDirectory()` so a symlinked root is rejected without
  following it;
- `realpathSync(dirname(base)) === realpathSync(dirname(root))` so the
  candidate's canonical parent remains the expected workspace scope.

Without that admission check, an untrusted workspace can replace `local-agents/`
with a symlink to a secret directory and the root realpath step will bless the
symlink target as an allowed root.

# Rule

Any future file-serving endpoint must realpath both sides and include the
separator-aware containment check. String-normalizing the request path alone does
not close symlink, root-symlink, or sibling-prefix escapes.

When future code widens the allowed-root list from repository- or
workspace-shaped data, first prove the unresolved path is a real directory under
the expected canonical parent. Treating untrusted paths as already-trusted roots
bypasses the guard rather than strengthening it.

Regression tests for root admission should drive the real HTTP boundary with the
candidate symlink pointed at an actual secret directory, assert the escape is
forbidden, and also assert a real `local-agents/` sibling still serves; a guard
that blocks both cases breaks local souls instead of fixing the security bug.

# Related concepts

- [desktop backend architecture](/architecture/desktop-backend-architecture.md)
- [Spawn endpoint root allowlist and empty-task semantics](/architecture/spawn-endpoint.md)
- [Lstat untrusted worktree entries before reading](/lessons/untrusted-worktree-entries-lstat-before-reading.md)
