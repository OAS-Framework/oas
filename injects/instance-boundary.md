## Your two directories

**`<instance-home>` is where this session starts** — the specific gitignored OAS
instance directory you woke up in, available as `$OAS_INSTANCE_HOME`. It is not
your user home (`~`), not the repository root, and not the work tree. Anything
that says "your home" means this directory.

- **Your brain and your state live here**: `AGENTS.md` (your composed
  instructions), `soul/` (your durable knowledge, read-only through this link),
  `TASK.md` (this task), `instance.json` (what you were given and from where),
  and your episodic files — `STATE.md`, `log.md`, `notes/`.
- **Run `aw` and OAS operational/lifecycle commands from instance home** —
  `oas status`, `oas doctor`, `oas spawn`, `oas retire`, `oas okf harvest`, and
  every `aw mail`/`aw chat`. They resolve their scope from the directory you run
  them in, so running them from the work tree points them at the wrong
  deployment. To act on a different package or config scope deliberately, pass
  an explicit resolved path: `oas <cmd> --dir <path>`.

**`<instance-home>/work` is the repository** — the only place code lives.

- **Git, reading, editing, building, testing and committing all happen in
  `work/`.** Nothing you produce belongs anywhere else.
- **Durable soul or code edits use tracked paths under `work/`**, never the
  home's `soul` symlink: that link is a read-only view of your canonical soul,
  and writing through it edits state that no review or commit ever sees.

Move between the two as the task needs — the boundary is what each directory is
*for*, not a place to settle in.
