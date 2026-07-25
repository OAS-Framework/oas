---
type: Lesson
title: String-coerce workspace metadata before roster grouping and sorting
description: Roster grouping and sorting code must coerce workspace-controlled instance.json fields to strings before Map keys or localeCompare so one malformed instance cannot blank the roster.
tags: [desktop, renderer, roster, robustness, untrusted-metadata]
---

# String-coerce workspace metadata before roster grouping and sorting

`instance.json` metadata is workspace-controlled data, and the desktop reader may
forward non-string values such as objects. Treat fields like `agent` and
`repoName` as untrusted at the renderer boundary when they feed roster grouping,
sorting, labels, or collapse keys.

A review of `groupRosterFamilies` found that using `i.agent` and
`instanceRepoLabel(i)` directly as grouping/sort keys let an instance with
`{ "agent": {} }` reach `localeCompare` and throw. Because the throw happened in
the render path, one malformed instance blanked the entire roster surface rather
than only degrading that row.

The regression fix coerced at the pure grouping helper with
`String(i.agent || "?")` and `String(instanceRepoLabel(i))`, then tested malformed
metadata cases — object-valued `agent`, object-valued `repoName`, and missing
`agent` — and asserted each instance still rendered once.

General rule: any renderer code that sorts or groups on fields originating from
workspace files must string-coerce at the helper or validate at the backend
boundary first. A throw in a render loop is availability loss for the whole view.

Related: [Keep roster family grouping helpers inside instance-tree](/lessons/roster-family-grouping-helpers.md).
