import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { ObjectStore } from "@overstory/object-store";
import {
  compareProtocolNames,
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  hashObject,
  type InspectedDecision,
  type ObjectHash,
  type ProtocolDirectoryEntry,
} from "@overstory/protocol";
import { encodeLogEntry, LOG_ENTRY_FORMAT, type LogDecision, type LogEntry } from "@overstory/merge-protocol";
import { AcceptedUpdateStore } from "../../../../packages/canopyd/src/updates/store.ts";
import { assertCurrentHostSchema } from "../../../../packages/canopyd/src/schema.ts";

/** Schema 18 → 19: accepted history as log entries (canopyd 016).
 *
 * Every accepted row gets a log entry in the object store, written from the
 * row and its schema-18 merge-state record, and names it in a new
 * `accepted_updates.entry` column. A tree's entries chain in ordinal order:
 * the first retained row's entry has `previous: null`, every later row's
 * names its predecessor's. The record's decisions become the entry's, with
 * the same keys, so every public decision and alternative id is unchanged.
 * Then `accepted_merge_states` is dropped; nothing else changes.
 *
 * No merge worker runs: entries are written from what the records say. The
 * sidecar's retained states were never read again after this build and are
 * not converted; its cache starts cold and rebuilds from each chain's start.
 *
 * Order: stamp and `quick_check` → read-only checks and conversion (entry
 * and directory objects stored durably, before the transaction) → one
 * transaction (rebuild `accepted_updates`, drop `accepted_merge_states`,
 * stamp 19, `foreign_key_check`) → schema check. A crash before the
 * transaction leaves the database unchanged; the objects written before it
 * are unreferenced. A rerun reports `migrated: false`.
 */
export interface MigrationReport {
  migrated: boolean;
  from: string;
  /** Every tree's head, unchanged: `update` is its wire id, `entry` its new log entry. */
  trees: Array<{ id: string; root: string; update: string; entry?: string }>;
  updates: number;
  /** Entries written, those with a trace, and open decisions carried at heads. */
  entries: number;
  traced: number;
  openDecisions: number;
  /** Rows whose record's resolution declarations named no decision of their predecessor. */
  unmappedResolutions: number;
  nextOrdinal: number;
  ms: Record<string, number>;
}
type Log = (event: Record<string, unknown>) => void;

/** A schema-18 merge-state record, as far as this migration reads it. */
interface Record18 {
  decisions: Array<{ key: string; inspection: InspectedDecision }>;
  evidence: unknown;
  request: { change: string; candidate: ObjectHash; trace: LogEntry["trace"]; resolves: Array<{ state: string; conflict: string }> };
}
interface Row {
  ordinal: number;
  tree_id: string;
  root: ObjectHash;
  previous_ordinal: number | null;
  conflicted: number;
  record_json: string | null;
}

export class UnconvertibleHistoryError extends Error {}

export async function migrateLogEntries(root: string, log: Log = () => {}): Promise<MigrationReport> {
  const started = performance.now();
  const ms: Record<string, number> = {};
  const phase = (name: string, since: number) => { ms[name] = Math.round(performance.now() - since); };
  const objects = new ObjectStore(join(root, "objects"));
  const db = new Database(join(root, "canopy.sqlite3"), { readwrite: true, strict: true });
  try {
    const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
    const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    const sequence = () => (db.query("SELECT seq FROM sqlite_sequence WHERE name = 'accepted_updates'").get() as { seq: number } | null)?.seq ?? 0;
    const heads = (withEntry: boolean) => (db.query(`SELECT t.id, t.ref AS root, MAX(u.ordinal) AS ordinal FROM trees t JOIN accepted_updates u ON u.tree_id = t.id
        GROUP BY t.id ORDER BY t.id`).all() as Array<{ id: string; root: string; ordinal: number }>)
      .map(({ id, root, ordinal }) => ({ id, root, update: String(ordinal),
        ...(withEntry ? { entry: (db.query("SELECT entry FROM accepted_updates WHERE ordinal = ?").get(ordinal) as { entry: string }).entry } : {}) }));
    if (stamp === "19")
      return { migrated: false, from: stamp, trees: heads(true), updates: count("SELECT COUNT(*) AS n FROM accepted_updates"),
        entries: 0, traced: 0, openDecisions: 0, unmappedResolutions: 0, nextOrdinal: sequence() + 1, ms };
    if (stamp !== "18") throw new Error(`Migration 018 requires schema 18, found ${stamp}`);
    const check = db.query("PRAGMA quick_check").get() as { quick_check: string };
    if (check.quick_check !== "ok") throw new Error(`quick_check: ${check.quick_check}`);

    let since = performance.now();
    const rows = db.query(`SELECT u.ordinal, u.tree_id, u.root, u.previous_ordinal, u.conflicted, m.record_json
      FROM accepted_updates u LEFT JOIN accepted_merge_states m ON m.accepted_id = u.ordinal ORDER BY u.ordinal`).all() as Row[];
    for (const tree of heads(false)) {
      const head = rows.findLast((row) => row.tree_id === tree.id);
      if (!head || head.root !== tree.root) throw new Error(`Tree ${tree.id} ref does not match its newest accepted update`);
    }
    const records = new Map<number, Record18>();
    for (const row of rows) {
      if (!row.record_json) throw new UnconvertibleHistoryError(`Accepted update ${row.ordinal} has no merge state`);
      const record = JSON.parse(row.record_json) as Record18;
      if ((record.decisions.length > 0) !== Boolean(row.conflicted))
        throw new UnconvertibleHistoryError(`Accepted update ${row.ordinal}'s conflicted flag does not match its merge state`);
      records.set(row.ordinal, record);
    }

    // Tree reads and path-copying writes; new directories are stored with the entries.
    const staged = new Map<ObjectHash, Uint8Array>();
    const read = async (hash: ObjectHash) => staged.get(hash) ?? objects.read(hash);
    const at = async (root: ObjectHash, names: readonly string[]) => {
      let object = root;
      for (const [index, name] of names.entries()) {
        const entry = decodeProtocolDirectory(await read(object)).entries.find((e) => e.name === name);
        if (!entry || index === names.length - 1) return entry ?? null;
        if (!entry.directory) return null;
        object = entry.directory;
      }
      return null;
    };
    const withEntry = async (root: ObjectHash, names: readonly string[], entry: ProtocolDirectoryEntry | null): Promise<ObjectHash> => {
      const directory = decodeProtocolDirectory(await read(root));
      const [name, ...rest] = names as [string, ...string[]];
      const prior = directory.entries.find((e) => e.name === name);
      let next = entry;
      if (rest.length) {
        if (!prior?.directory) throw new UnconvertibleHistoryError(`A decision's folder is absent at ${names.join("/")}`);
        next = { ...prior, directory: await withEntry(prior.directory, rest, entry) };
      }
      directory.entries = [...directory.entries.filter((e) => e.name !== name), ...(next ? [next] : [])]
        .sort((a, b) => compareProtocolNames(a.name, b.name));
      const bytes = encodeProtocolDirectory(directory), hash = hashObject(bytes);
      staged.set(hash, bytes);
      return hash;
    };

    /** A schema-18 inspection as a log decision about the same entry, range or root. */
    const convert = async (rowRoot: ObjectHash, record: Record18, { key, inspection }: Record18["decisions"][number]): Promise<LogDecision> => {
      const keyOf = new Map(record.decisions.map((d) => [d.inspection.id, d.key]));
      const common = {
        key,
        dependencies: inspection.dependencies.map((id) => keyOf.get(id) ?? (() => { throw new UnconvertibleHistoryError(`Decision ${key} depends on an unknown decision`); })()),
        selected: inspection.alternatives.findIndex((a) => a.id === inspection.selected),
      };
      if (common.selected < 0) throw new UnconvertibleHistoryError(`Decision ${key} has no selected alternative`);
      const affected = inspection.affected[0]!;
      if (inspection.kind === "entry") {
        const name = inspection.alternatives.find((a) => a.placement)?.placement?.name;
        if (!name) throw new UnconvertibleHistoryError(`Entry decision ${key} names no entry`);
        const path = [...(affected.within ?? []), name];
        const alternatives = [];
        for (const a of inspection.alternatives) {
          const value = "file" in a.value ? { name, file: a.value.file } : "directory" in a.value ? { name, directory: a.value.directory } : "absent" in a.value ? null
            : (() => { throw new UnconvertibleHistoryError(`Entry decision ${key} has an unknown value`); })();
          alternatives.push({ object: await withEntry(rowRoot, path, value as ProtocolDirectoryEntry | null), contributions: a.contributions });
        }
        return { ...common, path, alternatives };
      }
      if (affected.material.kind !== "basis") throw new UnconvertibleHistoryError(`Decision ${key} is not placed in the tree`);
      const fragments = inspection.alternatives.map((a) => {
        if (!("file" in a.value) && !("directory" in a.value)) throw new UnconvertibleHistoryError(`Decision ${key} has an unknown value`);
        return { object: "file" in a.value ? a.value.file : a.value.directory, contributions: a.contributions };
      });
      const path = affected.material.path === "/" ? [] : affected.material.path.slice(1).split("/");
      if (inspection.kind === "directory" && !path.length && !affected.range) return { ...common, alternatives: fragments };
      if (affected.range && path.length) {
        const shown = (await at(rowRoot, path))?.file;
        return { ...common, path, range: affected.range, ...(shown === affected.material.object ? {} : { at: affected.material.object }), alternatives: fragments };
      }
      throw new UnconvertibleHistoryError(`Decision ${key} (${inspection.kind}) has no conversion`);
    };

    const entries = new Map<number, ObjectHash>();
    let traced = 0, unmappedResolutions = 0;
    for (const [index, row] of rows.entries()) {
      const record = records.get(row.ordinal)!;
      const previous = row.previous_ordinal === null ? null : records.get(row.previous_ordinal);
      const resolves: string[] = [];
      for (const declaration of record.request.resolves ?? []) {
        const key = previous?.decisions.find((d) => d.inspection.id === declaration.conflict)?.key;
        if (key) resolves.push(key); else unmappedResolutions++;
      }
      const entry: LogEntry = {
        format: LOG_ENTRY_FORMAT,
        tree: row.tree_id,
        previous: row.previous_ordinal === null ? null : entries.get(row.previous_ordinal)!,
        root: row.root,
        change: record.request.change,
        trace: record.request.trace,
        resolves,
        decisions: await Promise.all(record.decisions.map((d) => convert(row.root, record, d))),
        ...(record.evidence !== null && record.evidence !== undefined ? { evidence: record.evidence } : {}),
      };
      if (row.previous_ordinal !== null && !entries.has(row.previous_ordinal))
        throw new UnconvertibleHistoryError(`Accepted update ${row.ordinal}'s predecessor is not retained`);
      const bytes = encodeLogEntry(entry), hash = hashObject(bytes);
      staged.set(hash, bytes);
      entries.set(row.ordinal, hash);
      if (entry.trace) traced++;
      if ((index + 1) % 256 === 0) log({ event: "entries", done: index + 1, total: rows.length });
    }
    await objects.store([...staged].map(([hash, bytes]) => ({ hash, bytes })));
    phase("entries", since);

    since = performance.now();
    const nextOrdinal = sequence() + 1;
    db.run("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      AcceptedUpdateStore.createTable(db, "accepted_updates_next");
      const insert = db.prepare(`INSERT INTO accepted_updates_next (ordinal, tree_id, root, previous_ordinal, conflicted, accepted_at, subject, request_digest, change_id, entry)
        SELECT ordinal, tree_id, root, previous_ordinal, conflicted, accepted_at, subject, request_digest, change_id, ? FROM accepted_updates WHERE ordinal = ?`);
      for (const row of rows) insert.run(entries.get(row.ordinal)!, row.ordinal);
      db.run("DROP TABLE accepted_merge_states");
      db.run("DROP TABLE accepted_updates");
      db.run("ALTER TABLE accepted_updates_next RENAME TO accepted_updates");
      AcceptedUpdateStore.createSchema(db);
      db.run("DELETE FROM sqlite_sequence WHERE name IN ('accepted_updates', 'accepted_updates_next')");
      db.run("INSERT INTO sqlite_sequence (name, seq) VALUES ('accepted_updates', ?)", [nextOrdinal - 1]);
      db.run("UPDATE meta SET value = '19' WHERE key = 'schema_version'");
      const violations = db.query("PRAGMA foreign_key_check").all();
      if (violations.length) throw new Error(`foreign_key_check: ${JSON.stringify(violations.slice(0, 5))}`);
    })();
    db.run("PRAGMA foreign_keys = ON");
    phase("commit", since);
    assertCurrentHostSchema(db);
    ms.total = Math.round(performance.now() - started);
    const trees = heads(true);
    return {
      migrated: true,
      from: stamp,
      trees,
      updates: rows.length,
      entries: entries.size,
      traced,
      openDecisions: trees.reduce((n, tree) => n + records.get(Number(tree.update))!.decisions.length, 0),
      unmappedResolutions,
      nextOrdinal,
      ms,
    };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) { console.error("usage: run.ts <data-root>"); process.exit(2); }
  const report = await migrateLogEntries(resolve(root), (event) => console.error(JSON.stringify(event)));
  console.log(JSON.stringify(report));
}
