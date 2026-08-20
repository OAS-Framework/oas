---
type: Lesson
title: Portable-template validators must classify machine paths cross-platform
description: A no-machine-path gate must recognize path semantics across POSIX, Windows, and home-relative forms instead of enumerating familiar directory names.
tags: [packages, config-templates, portability, validation, paths, cross-platform]
timestamp: 2026-08-20
---

# Portable-template validators must classify machine paths cross-platform

A portability regex that lists familiar roots such as `/Users`, `/home`, or
`/var` proves only those examples. It still accepts other absolute POSIX paths
such as `/tmp` or `/etc`, Windows drive/root-relative/UNC paths, and
home-relative `~/...` values. The validator can therefore report a template
portable even though adoption copies machine-local policy into another
workspace.

Validate path semantics rather than directory names. Inspect the parsed config
values that can carry paths, distinguish URLs and other portable identifiers,
and recognize at least:

- every POSIX absolute path, regardless of first directory;
- Windows drive-absolute, root-relative, and UNC forms even when validation runs
  on a non-Windows host;
- `~`-prefixed home paths and supported environment-variable forms; and
- quoted variants without changing the config reader's actual scalar meaning.

Regression fixtures must cover each path family, not one representative Unix
home path. For backslash-sensitive forms, construct or display the exact bytes
so host-language and shell escaping cannot turn the intended fixture into a
different string.

This is a producer-side enforcement of the portability requirement in
[Packages materialize capabilities while config templates remain explicitly
adopted local policy](/decisions/capability-materialization-and-config-template-sync.md): explicit adoption preserves user sovereignty, but the package template must still be portable source material.
