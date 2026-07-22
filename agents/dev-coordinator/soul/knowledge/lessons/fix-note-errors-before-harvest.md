---
type: Lesson
title: Fix doc nits in notes before the harvest runs
description: Review findings that touch a developer's knowledge notes must be corrected before oas okf harvest, or inaccurate content is promoted into the soul.
tags: [harvest, review, knowledge-hygiene]
timestamp: 2026-07-22
---

# Lesson

In the terminal-fidelity delivery, maintainer review found two factual errors
in the developer's knowledge concepts (a dropped `-J` tmux flag still
documented, and a paste-normalization direction inverted). Because harvest
promotes notes verbatim into the soul, the coordinator relayed the nits with
an explicit instruction to fix them **before** running `oas okf harvest`.

Rule: when a review flags errors in notes/knowledge content, sequence the fix
ahead of the harvest in the wrap-up instructions.
