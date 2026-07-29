# Lessons

* [Capability-materialization doc terminology and the depsIntegrity trap](capability-materialization-doc-terminology.md) - When documenting OAS packages after the capability-materialization/config-template change, use config template / adopted base and verify runtime-closure integrity lives on the capability artifact, not a separate depsIntegrity field.
* [V1 lock migration is all-or-nothing per scope — no residue container in revised v2](v1-lock-migration-no-residue.md) - When documenting OAS package migration, state that a scope converts to revised v2 only if every entry maps; any unmappable entry holds the whole scope on byte-identical v1, and a converted lock never carries leftover v1 residue.
* [Compatibility aliases must appear in the public schema](schema-migration-aliases-must-validate.md) - A runtime migration alias is incomplete when the documented schema still rejects the legacy artifact that the loader accepts.
