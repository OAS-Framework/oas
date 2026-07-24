## Review discipline: oas.review

**After every substantive commit, launch BOTH service agents — always, as a
pair:**

```bash
oas okf harvest    # promote your pending notes into your soul
oas spawn reviewer --work attached --work-dir "$PWD/work" \
  --purpose "<short-sha>" \
  --task "Review commit <sha> on branch <branch>. Report to <your-instance> per your operating loop."
```

- `--purpose "<short-sha>"` gives the reviewer a unique, commit-relevant
  instance name (`reviewer-<short-sha>`); attached mode nests it under you.
- The reviewer reviews **that commit's diff only** and reports back **by aweb
  mail** to you (verdict `APPROVE` / `APPROVE WITH NITS` / `NEEDS CHANGES`).
  Do not wait actively: finish your turn and go idle — the aweb channel
  awakens you when the mail arrives. `NEEDS CHANGES` means fix, commit, and
  re-review before the work is ready.
- Do not review your own commits in its place — the point is eyes that are
  not yours.
- Skip only for trivial mechanical commits (typo, lockfile refresh) — when
  in doubt, review.

## Delivery discipline (all OAS developers)

- You work in a dedicated worktree on your own branch. **Main only moves
  through PRs** — never push to main.
- **Single-developer features**: branch from main (`agents/<instance>` or as
  tasked), open the PR yourself (`gh pr create`) when review-clean, then
  **spawn a fresh maintainer instance for it** — one per PR, always, even if
  another oas-expert instance is live:

  ```bash
  oas spawn oas-expert --purpose "pr<n>" --parent "$OAS_INSTANCE" \
    --task "Maintainer review of PR #<n>: run your pr-review gates. You own this PR to its terminal outcome — on RETURN stay alive and idle for my fixed-mail, re-review, repeat; on merge/close record the delivery in your stewardship knowledge and retire yourself. Report verdicts to <your-instance> by aweb mail."
  ```

  Go idle for the verdict. **The maintainer instance stays alive across
  RETURN rounds** — when you push fixes, mail the SAME maintainer (reply on
  its thread); do not spawn another for this PR. You never merge to main
  yourself.

  **Reviewers are the opposite: one per commit, then gone.** The post-commit
  reviewer reviews its one diff, mails its verdict, and retires — it no
  longer exists when you fix its findings. To re-review a fix, spawn a NEW
  reviewer on the fix commit (`--purpose <new-short-sha>`); never mail a
  retired reviewer or expect it to follow up.
- **Multi-developer features**: the coordinator owns the feature branch
  (`feature/<name>`) and the PR. Branch `<you>/<name>` **from the feature
  branch**, push your branch, and tell the coordinator when it is ready —
  the coordinator merges, validates, and reviews the integrated state. Never
  merge into the feature branch yourself.
- **If you need another developer's unmerged code, ask the coordinator** by
  aweb mail — never fetch or merge a peer's branch yourself. The coordinator
  lands the dependency on the feature branch and tells you to merge the
  feature branch into yours.
- Quality bar before handing off or opening a PR: the repo's full test/check
  gate green; docs updated with behavior changes.
- While waiting on the reviewer, the coordinator, or a peer: **do not sleep,
  poll, or busy-wait** — go idle; aweb awakens you.
