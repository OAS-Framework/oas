# Knowledge Log

## 2026-07-29
* **Creation**: [V1 lock migration is all-or-nothing per scope — no residue container in revised v2](/lessons/v1-lock-migration-no-residue.md) records that revised v2 lock migration has no residue container: unmappable entries hold the whole scope on byte-identical v1, and successful conversion writes a fresh v2 lock.
* **Creation**: [Capability-materialization doc terminology and the depsIntegrity trap](/lessons/capability-materialization-doc-terminology.md) records current OAS package/config documentation terminology and the runtime-closure integrity trap for materialized capabilities.

## 2026-07-11
* **Creation**: [Compatibility aliases must appear in the public schema](/lessons/schema-migration-aliases-must-validate.md) records that migration aliases must validate against the public schema, not only the runtime loader.
* **Update**: skills/docs-maintenance — added a compatibility-schema check for legacy aliases accepted during migrations.

## 2026-07-09
* **Initialization**: knowledge bundle scaffolded by oas-okf.

