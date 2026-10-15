// Declarative collection schemas (spec 06 §2.4), compiled from a collection's
// schema.usl. Pure: compiling, validation, CSV conversion, and generated
// declarations never execute authored code or touch the filesystem or network.
export * from "./diagnostics.ts";
export { compileCollectionSchema, compileCollectionSchemas, decodeSchemaSource, singleTable, type Check, type ChildNameRule, type CollectionLayout, type CollectionSchema, type CollectionSchemaSet, type CsvColumn } from "./compile.ts";
export { validateRow, collectionValidationBudget, type ValidationBudget } from "./validate.ts";
export { csvHeaderDiagnostics, csvRowValue, encodeCsvRecord, encodeCsvRows, CsvEncodeError } from "./csv.ts";
export { collectionTypeDeclarations } from "./typescript.ts";
export { logicalChildName, RESERVED_CHILD_NAMES } from "./names.ts";
export { CollectionSchemaCache, sharedCollectionSchemaCache } from "./cache.ts";
export * from "./collection-file.ts";
export { applyRowOperations, canonicalRow, replayCollectionRows, spliceCollectionFile, type CollectionRowSplice } from "./row-replay.ts";
export { mergeCollectionRows, type RowFieldConflict, type TextMerge } from "./row-merge.ts";
export { deriveRowOperations } from "./row-diff.ts";
