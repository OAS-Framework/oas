---
type: Lesson
title: Guard file-serving paths with admitted canonical roots
description: The /api/file endpoint must admit only trusted or lstat-validated roots, canonicalize each root exactly once at admission, then guard requested files by realpathing only the request against those immutable root strings.
tags: [desktop-backend, file-endpoint, security, path-traversal, toctou, local-souls]
timestamp: 2026-07-24
---

# The guard shape

`/api/file` uses `resolveGuardedFile` (marker block `OASWEB_FILEGUARD` in
`packages/desktop/server/oas-web.mjs`) to compare canonical filesystem
locations, not raw strings. The timing matters:

1. reject non-absolute requested paths with HTTP 400;
2. build the allowed-root list from trusted anchors or from roots that were
   admitted by the checks below;
3. canonicalize each allowed root exactly once at admission and pass those
   captured canonical strings to the guard;
4. at use time, `realpath` only the requested file, so missing files fail with
   HTTP 404 and symlinks or `..` segments in the request are resolved by the
   kernel;
5. allow only `real === root || real.startsWith(root + sep)`, so a sibling such
   as `/root-evil` cannot match root `/root`;
6. return HTTP 403 when the real requested path is outside every admitted root.

Do **not** have `resolveGuardedFile` re-`realpath` its allowed roots on every
request. A directory-to-symlink swap between root admission and use can make the
requested file and the supposedly admitted root both resolve into the attacker's
target; containment then holds vacuously and the outside file is served. The
check and the use must share one root resolution.

# Allowed roots

For the desktop viewers, the file endpoint's root inputs are the workspace
agents roots plus each workspace's sibling `local-agents/` directory and each
known instance's home, `<home>/work`, and repo from the roster snapshot. Local
souls live outside the agents root, so omitting the sibling `local-agents/` root
makes brain and markdown views 403 on their files.

Before adding a root whose unresolved path comes from opened-workspace content
(for example a workspace-derived `local-agents/` sibling), validate the
candidate itself before capturing its canonical string:

- `lstatSync(base).isDirectory()` so a symlinked root is rejected without
  following it;
- `realpathSync(dirname(base)) === realpathSync(dirname(root))` so the
  candidate's canonical parent remains the expected workspace scope.

Without that admission check, an untrusted workspace can replace
`local-agents/` with a symlink to a secret directory and get the symlink target
captured as an allowed root. Without immutable captured roots, a root that was
safe at admission can be swapped before use and re-resolved into an attacker
chosen target.

# Regression shape

Regression tests for root admission should drive the real HTTP boundary with the
candidate symlink pointed at an actual secret directory, assert the escape is
forbidden, and also assert a real `local-agents/` sibling still serves; a guard
that blocks both cases breaks local souls instead of fixing the security bug.

Regression tests for the guard itself should exercise the extracted guard block
with a pre-captured root string: capture the admitted canonical root, swap the
original directory to a symlink, then call the guard and assert the outside file
is forbidden. Mutation-check the exact fix by reintroducing use-time root
resolution; the test must fail under that mutation.

# Rule

Any future file-serving endpoint must canonicalize roots once at admission,
carry those immutable canonical strings to use time, realpath the requested path
at use time, and perform exact-root or root-plus-separator containment. String
normalization alone does not close symlink, root-symlink, sibling-prefix, or
admission-to-use TOCTOU escapes.

Descriptor-based no-follow traversal would be stronger, but immutable-string
admission closes the re-resolution channel. If future work changes the allowed
root list from repository- or workspace-shaped data, first prove the unresolved
path is a real directory under the expected canonical parent, then capture the
canonical root once.

# Related concepts

- [desktop backend architecture](/architecture/desktop-backend-architecture.md)
- [Spawn endpoint root allowlist and empty-task semantics](/architecture/spawn-endpoint.md)
- [Lstat untrusted worktree entries before reading](/lessons/untrusted-worktree-entries-lstat-before-reading.md)
- [Regression tests must exercise the layer that had the bug](/lessons/regression-tests-bug-layer.md)
