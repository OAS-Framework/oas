---
type: Lesson
title: parseYamlNested treated comment-only values as scalars
description: In the kernel's YAML subset, a key whose value is only a trailing comment (`layers:  # comment`) parsed as a scalar string instead of opening a nested map; treat raw values starting with `#` as empty.
tags: [yaml, parser, config, gotcha]
timestamp: 2026-07-13
---

`lib/core.mjs`'s `parseYamlNested` chose between nested maps and scalar values
by checking whether the raw value, after stripping ` #...`, was empty. The
strip regex required whitespace before `#`, and the emptiness check ran before
comment handling for values that were entirely a comment, so a line like
`key:   # note` became the key's string value and silently swallowed the nested
block below it.

The bug surfaced when `SKILL.md` config examples with inline comments failed
schema validation. The fix was to also treat `rawVal.trim().startsWith("#")` as
an empty value that opens a nested map.

Lesson: when documentation examples are schema-validated in CI, the validator
exercises the real parser. Doc-example failures can be parser bugs, not doc
bugs.

Related YAML gotcha: [Unquoted colons in skill descriptions silently kill skills](/lessons/yaml-colon-skill-descriptions.md).
