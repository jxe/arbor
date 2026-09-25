import { rowPathSegment, type JSONValue } from "@overstory/protocol";
import type { ChildNameRule } from "./compile.ts";

/** Names that select a directory's representation and never name a row. */
export const RESERVED_CHILD_NAMES: ReadonlySet<string> = new Set([
  "_index.md", "schema.cddl", "_store.csv", "_store.json", "_store.jsonl",
  "_store.sqlite3", "_store.yaml",
]);

/** A row's logical child name from its validated properties and stable key. */
export function logicalChildName(
  schema: { childName: ChildNameRule },
  properties: Readonly<Record<string, JSONValue>>,
  stableKey: string,
): string {
  if (schema.childName.from === "primaryKey") return rowPathSegment(stableKey);
  const value = properties[schema.childName.property];
  if (typeof value !== "string" || !value || value !== value.normalize("NFC")
    || value === "." || value === ".." || /[\\/\0]/.test(value)
    || value.startsWith("~row-") || RESERVED_CHILD_NAMES.has(value)) {
    throw new Error(`childName property ${schema.childName.property} is not a valid logical name`);
  }
  return value;
}
