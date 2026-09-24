// Declarative collection schemas (spec 06 §2.4). Pure: parsing, profile
// checks, validation, CSV conversion, and generated declarations never execute
// authored code or touch the filesystem or network.
export * from "./diagnostics.ts";
export { compileCollectionSchema, decodeSchemaSource, type Check, type ChildNameRule, type CollectionSchema, type CsvColumn } from "./compile.ts";
export { validateRow, collectionValidationBudget, type ValidationBudget } from "./validate.ts";
export { csvHeaderDiagnostics, csvRowValue, csvSchemaDiagnostic, encodeCsvRows, CsvEncodeError } from "./csv.ts";
export { collectionTypeDeclarations } from "./typescript.ts";
export { logicalChildName, RESERVED_CHILD_NAMES } from "./names.ts";
export { CollectionSchemaCache, sharedCollectionSchemaCache } from "./cache.ts";
export * from "./collection-file.ts";
