---
type: Lesson
title: Provision locked tmux key tables as explicit allow-lists
description: A tmux viewer key-table lock must be a real table containing only approved bindings, because a nonexistent table also disables root conveniences such as WheelUpPane scrollback that xterm.js cannot recover from alternate-screen history.
tags: [tmux, desktop, terminal, key-table, scrollback, wheel]
timestamp: 2026-07-23
---

For desktop terminal viewers, locking `key-table oasdesk-locked` by pointing at
a nonexistent tmux table made all root bindings inert. That blocked window
escape, but it also killed `WheelUpPane` scrollback. xterm.js cannot compensate
for that in pi because the app runs on the alternate screen and scrollback
history lives in tmux.

The lock should be a **provisioned table with an explicit allow-list**, not an
absent table. Export the allow-list so tests can pin the whole approved set.
The observed desktop viewer allow-list is exactly one binding:

- `WheelUpPane` runs
  `if-shell -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' 'send-keys -M' 'copy-mode -e; send-keys -M'`.

This deliberately diverges from the root-table `alternate_on` passthrough: that
branch is the dead case for an alternate-screen app without mouse grab. Apps
that grab the mouse still receive events through `mouse_any_flag`. Viewer
sessions also set `mouse on`, and `prefix None` still removes the
window-management path.

Regression coverage should pin both the policy and the live behavior:

- a unit guard on the exported binding set, including an approved-key allow-list
  and forbidden commands such as `next-window`, `previous-window`, `last-window`,
  `new-window`, `select-window`, `kill-window`, `choose-*`, and `switch-client`;
- an isolated tmux-server regression that drives copy-mode wheel scroll
  semantics.

Mutation checks should fail if provisioning is removed or a window-navigation
command is added to the locked table.

General rule: locking down a tmux surface usually means replacing it with an
explicit allow-list, not disabling the surface entirely.
