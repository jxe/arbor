// Protocol 003's object rewrite: every tree's head in the new format, as one
// fresh first accepted update, with its older history dropped (Joe,
// 2026-11-11). It runs before the batch's SQL steps, since object reads are
// async; step 034 records what it planned.
//
// For each tree:
// - entry times come from accepted history, as the Protocol 002 index computed
//   them: an entry's `modified` is when its current object first appeared at
//   its path, its `created` when its path last started holding something; a
//   move (the same object removed and added in one update) and a file↔page
//   conversion keep both. A tree's first retained update dates its entries
//   from `document_versions` and `entry_metadata` where those are earlier,
//   since migration 016 squashed older history into it;
// - every Markdown file that reads as a page becomes that page (outside a
//   collection's folder, as the host's conversion did), and a `.mdx` page
//   becomes its canonical file (Apps 011);
// - a collection's rows get Unix-ms times and tagged Date fields;
// - its profile facts are read again from the new root.
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { ObjectStore } from "@ovst/object-store";
import { compileLogicalSchema, encodeCollection } from "@ovst/collection-schema";
import { LOG_ENTRY_FORMAT, validatedLogEntry } from "@ovst/merge-protocol";
import {
  canonicalPageFile, decodeProtocolPage, decodeProtocolTable, encodeProtocolDirectory, encodeProtocolPage, hashObject,
  isPageName, parsePage, readRootProfile, type CollectionReference, type ObjectHash, type ProtocolDirectoryEntry,
} from "@ovst/protocol";
import { decodeCBOR } from "@ovst/protocol/cbor";
import { storedProfileOf, type StoredProfile } from "../../src/profile.ts";

/** The `change` of every migrated tree's first entry, and its `change_id`. */
export const MIGRATION_CHANGE = "protocol-003";

type Kind = "file" | "page";
type LegacyEntry = { name: string; file?: ObjectHash; page?: ObjectHash; directory?: ObjectHash; tree?: string };
interface LegacyDirectory { entries: LegacyEntry[]; collection?: { version: 1; modelFingerprint: ObjectHash; tables: Array<{ model: string; table: ObjectHash }> } }
interface Held { hash: ObjectHash; kind: Kind; created: number; modified: number }

export interface TreePlan {
  tree: string;
  /** The head the tree had, and the update that accepted it. */
  from: { update: number; root: ObjectHash };
  root: ObjectHash;
  entry: ObjectHash;
  acceptedAt: number;
  profile: StoredProfile | null;
}

export interface Protocol003Report {
  trees: number;
  droppedUpdates: number;
  converted: { pages: number; mdx: number; collections: number };
  /** Trees whose head had decisions open: the fresh entry has none. */
  conflicted: string[];
  /** Entries no history dated, given their tree's head time. */
  undated: string[];
}

/** A directory as the data before the flag day holds it: no entry times. */
function legacyDirectory(bytes: Uint8Array): LegacyDirectory {
  const value = decodeCBOR(bytes) as { type?: unknown; entries?: unknown; collection?: LegacyDirectory["collection"] };
  if (value?.type !== "directory" || !Array.isArray(value.entries)) throw new Error("Not a directory object");
  for (const entry of value.entries) {
    if (!entry || typeof entry !== "object" || typeof (entry as LegacyEntry).name !== "string") throw new Error("Invalid directory entry");
    if ("created" in entry || "modified" in entry) throw new Error("A directory already carries entry times");
  }
  return { entries: value.entries as LegacyEntry[], ...(value.collection ? { collection: value.collection } : {}) };
}

const content = (entry: LegacyEntry | undefined): { hash: ObjectHash; kind: Kind } | null =>
  entry?.file ? { hash: entry.file, kind: "file" } : entry?.page ? { hash: entry.page, kind: "page" } : null;

class Objects {
  private readonly directories = new Map<ObjectHash, LegacyDirectory>();
  constructor(private readonly store: ObjectStore, readonly written = new Map<ObjectHash, Uint8Array>()) {}
  async bytes(hash: ObjectHash): Promise<Uint8Array> {
    return this.written.get(hash) ?? await this.store.read(hash);
  }
  async directory(hash: ObjectHash): Promise<LegacyDirectory> {
    let directory = this.directories.get(hash);
    if (!directory) {
      directory = legacyDirectory(await this.store.read(hash));
      // Consecutive roots share most directories; one tree's are few enough to keep.
      this.directories.set(hash, directory);
    }
    return directory;
  }
  put(bytes: Uint8Array): ObjectHash {
    const hash = hashObject(bytes);
    this.written.set(hash, bytes);
    return hash;
  }
}

/** The content entries that differ between two roots, by path: what each path
 * holds after (null when removed), skipping identical subtrees and nested trees. */
async function diff(objects: Objects, before: ObjectHash | null, after: ObjectHash): Promise<Map<string, { hash: ObjectHash; kind: Kind } | null>> {
  const changes = new Map<string, { hash: ObjectHash; kind: Kind } | null>();
  const walk = async (left: ObjectHash | null, right: ObjectHash | null, path: string): Promise<void> => {
    if (left === right) return;
    const a = new Map((left ? (await objects.directory(left)).entries : []).map((entry) => [entry.name, entry]));
    const b = new Map((right ? (await objects.directory(right)).entries : []).map((entry) => [entry.name, entry]));
    for (const name of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(name), y = b.get(name), at = `${path}/${name}`;
      if (x?.directory !== y?.directory) await walk(x?.directory ?? null, y?.directory ?? null, at);
      const was = content(x), now = content(y);
      if (was?.hash === now?.hash && was?.kind === now?.kind) continue;
      if (now) changes.set(at, now);
      else if (was) changes.set(at, null);
    }
  };
  await walk(before, after, "");
  return changes;
}

/** Earlier times for a first retained root's entries: by path and object
 * (`modified`), and by path (`created`). */
async function seeds(db: Database, objects: Objects, tree: string, first: ObjectHash, head: ObjectHash) {
  const modified = new Map<string, number>(), created = new Map<string, number>();
  const lower = (map: Map<string, number>, key: string, at: number) => {
    const was = map.get(key);
    if (was === undefined || at < was) map.set(key, at);
  };
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  if (tables.has("document_versions")) {
    for (const row of db.query(`SELECT entry_path, content_hash, MIN(accepted_at) AS at FROM document_versions WHERE tree_id = ? GROUP BY entry_path, content_hash`)
      .all(tree) as Array<{ entry_path: string; content_hash: string; at: number }>) {
      lower(modified, `${row.entry_path}\0${row.content_hash}`, row.at);
      lower(created, row.entry_path, row.at);
    }
  }
  if (tables.has("entry_metadata")) {
    const metadata = new Map((db.query("SELECT path, modified_at FROM entry_metadata WHERE tree_id = ?").all(tree) as Array<{ path: string; modified_at: number }>)
      .map((row) => [row.path, row.modified_at]));
    if (metadata.size) {
      const atFirst = await diff(objects, null, first);
      for (const [path, now] of await diff(objects, null, head)) {
        const at = metadata.get(path);
        if (at !== undefined && now && atFirst.get(path)?.hash === now.hash) {
          lower(modified, `${path}\0${now.hash}`, at);
          lower(created, path, at);
        }
      }
    }
  }
  return { modified, created };
}

/** Every content entry's times at the head, from the tree's accepted history. */
async function entryTimes(db: Database, objects: Objects, tree: string, head: ObjectHash): Promise<Map<string, Held>> {
  const rows = db.query(`
    SELECT u.ordinal, u.root, u.accepted_at, p.root AS previous_root
    FROM accepted_updates u LEFT JOIN accepted_updates p ON p.ordinal = u.previous_ordinal
    WHERE u.tree_id = ? ORDER BY u.ordinal`).all(tree) as Array<{ ordinal: number; root: ObjectHash; accepted_at: number; previous_root: ObjectHash | null }>;
  const held = new Map<string, Held>();
  let previous: ObjectHash | null = null;
  for (const row of rows) {
    // History is one chain; a first retained update starts it again from nothing.
    const basis = row.previous_root;
    if (basis !== previous) throw new Error(`${tree}: update ${row.ordinal} does not follow the one before it`);
    const changes = await diff(objects, basis, row.root);
    const seeded = basis === null ? await seeds(db, objects, tree, row.root, head) : null;
    if (basis === null) held.clear();
    // A move keeps its times: the same object leaving one path and arriving at another.
    const left = new Map<string, Held>();
    for (const [path, now] of changes) {
      const was = held.get(path);
      if (!now && was) {
        left.set(`${was.kind}\0${was.hash}`, was);
        held.delete(path);
      }
    }
    for (const [path, now] of changes) {
      if (!now) continue;
      const was = held.get(path);
      let at = row.accepted_at;
      if (was) {
        // A kind change alone is a conversion, not new content.
        held.set(path, was.kind !== now.kind ? { ...now, created: was.created, modified: was.modified } : { ...now, created: was.created, modified: at });
        continue;
      }
      const moved = left.get(`${now.kind}\0${now.hash}`);
      if (moved) {
        held.set(path, { ...now, created: moved.created, modified: moved.modified });
        continue;
      }
      let created = at;
      if (seeded) {
        at = Math.min(at, seeded.modified.get(`${path}\0${now.hash}`) ?? at);
        created = Math.min(at, seeded.created.get(path) ?? at);
      }
      held.set(path, { ...now, created, modified: at });
    }
    previous = row.root;
  }
  if (previous !== head) throw new Error(`${tree}: its last accepted update is not its head`);
  return held;
}

/** Legacy rows: RFC 3339 times and untagged dates, as the rows objects before the flag day hold them. */
async function legacyRows(objects: Objects, table: ObjectHash) {
  const rows: Array<{ key: [string, unknown][]; fields: Record<string, unknown>; created: number; modified: number }> = [];
  for (const { chunk } of decodeProtocolTable(await objects.bytes(table)).chunks) {
    const value = decodeCBOR(await objects.bytes(chunk)) as { type?: unknown; rows?: unknown };
    if (value?.type !== "rows" || !Array.isArray(value.rows)) throw new Error(`${chunk} is not a rows object`);
    for (const row of value.rows as Array<{ key: [string, unknown][]; fields: Record<string, unknown>; created: unknown; modified: unknown }>) {
      const time = (text: unknown) => {
        const ms = typeof text === "string" ? Date.parse(text) : Number.NaN;
        if (!Number.isSafeInteger(ms)) throw new Error(`A row time ${JSON.stringify(text)} is not RFC 3339`);
        return ms;
      };
      rows.push({ key: row.key, fields: row.fields, created: time(row.created), modified: time(row.modified) });
    }
  }
  return rows;
}

/** The head in the new format. */
async function rewrite(objects: Objects, tree: string, head: ObjectHash, held: Map<string, Held>, fallback: number, report: Protocol003Report): Promise<ObjectHash> {
  const visit = async (hash: ObjectHash, path: string): Promise<ObjectHash> => {
    const directory = await objects.directory(hash);
    const entries: ProtocolDirectoryEntry[] = [];
    for (const entry of directory.entries) {
      const at = `${path}/${entry.name}`;
      if (entry.directory) { entries.push({ name: entry.name, directory: await visit(entry.directory, at) }); continue; }
      if (entry.tree) { entries.push({ name: entry.name, tree: entry.tree }); continue; }
      let times = held.get(at);
      if (!times) {
        report.undated.push(`${tree}:${at}`);
        times = { ...content(entry)!, created: fallback, modified: fallback };
      }
      const stamp = { created: times.created, modified: times.modified };
      if (entry.file && isPageName(entry.name) && !directory.collection) {
        const page = parsePage(await objects.bytes(entry.file));
        if (page) {
          report.converted.pages++;
          entries.push({ name: entry.name, page: objects.put(encodeProtocolPage(page)), ...stamp });
          continue;
        }
      }
      if (entry.page && !isPageName(entry.name)) {
        report.converted.mdx++;
        entries.push({ name: entry.name, file: objects.put(canonicalPageFile(decodeProtocolPage(await objects.bytes(entry.page)))), ...stamp });
        continue;
      }
      entries.push(entry.file ? { name: entry.name, file: entry.file, ...stamp } : { name: entry.name, page: entry.page!, ...stamp });
    }
    let collection: CollectionReference | undefined;
    if (directory.collection) {
      const source = directory.entries.find((entry) => entry.name === "schema.usl")?.file;
      if (!source) throw new Error(`${tree}:${path || "/"}: a collection without a schema.usl file`);
      const schema = compileLogicalSchema(await objects.bytes(source));
      const tables: Record<string, Awaited<ReturnType<typeof legacyRows>>> = {};
      for (const { model, table } of directory.collection.tables) tables[model] = await legacyRows(objects, table);
      const encoded = encodeCollection(schema, tables as Parameters<typeof encodeCollection>[1]);
      for (const [object, bytes] of encoded.objects) objects.written.set(object, bytes);
      collection = encoded.reference;
      report.converted.collections++;
    }
    return objects.put(encodeProtocolDirectory({ type: "directory", entries, ...(collection ? { collection } : {}) }));
  };
  return visit(head, "");
}

/**
 * Write every tree's new head and first log entry to the object store, one
 * durable append per tree, and return what step 034 records. Nothing names
 * the new objects until that step commits, so running this again (after a
 * failure) is safe.
 */
export async function planProtocol003(dataRoot: string): Promise<{ plans: TreePlan[]; report: Protocol003Report }> {
  const root = resolve(dataRoot);
  const db = new Database(join(root, "overstoryd.sqlite3"), { readonly: true });
  const store = new ObjectStore(join(root, "objects"));
  const report: Protocol003Report = { trees: 0, droppedUpdates: 0, converted: { pages: 0, mdx: 0, collections: 0 }, conflicted: [], undated: [] };
  const plans: TreePlan[] = [];
  try {
    for (const { id: tree, ref } of db.query("SELECT id, ref FROM trees ORDER BY id").all() as Array<{ id: string; ref: ObjectHash }>) {
      const head = db.query("SELECT ordinal, root, accepted_at, conflicted FROM accepted_updates WHERE tree_id = ? ORDER BY ordinal DESC LIMIT 1")
        .get(tree) as { ordinal: number; root: ObjectHash; accepted_at: number; conflicted: number } | null;
      if (!head || head.root !== ref) throw new Error(`${tree}: its head ${ref} is not its last accepted update's root`);
      const objects = new Objects(store);
      const held = await entryTimes(db, objects, tree, ref);
      const newRoot = await rewrite(objects, tree, ref, held, head.accepted_at, report);
      let at = head.accepted_at;
      for (const { modified } of held.values()) at = Math.max(at, modified);
      const { bytes } = validatedLogEntry({
        format: LOG_ENTRY_FORMAT, tree, previous: null, root: newRoot, change: MIGRATION_CHANGE, at,
        trace: null, resolves: [], decisions: [],
      });
      const entry = objects.put(bytes);
      const profile = storedProfileOf(await readRootProfile(newRoot, (hash) => objects.bytes(hash)));
      await store.store([...objects.written].map(([hash, bytes]) => ({ hash, bytes })));
      if (head.conflicted) report.conflicted.push(tree);
      report.droppedUpdates += (db.query("SELECT COUNT(*) AS n FROM accepted_updates WHERE tree_id = ?").get(tree) as { n: number }).n;
      report.trees++;
      plans.push({ tree, from: { update: head.ordinal, root: ref }, root: newRoot, entry, acceptedAt: head.accepted_at, profile });
    }
  } finally {
    db.close();
  }
  return { plans, report };
}
