---
type: Lesson
title: Compatibility aliases must appear in the public schema
description: A runtime migration alias is incomplete when the documented schema still rejects the legacy artifact that the loader accepts.
tags: [documentation, schemas, migration, compatibility]
timestamp: 2026-07-11
---

When a loader preserves old manifest identities such as `integration` or
`provider`, validate representative old manifests against the new public
schema. A schema that requires only the replacement `capability` field makes
the documented compatibility claim false even when runtime loading succeeds.

Use a conditional schema. Require the new metadata when `capability` is
present, while allowing the legacy identity-only shape during migration. Test
both current bundled manifests and manifests from the pre-migration tree.
