# Lessons

* [Capability-materialization doc terminology and the depsIntegrity trap](capability-materialization-doc-terminology.md) - When documenting OAS packages after the capability-materialization/config-template change, use config template / adopted base and verify runtime-closure integrity lives on the capability artifact, not a separate depsIntegrity field.
* [Compatibility aliases must appear in the public schema](schema-migration-aliases-must-validate.md) - A runtime migration alias is incomplete when the documented schema still rejects the legacy artifact that the loader accepts.
