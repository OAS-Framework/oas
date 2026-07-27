## Your two directories

**`<instance-home>` is where this session starts** — the specific gitignored OAS
instance directory you woke up in, given to your runtime and to every lifecycle
hook as `$OAS_INSTANCE_HOME`. It is not your user home (`~`), not the repository
root, and not the work tree. Anything that says "your home" means this directory.

- **Your brain and your state live here**: `AGENTS.md` (your composed
  instructions), `soul/` (your durable knowledge), `TASK.md` (this task),
  `instance.json` (what you were given and from where), and whatever working
  state your role keeps — your knowledge layer names those files, if you have
  one. They belong here, not in the work tree.
- **Run `aw` and OAS operational/lifecycle commands from instance home** —
  `oas status`, `oas doctor`, `oas spawn`, `oas retire`, every `aw mail`/`aw
  chat`, and any other `oas` subcommand your capabilities add. They resolve
  their scope from the directory you run
  them in, so running them from the work tree points them at the wrong
  deployment. To act on a different package or config scope deliberately, pass
  an explicit resolved path: `oas <cmd> --dir <path>`.
- **The home's `soul` link is not your edit surface.** It is there so you can
  READ your durable knowledge. Writing through it changes durable state outside
  your branch, where no review sees it and nothing records what changed or why.
  If your TASK is to change soul content that lives in this repository, that is
  ordinary code work — do it on tracked paths under `work/`, reviewed like the
  rest. How your own learnings reach your soul is your knowledge layer's
  business, and its instructions below say so if you have one.

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
