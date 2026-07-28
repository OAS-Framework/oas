---
type: Lesson
title: A caller-supplied git ref in argv is an option, not just a value
description: git checkout -q --detach exits 0 without selecting any revision, so a ref spelled --detach makes the caller read HEAD and report it as the pinned commit — resolve behind --end-of-options and check out the verified hash.
tags: [security, git, packages, kernel, review]
timestamp: 2026-07-28
---

Using `execFileSync` instead of a shell removes shell injection. It does NOT
remove **option injection**: an argv element beginning with `-` is still parsed
as a flag by the program you invoked.

```js
execFileSync("git", ["-C", dir, "checkout", "-q", ref]);   // ref = "--detach"
```

`git checkout -q --detach` with no revision **exits 0** and leaves HEAD exactly
where it was. Verified directly:

```
exit=0 after bare --detach (no revision)
4a25c863 <- HEAD still readable, checkout reported success
```

A caller that then does `rev-parse HEAD` reports that commit as the pinned one.
This is a **fail-open on the pin**, which is the worst possible failure for a
lockfile system: the operation succeeds, the lock records a real 40-hex commit,
and it is the wrong one.

# The safe shape

Resolve first, check out a hash, verify you landed:

```js
const sha = git("rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`);
if (!/^[0-9a-f]{40}$/.test(sha)) throw invalidSource(...);
git("checkout", "-q", "--detach", sha);       // a hex string cannot be an option
if (git("rev-parse", "HEAD") !== sha) throw invalidSource(...);
```

`--end-of-options` (git ≥ 2.24) is what makes the *resolve* step safe; the
40-hex assertion is what makes the *checkout* step safe; the HEAD comparison is
what makes the whole thing verified rather than assumed. All three are needed —
dropping the last one is how a silent no-op survives.

# Where the untrusted refs come from

Not only the CLI. A package's `oas-package.json` `dependencies[]` entries carry
refs, so a **remote, third-party manifest** supplies argv here. Any git
invocation reachable from acquisition must assume its ref is hostile. Three
call sites shared this hole (acquisition fetch, source inspection, WS2 profile
diff) — one helper, used everywhere, beats three careful call sites.

Generalize: grep for any `execFileSync`/`spawn` where a value that crossed a
trust boundary lands in argv *before* a `--` or `--end-of-options`, and ask what
that program does when the value starts with a dash. Related, from the same
soul: [rollback probes](/lessons/rollback-probes-argv-and-fail-closed.md) must
never interpolate public branch/ref values.

See [lock source strictness](/lessons/lock-source-strictness-prevents-reclassification.md)
for the sibling "persisted value re-parsed as input" hazard.
