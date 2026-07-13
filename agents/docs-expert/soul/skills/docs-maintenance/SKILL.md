---
name: docs-maintenance
description: >-
  How to audit and update documentation against the current implementation.
  Use when reviewing existing docs, checking docs for staleness after code
  changes, or asked whether docs are up to date. Covers finding stale claims,
  verifying examples, doc-type fit (Diátaxis), and the update workflow.
  Triggers: "are the docs up to date", "audit the docs", "docs review",
  "update docs after this change", "stale documentation".
---

# Docs maintenance

Docs rot silently. Code moves and prose stays. Your job is to find the drift
and close it. The implementation is the source of truth. The doc is a claim
about it.

## The audit loop

1. **Inventory.** List the docs (README plus docs/ plus doc-bearing configs).
   Note what each claims to describe.
2. **Extract claims.** For each doc, the checkable claims are paths, commands,
   config keys, schema fields, defaults, and behavior statements.
3. **Verify against the implementation.**
   - Paths: does the file or dir exist? `ls` it.
   - Commands: run them (read-only ones) or dry-run them.
   - Config keys and schemas: grep the code that parses them.
   - Behavior: find the function. Read it. Does it do what the doc says?
4. **Fix or flag.** Fix drift directly. If the code looks wrong rather than
   the doc, flag to the human instead of "fixing" the doc to match a bug.
5. **Sweep cross-references.** Renamed files break links. Search the whole
   doc set for old names after any rename.

## High-yield staleness patterns

Check these first. They catch most rot.

- **Moved or renamed paths.** The doc says `skills/x`, the repo has
  `capabilities/y/skills/x`.
- **Old architecture words.** Names from a previous design that survived a
  refactor. Grep for the old term across all docs after any big change.
- **Dead defaults.** "By default X" where the default changed.
- **Example configs that no longer parse.** Paste them into the real parser
  when one exists.
- **Compatibility aliases missing from public schemas.** If a loader accepts a
  legacy name during migration, validate an old artifact against the public
  schema too. A runtime alias that the schema rejects makes the docs false.
  See the [schema migration lesson](../../knowledge/lessons/schema-migration-aliases-must-validate.md).
- **"Currently" and "new".** Time-relative words rot fastest. Replace with
  dated markers or delete.
- **Status notes.** "Not yet implemented" for things that shipped, and the
  reverse.

## Doc-type fit (Diátaxis, in one breath)

Four doc types serve four reader needs. Mixing them weakens each.

| Type | Reader need | Form |
|---|---|---|
| Tutorial | learn by doing | guided steps to a promised result |
| How-to | solve this task now | short recipe, assumes context |
| Reference | look up the facts | dry, complete, structured |
| Explanation | understand why | prose, background, tradeoffs |

When a doc feels muddled, it is usually two types in one file. Split rather
than blend. A README may sample all four briefly, but it should link out for
depth.

## Update workflow after a code change

1. Ask what the change renamed, moved, added, or removed.
2. Grep every affected term across README, docs/, skills, and inline doc
   comments.
3. Update each hit. Apply the clear-writing skill as you rewrite. Do not
   just patch the fact into a stale sentence.
4. Verify the doc's examples still run after your edit.
5. One commit for the doc sweep, stating which change it tracks.

## Definition of done

- Every claim verified or flagged.
- No dead links or paths.
- Examples run.
- Prose passes the clear-writing self-check.
- The doc says when it was last true, where that helps the reader.
