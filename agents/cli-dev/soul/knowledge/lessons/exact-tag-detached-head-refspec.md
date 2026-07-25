---
type: Lesson
title: Exact-tag release checkout needs fully-qualified push refnames
description: Switching a release workflow checkout from main to github.sha preserves exact-tag integrity but leaves the runner in detached HEAD, so version-bump pushes must use a fully-qualified destination such as HEAD:refs/heads/<branch>.
tags: [release, ci, git, github-actions, detached-head]
timestamp: 2026-07-25
---

# Lesson

The v0.18.2 release workflow built, tested, published npm, and created the
GitHub Release successfully, then failed on its last housekeeping step: opening
the version-bump-back-to-main PR. The push used a partial destination refname:

```bash
git push origin "HEAD:release-bump/v0.18.2"
```

Git refused from the runner's detached HEAD:

```text
error: The destination you provided is not a full refname (i.e., starting with "refs/")
```

The reworked workflow deliberately checked out `ref: ${{ github.sha }}` rather
than `ref: main` so the release builds from the immutable exact-tag SHA. That
integrity change detaches HEAD; in that state Git cannot infer whether
`HEAD:<name>` should create a branch or a tag. Fully qualify the destination:

```bash
git push origin "HEAD:refs/heads/${BRANCH}"
```

This works from both attached and detached HEAD. When maintaining the release
workflow, extend the static workflow tests to assert the `HEAD:refs/heads/${BRANCH}`
form and reject the ambiguous `HEAD:${BRANCH}` form; see
[release workflow static tests](/lessons/release-workflow-static-tests.md).

# Recovery

The bump-PR step runs after npm publication and GitHub Release creation, so this
failure left the release live and correct. Only the automated bump PR was
missing; recover by opening that bump PR manually. More generally, keep
irreversible publication before fragile housekeeping so a housekeeping failure
cannot block an already-completed release. See the
[tag-driven release playbook](/playbooks/release-tag-driven-ci.md).
