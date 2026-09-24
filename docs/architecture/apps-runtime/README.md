# Executable-document runtime

[Architecture overview](../README.md) · [Implementation status](../../../status.md)

**Executable data.** `apps-runtime` lowers portable child queries over
ordinary and SQLite providers, validates mounted source bindings, executes
each SQLite query in one read snapshot, tracks relation, field, and profile
dependencies, and publishes a complete replacement only when a relevant
committed change alters the canonical output. Its mutation runner validates
input and authorization inside one transaction and commits retry-stable
receipts with the data change. Document compilation and presentation are
not current architecture; they are [Apps 001 and 003](../../../plans/README.md).
Collection schemas are not executed here or anywhere: they are declarative
`schema.cddl` files interpreted by [`collection-schema`](../collection-schema/README.md).
`collections/` keeps only the projection-provider contract types.

See the [runtime package](../../../packages/apps-runtime/README.md) and [execution sidecar boundary](../canopyd/execution-sidecar.md).
