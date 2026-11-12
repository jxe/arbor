// Declarative collection schemas (spec 06 §2.4), compiled from a collection's
// schema.beetle, and a collection's log (collections §1). Pure: compiling, validation,
// CSV conversion, generated declarations and logs never execute authored code or touch
// the filesystem or network: a snapshot's SQLite file
// is read and written through `useSnapshotDatabase`.
export * from "./diagnostics.ts";
export { compileCollectionSchema, compileCollectionSchemas, decodeSchemaSource, singleTable, type Check, type ChildNameRule, type CollectionLayout, type CollectionSchema, type CollectionSchemaSet, type CsvColumn } from "./compile.ts";
export { validateRow, collectionValidationBudget, type ValidationBudget } from "./validate.ts";
export { csvHeaderDiagnostics, csvRowValue, encodeCsvRecord, encodeCsvRows, CsvEncodeError } from "./csv.ts";
export { collectionTypeDeclarations } from "./typescript.ts";
export { logicalChildName, RESERVED_CHILD_NAMES } from "./names.ts";
export { CollectionSchemaCache, sharedCollectionSchemaCache } from "./cache.ts";
export * from "./collection-file.ts";
export { applyRowOperations, canonicalMany, canonicalSet, replayCollectionRows } from "./row-replay.ts";
export { spliceCollectionFile, type CollectionRowSplice } from "./splice.ts";
export {
  collectionRowName,
  collectionRowProperties,
  directoryCollectionSchema,
  encodeDirectoryCollection,
  loadDirectoryCollection,
  ProtocolCollectionError,
  checkCollectionNames,
  type CollectionRowNode,
  type DirectoryCollection,
} from "./directory-collection.ts";
export { mergeCollectionRows, mergeMembers, type RowFieldConflict, type TextMerge } from "./row-merge.ts";
export { deriveRowOperations, rowOperationsBetween } from "./row-diff.ts";
export { changedCollectionRows, compileLogicalSchema, checkLogicalTables, encodeCollection, loadCollection, LogicalCollectionError, plainRows, plainTables, treeTables, type EncodedCollection, type LogicalDiagnostic, type LogicalSchema } from "./logical.ts";
export {
  appendRowChanges,
  applyRowChanges,
  changesBetween,
  EMPTY_COLLECTION_STATE,
  encodedLogEntry,
  loadCollectionState,
  readSnapshotRows,
  rowChangesTo,
  snapshotLayout,
  stateTables,
  writeSnapshot,
  useSnapshotDatabase,
  type CollectionState,
  type SnapshotDatabase,
} from "./collection-log.ts";
export { fromSQLite, sqliteRow, toSQLite } from "./sqlite-values.ts";
