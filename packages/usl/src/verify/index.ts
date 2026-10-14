// The store backends, and choosing one for a location.

import type { CheckResult } from "../check.ts";
import { layoutOf } from "../layout.ts";
import { filesBackend } from "./files.ts";
import { postgresBackend } from "./postgres.ts";
import { sqliteBackend } from "./sqlite.ts";
import type { StoreBackend, StoreDiagnostic } from "./types.ts";

export type { StoreBackend, StoreDiagnostic, TableShape } from "./types.ts";
export { compareShapes } from "./shape.ts";
export { inspectSqlite, sqliteAffinity, sqliteBackend } from "./sqlite.ts";
export { inspectPostgres, postgresBackend } from "./postgres.ts";
export { filesBackend, verifyFiles } from "./files.ts";

export const STORE_BACKENDS: StoreBackend[] = [sqliteBackend, postgresBackend, filesBackend];

export class UnknownStoreError extends Error {}

/** Checks the store at `location` against a checked schema, with the named backend or the first that accepts it. */
export async function verifyStore(schema: CheckResult, location: string, backendName?: string): Promise<StoreDiagnostic[]> {
  const backend = backendName ? STORE_BACKENDS.find((b) => b.name === backendName) : STORE_BACKENDS.find((b) => b.accepts(location));
  if (!backend) {
    throw new UnknownStoreError(
      backendName
        ? `No store backend \`${backendName}\`; there are ${STORE_BACKENDS.map((b) => b.name).join(", ")}`
        : `Don't know how to read ${location}: expected a .sqlite3 file, a postgres:// URL, or a folder of data files`,
    );
  }
  return backend.verify(layoutOf(schema, { store: backend.layout }), location);
}
