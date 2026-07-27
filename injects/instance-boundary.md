## Your two directories

**`<instance-home>` is where this session starts** — the specific gitignored OAS
instance directory you woke up in, given to your runtime and to every lifecycle
hook as `$OAS_INSTANCE_HOME`. It is not your user home (`~`), not the repository
root, and not the work tree. Anything that says "your home" means this directory.

- **Your brain and your state live here**: `AGENTS.md` (your composed
  instructions), `soul/` (your durable knowledge), `TASK.md` (this task),
  `instance.json` (what you were given and from where), and your episodic files
  — `STATE.md`, `log.md`, `notes/`. Those belong here, not in the work tree.
- **Run `aw` and OAS operational/lifecycle commands from instance home** —
  `oas status`, `oas doctor`, `oas spawn`, `oas retire`, `oas okf harvest`, and
  every `aw mail`/`aw chat`. They resolve their scope from the directory you run
  them in, so running them from the work tree points them at the wrong
  deployment. To act on a different package or config scope deliberately, pass
  an explicit resolved path: `oas <cmd> --dir <path>`.
- **Treat the home's `soul` link as read-only.** One path updates a soul, in
  every custody: you write what you learn to `notes/`, and the harvester
  promotes it. Where the soul itself then changes is the harvester's business —
  a branch and a PR for a committed soul, a direct edit for an uncommitted local
  one. Editing through the link yourself skips that judgement and leaves no
  record of what changed or why. Soul content that lives in THIS repository is
  ordinary code: change it on tracked paths under `work/`, reviewed like the
  rest.

**`<instance-home>/work` is your repository or workspace view** — whatever your
work mode grants you of the code.

- **Repository work happens there and only there**: reading, editing, building,
  testing, git and commits, on repository content. Never from the main checkout
  or from your home root.
- **What your mode permits is the mode block's call**, immediately below. Some
  modes are read-only, some share a tree with others, and that block is the
  authority on which operations are yours to perform.
- This is about where the *repository's* content lives, not a ban on writing
  anywhere else: the episodic files above, and whatever artifacts your role
  calls for (a report written to a temp file before mailing it, a scratch
  script), go where your task and tooling direct.

Move between the two as the task needs — the boundary is what each directory is
*for*, not a place to settle in.
