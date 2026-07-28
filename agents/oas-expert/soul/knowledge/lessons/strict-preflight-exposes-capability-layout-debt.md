---
type: Lesson
title: Strict resource preflight exposes capability layout debt at the first targeted spawn
description: A capability that declares resources outside its acquired artifact may appear installed until strict targeted composition resolves the paths and fails the spawn.
tags: [capabilities, packages, composition, migration, testing]
timestamp: 2026-07-28
---

# Strict resource preflight exposes capability layout debt at the first targeted spawn

After strict active-resource composition landed, a post-merge scaffold probe for a framework-author soul failed closed because an additive authoring capability declared skill paths that were valid only in the monorepo source layout. Its acquired artifact contained the manifest but not the sibling skill trees. A developer-family probe, which did not target that capability, materialized correctly and verified canonical home placement, aliases, skills, provenance, lineage, and clean retirement.

The general lesson is that an install/restore gate does not prove every independently targetable capability is spawnable. Strict composition resolves only capabilities active for the selected soul/type, so a malformed resource path can remain latent until that target is probed. Package transitions must co-locate every declared skill/injection under the acquired package boundary (or use another explicitly supported locked dependency location), and acceptance must include at least one fresh scaffold probe for every targeting class—not only a generic baseline soul.

Failing closed is the correct runtime behavior; the package/layout must be repaired rather than weakening resource completeness or containment.
