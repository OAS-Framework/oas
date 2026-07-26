---
type: Lesson
title: Harvest cherry-picks must preserve source branch state, not only terminal commits
description: A terminal harvest commit can depend on unmerged semantic knowledge fixes in its parent branch, so reviewers must compare source-branch state for linked concepts before accepting a cherry-picked final diff.
tags: [pull-requests, review, okf, knowledge, cherry-pick]
timestamp: 2026-07-25
---

# Harvest cherry-picks must preserve source branch state, not only terminal commits

A knowledge-only cherry-pick can preserve the named terminal harvest commit while losing semantic knowledge updates that lived in the terminal commit's parent branch. In PR #36, the cherry-picked commit added a follow-up queue that linked to the final dispatch-ineligible view-action model, but the PR head omitted the source branch's parent harvest that had updated the linked concept. Strict OKF and full mechanical gates passed because the structure was valid.

For post-merge harvest PRs, compare the source branch state at the original terminal harvest commit with the PR head for any linked or relied-upon concepts, not only the cherry-picked diff. If a new concept/reference claims another concept captures the final design, open that target concept in the PR head and verify the body actually says so.

# Related

- [PR reviews need semantic knowledge consistency checks after branch-union harvests](/lessons/pr-review-knowledge-consistency-after-branch-union.md)
