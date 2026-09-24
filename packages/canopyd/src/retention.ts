import type { Database } from "bun:sqlite";
import { decodeLogEntry, OBJECT_HASH, type LogEntry } from "@overstory/merge-protocol";
import type { ObjectStore } from "@overstory/object-store";
import { decodeProtocolDirectory, protocolEntryObject, type ObjectHash } from "@overstory/protocol";

/**
 * The one definition of which stored objects canopyd keeps. The integrity
 * audit verifies it and the object collector deletes only what lies outside
 * it, so the two can never disagree.
 *
 * Required: a missing object is corruption.
 * - every accepted row's root, and its log entry;
 * - every entry that chain reaches through `previous` and `asked.base`;
 * - each such entry's root, whole-root and entry alternatives (complete
 *   trees), and range alternatives and their `at` file (single objects);
 * - every `document_versions.content_hash` (per-document history keeps old
 *   bodies after their roots are gone).
 *
 * Pinned when present: what a sidecar reads to replay an entry's question
 * (`asked.candidate`, `asked.prefix` roots, trace frame roots, alternative
 * bindings), and any other hash-shaped string in an entry, such as one in
 * operations or the sidecar's evidence. Intermediate trace roots were never
 * uploaded, so absence is normal and only counted.
 */
export interface RetainedObjects {
  /** Every present object the definition names, with directory closures. */
  live: Set<ObjectHash>;
  /** Optional pins that are not stored. */
  absent: number;
  /** Accepted rows and log entries read. */
  rows: number;
  entries: number;
}

type Kind = "directory" | "file" | "unknown";
interface Pin { hash: ObjectHash; kind: Kind }

const HASH = OBJECT_HASH;

/** Walk the retained closure over one consistent read of the database. */
export async function retainedObjects(db: Database, objects: ObjectStore): Promise<RetainedObjects> {
  const { rows, versions } = db.transaction(() => ({
    rows: db.query("SELECT ordinal, root, entry FROM accepted_updates ORDER BY ordinal").all() as Array<{ ordinal: number; root: ObjectHash; entry: ObjectHash }>,
    versions: (db.query("SELECT DISTINCT content_hash FROM document_versions").all() as Array<{ content_hash: ObjectHash }>)
      .map(({ content_hash }) => content_hash),
  }))();
  const live = new Set<ObjectHash>();
  const required: Pin[] = [], optional: Pin[] = [];
  const entries = new Set<ObjectHash>();
  const pendingEntries: ObjectHash[] = [];
  const addEntry = (hash: ObjectHash | null | undefined) => {
    if (hash && !entries.has(hash)) { entries.add(hash); pendingEntries.push(hash); }
  };
  for (const row of rows) {
    required.push({ hash: row.root, kind: "directory" });
    addEntry(row.entry);
  }
  for (const hash of versions) required.push({ hash, kind: "file" });
  while (pendingEntries.length) {
    const hash = pendingEntries.pop()!;
    let entry: LogEntry;
    try { entry = decodeLogEntry(await objects.read(hash)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Retained history is missing log entry ${hash}`);
      throw error;
    }
    live.add(hash);
    addEntry(entry.previous);
    addEntry(entry.asked?.base);
    entryPins(entry, required, optional);
  }
  const walked = new Set<string>();
  // Required closures first: an optional walk that met a missing object must
  // not hide that object from a later required walk of the same directory.
  for (const pin of required) await mark(objects, pin, true, live, walked);
  let absent = 0;
  for (const pin of optional) if (!await mark(objects, pin, false, live, walked)) absent++;
  return { live, absent, rows: rows.length, entries: entries.size };
}

function entryPins(entry: LogEntry, required: Pin[], optional: Pin[]): void {
  const named = new Set<ObjectHash>([entry.previous, entry.asked?.base].filter((h): h is ObjectHash => !!h));
  const add = (list: Pin[], hash: ObjectHash | undefined, kind: Kind) => {
    if (!hash) return;
    named.add(hash);
    list.push({ hash, kind });
  };
  add(required, entry.root, "directory");
  for (const d of entry.decisions) {
    for (const a of d.alternatives) add(required, a.object, d.range ? "file" : "directory");
    add(required, d.at, "file");
  }
  const frames = (trace: LogEntry["trace"]) => {
    for (const frame of trace ?? []) { add(optional, frame.before, "directory"); add(optional, frame.after, "directory"); }
  };
  frames(entry.trace);
  const asked = entry.asked;
  if (asked) {
    add(optional, asked.candidate, "directory");
    for (const binding of asked.alternatives ?? []) add(optional, binding.value.object, binding.value.kind);
    for (const candidate of asked.prefix ?? []) {
      add(optional, candidate.root, "directory");
      frames(candidate.trace);
      for (const binding of candidate.alternatives ?? []) add(optional, binding.value.object, binding.value.kind);
    }
  }
  // Anything else hash-shaped (operation material, evidence) is kept too:
  // canopyd does not interpret it, so it cannot prove it unneeded.
  const scan = (value: unknown): void => {
    if (typeof value === "string") { if (HASH.test(value) && !named.has(value)) add(optional, value, "unknown"); }
    else if (Array.isArray(value)) for (const item of value) scan(item);
    else if (value && typeof value === "object") for (const item of Object.values(value)) scan(item);
  };
  scan(entry);
}

/** Mark `pin` and, for a directory, everything it reaches. Returns false when
 * an optional pin's own object is absent; a required pin's absence throws. */
async function mark(objects: ObjectStore, root: Pin, required: boolean, live: Set<ObjectHash>, walked: Set<string>): Promise<boolean> {
  const pending: Pin[] = [root];
  let present = true;
  while (pending.length) {
    const pin = pending.pop()!;
    // The same bytes may be a file in one root and a directory in another.
    const key = `${pin.kind}:${pin.hash}`;
    if (walked.has(key)) continue;
    const bytes = await objects.find(pin.hash);
    if (!bytes) {
      if (required) throw new Error(`Retained history is missing an object under ${root.hash}`);
      if (pin === root) present = false;
      continue;
    }
    walked.add(key);
    live.add(pin.hash);
    if (pin.kind === "file") continue;
    let directory: ReturnType<typeof decodeProtocolDirectory>;
    try { directory = decodeProtocolDirectory(bytes); }
    catch (error) {
      if (pin.kind === "directory") throw error;
      continue; // An unknown pin that is not a directory is a single object.
    }
    for (const entry of directory.entries) {
      const target = protocolEntryObject(entry);
      // Nested trees are retained by their own accepted rows.
      if (target) pending.push(target);
    }
  }
  return present;
}
