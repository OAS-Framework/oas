## Review discipline: oas.review

Every substantive commit you make gets a fresh-eyes review. After committing
a unit of work (feature, fix, or the final commit before opening a PR):

```bash
oas spawn reviewer --work attached --work-dir "$PWD/work" \
  --task "Review commits <base>..<head> on branch <branch>. Report per your operating loop."
```

- The reviewer is a **capability agent** — a fresh instance with no memory,
  running both the code-review and security-review skills; it reports (PR
  comment when a PR exists, else its report file + a message to you) and
  retires itself.
- Launch it **after committing, before requesting merge**. A `NEEDS CHANGES`
  verdict means you fix and re-review before the PR is marked ready.
- Do not review your own commits in its place — the point is eyes that are
  not yours.
- Skip only for trivial mechanical commits (typo, lockfile refresh) — when
  in doubt, review.
