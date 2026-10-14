// Checking that a store implements a schema. Each kind of store is a
// backend: it reads what is there and reports how it differs from the
// schema's layout. Add a backend to support another store.

import type { Table } from "../layout.ts";

export interface StoreDiagnostic {
  /** error: the store can't hold the schema's data as declared. warning: it holds more than the schema says. */
  severity: "error" | "warning";
  code: string;
  message: string;
  table?: string;
  column?: string;
  /** For data files: the 1-based row (JSON, JSONL) or line (CSV). */
  row?: number;
}

export interface StoreBackend {
  /** A short name, used on the command line: `sqlite`, `postgres`, `files`. */
  name: string;
  /** True when this backend reads `location` (a path or URL). */
  accepts(location: string): boolean;
  verify(tables: Table[], location: string): Promise<StoreDiagnostic[]>;
}

/** What a database reports about one table, in the dialect's own type names. */
export interface TableShape {
  name: string;
  columns: { name: string; type: string; nullable: boolean; hasDefault: boolean }[];
  primaryKey: string[];
  foreignKeys: { columns: string[]; table: string; refColumns: string[] }[];
}
