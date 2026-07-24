---
type: Lesson
title: Grouped sessions share membership — link-window isolates viewer windows
description: tmux grouped sessions isolate current-window selection but share window membership, so desktop terminal viewers must be independent sessions with only a link-window to the exact source window and disabled prefix/root window navigation.
tags: [tmux, desktop, terminal, link-window, isolation]
timestamp: 2026-07-24
---

Grouping a viewer with the durable session (`new-session -t`) isolates only the
current-window selection. It still shares the durable session's full window
membership, which leaves two escape paths for a pinned desktop terminal tab:

- when the selected source window dies during routine `oas retire`, tmux can
  auto-select a sibling window in the viewer, showing the wrong agent under the
  stale tab label;
- prefix/window navigation keys such as next, last, new, or numeric
  select-window can move the viewer to siblings.

The desktop terminal path in [Desktop terminal is a direct tmux attach via
node-pty](/decisions/desktop-terminal-direct-attach.md) should make each tab's viewer an
independent tmux session whose only window is a link to the exact source window:

1. create a placeholder viewer session with a unique random name;
2. `link-window -s =<source-session>:=<source-window> -t =<viewer>:9`;
3. `kill-window -t =<viewer>:0` so the linked window is the viewer's only
   window;
4. attach node-pty to `=<viewer>`.

With that shape, source window death terminates the viewer path instead of
activating a sibling, and killing the viewer does not kill the source window
because tmux link refcounts keep the durable window alive.

Lock the viewer against in-terminal window navigation: set its `prefix` and
`prefix2` options to `None`, and set `key-table` to a provisioned locked table.
The table must be an explicit allow-list, not a nonexistent table: see
[Provision locked tmux key tables as explicit allow-lists](/lessons/provision-locked-key-tables.md)
for the `WheelUpPane` scrollback binding and forbidden window-navigation set.
`set-option -t` does not accept the `=` anchors covered by [Anchor every tmux
target the desktop constructs](/lessons/anchor-tmux-attach-targets.md), so this exception
is safe only for the unique random viewer session name, not for source
session/window targets.

Regression coverage should drive the live escapes that made grouping wrong:
kill source window A and assert source B never appears in the viewer; send
`C-b n`, `C-b l`, `C-b c`, and `C-b 1` and assert the viewer's window set stays
on the linked window. It should also preserve wheel scrollback through the
locked key table. Mutation checks should prove the tests fail if the code
reverts to grouped sessions, drops the key lock, or makes the locked table
nonexistent.
