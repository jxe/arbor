# @overstory/collection-schema

Declarative collection schemas: the Overstory CDDL collection profile of
[child backings §2.4](../../docs/overstory-spec/06-child-backings.md#24-collection-schema-profile)
and the collection-file codec built on it.

- `compileCollectionSchema(bytes)`: parse and check one `schema.cddl`, or throw
  a `CollectionSchemaError` whose first diagnostic has a code and location.
- `validateRow(schema, value)`: a pure decision with deterministic JSON Pointer
  diagnostics; it never changes the value.
- `csvRowValue`, `csvHeaderDiagnostics`, `encodeCsvRows`: schema-directed CSV
  cells and the round-trip-checked encoder.
- `decodeCollectionFileSource`, `decodeWireCollectionFile`,
  `encodeWireCollectionFile`, `collectionChildSetHash`: collection files for
  Arbor Sync providers, canopyd acceptance and projection, and merge rules.
- `collectionTypeDeclarations`: static TypeScript for generated tree types.
- `CollectionSchemaCache`: a bounded cache keyed by the exact source hash.

The package executes no authored code and touches no filesystem or network; it
depends only on `@overstory/protocol` and `csv-parse`. The conformance vectors
are [`collection-schemas.json`](../../docs/overstory-spec/conformance/collection-schemas.json);
the design notes are in [the architecture](../../docs/architecture/collection-schema/README.md).
