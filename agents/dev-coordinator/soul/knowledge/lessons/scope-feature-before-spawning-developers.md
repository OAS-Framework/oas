---
type: Lesson
title: Scope a coordinator feature to one developer when ownership scan collapses
description: A coordinator task that sounds multi-dev can map entirely to one soul; scan repo surfaces and the soul roster before spawning developers so parallel choreography does not get invented.
tags: [planning, scoping, desktop, coordination]
---

# Scope a coordinator feature to one developer when ownership scan collapses

During the split-panels + hideable-sidebar feature, repo scouting showed the work lived entirely in `packages/desktop/renderer` (`shell.mjs`, `shell.css`, `terminal-tab.mjs`, keybindings), all owned by the **oas-desktop-engineer** soul. The README, `oas status` soul roster, and grep for sidebar/terminal code showed no kernel, CLI, or webpanel surface.

The right coordinator plan collapsed to: feature branch, one developer, then the same integration/review/PR delivery path. Run the ownership scan before spawning; do not split work across developers just because the coordinator role expects multiple.
