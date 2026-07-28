---
type: Lesson
title: Package source fetch seams must share the engine resolver
description: A second package fetcher that uses its own source classifier or reads the repository root can silently compare the wrong package once Git repositories may contain package payload roots.
tags: [packages, kernel, ws2, seams]
timestamp: 2026-07-28
---

`lib/packages.mjs`'s `resolveProfilePackage` path behind `oas config diff
--package <git-url>` fetched package sources itself instead of going through the
engine acquisition path. It cloned the repository and called
`loadPackageManifestAt(clone)`, reading the repository root, and classified
sources with its own `/^(https?:\/\/|git@|ssh:\/\/)/` regex.

That was harmless until contained package roots existed. Afterward the diff
could read the manifest at the repository root while install locked
`oas-package/`, so an adopted snapshot compared against a profile from a
completely different package. Nothing failed loudly; it compared the wrong
thing.

# Rule

Any consumer that fetches a package source itself must reuse the engine's source
classification (`parsePackageSource`) and root resolution (`resolvePackageRoot`).
Do not copy the Git/local/source predicate, and do not treat the clone directory
as the package root.

The local regex also missed accepted Git spellings such as `file://`, `git://`,
and `git:host/org/repo` shorthand. Divergent classification is the same class of
bug as divergent path resolution; both vanish when the engine parser is the only
classifier.

Do not wrap source parse failures in `try/catch { undefined }` to fall through
to installed-id lookup. A typed `path-escape` or malformed source error is the
failure; converting it into "is not an installed package id" hides the real
contract violation.

The CLI predicate that decides whether to allocate a clone temp dir must use the
same classifier too. If that predicate and the resolver disagree, a Git source
arrives at the resolver with no clone directory and fails with an internal
message instead of a source-level diagnostic.

See [payload root subtree extraction](/lessons/payload-root-subtree-extraction.md)
for the acquisition shape that exposed this seam.
