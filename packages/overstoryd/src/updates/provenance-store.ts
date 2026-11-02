import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeProvenanceRecord, encodeProvenance, entryProvenance, hashObject, readProvenance, rebindProvenance,
  type ObjectHash, type ProvenanceNode,
} from "@ovst/protocol";
import type { LogEntry } from "@ovst/merge-protocol";
import { HashPointers, type ObjectStore } from "@ovst/object-store";
import { Recent } from "../recent.ts";

const HASH = /^sha256:[a-f0-9]{64}$/;
/** Entries the backfill indexes per journal append. */
const FILL_BATCH = 64;
export interface ComputedProvenance {
  root: ObjectHash;
  index: ProvenanceNode;
  records: Map<ObjectHash, Uint8Array>;
  /** Nodes this computation wrote, shared with later ones once stored. */
  nodes: Map<object, ObjectHash>;
}

/**
 * The provenance index beside accepted history
 * (docs/architecture/overstoryd/provenance-index.md): records in the object
 * store, and per entry a row in `provenance/v1/pointers.sqlite3` naming its
 * root record (entries indexed before 2026-11-02 have a pointer file
 * `provenance/v1/<hex 0..2>/<hex 2..64>` instead). A cache: nothing accepted
 * depends on it, and any part of it may be absent.
 */
export class ProvenanceStore {
  private readonly indexes = new Recent<ProvenanceNode>(64);
  /** Nodes whose records this process stored, by identity. */
  private readonly written = new WeakMap<object, ObjectHash>();
  private readonly filling = new Map<ObjectHash, Promise<number>>();
  private readonly pointers: HashPointers;

  constructor(
    private readonly dataRoot: string,
    private readonly objects: ObjectStore,
    private readonly entryOf: (hash: ObjectHash) => Promise<LogEntry>,
  ) {
    this.pointers = new HashPointers(join(dataRoot, "provenance", "v1", "pointers.sqlite3"));
  }

  close(): void {
    this.pointers.close();
  }

  /** An entry's pointer file, as entries indexed before pointer rows have. */
  path(entry: ObjectHash): string {
    if (!HASH.test(entry)) throw new Error(`Invalid entry hash: ${entry}`);
    return join(this.dataRoot, "provenance", "v1", entry.slice(7, 9), entry.slice(9));
  }

  /** The root record an entry's pointer names; null when it has none. */
  async pointer(entry: ObjectHash): Promise<ObjectHash | null> {
    if (!HASH.test(entry)) throw new Error(`Invalid entry hash: ${entry}`);
    const row = this.pointers.get(entry);
    if (row) return row as ObjectHash;
    const text = await readFile(this.path(entry), "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    const hash = text?.trim();
    return hash && HASH.test(hash) ? hash as ObjectHash : null;
  }

  /** An entry's index; null when absent or unreadable. */
  async index(entry: ObjectHash): Promise<ProvenanceNode | null> {
    const cached = this.indexes.get(entry);
    if (cached) return cached;
    const root = await this.pointer(entry);
    if (!root) return null;
    try {
      const index = await readProvenance(root, (hash) => this.objects.read(hash), (node, hash) => this.written.set(node, hash));
      this.indexes.set(entry, index);
      return index;
    } catch {
      return null;
    }
  }

  /** The index of `entry`, to store in the entry's own batch: from its
   * answer's root record when answered, otherwise computed from the
   * previous entry's index. Null when the previous entry has none (a
   * backfill computes it later). `proposed` holds objects not yet stored. */
  async prepare(entry: LogEntry, answered: ObjectHash | undefined, proposed: ReadonlyMap<ObjectHash, Uint8Array>): Promise<ComputedProvenance | null> {
    const load = (hash: ObjectHash) => this.objects.load(hash, proposed);
    let index: ProvenanceNode, before: ProvenanceNode | undefined;
    if (entry.asked) {
      if (!answered) return null;
      // The answer's records arrive with its objects and are stored with
      // them, so nothing is encoded or hashed again: each node read is
      // remembered with its record, for later entries to share.
      const nodes = new Map<object, ObjectHash>();
      index = await readProvenance(answered, load, (node, hash) => nodes.set(node, hash));
      return { root: answered, index, records: new Map(), nodes };
    } else if (entry.previous) {
      const previous = await this.index(entry.previous);
      if (!previous) return null;
      const prior = { index: previous, root: (await this.entryOf(entry.previous)).root };
      before = previous;
      // A trace the index cannot follow is taken as the snapshot it made.
      index = await entryProvenance(prior, entry, load)
        .catch(() => rebindProvenance(prior.index, prior.root, entry.root, entry.change, load));
    } else index = await entryProvenance(null, entry, load);
    return this.encode(index, before);
  }

  /** `previous`, the index this one advanced, lets a changed file write
   * only the chunks its edit changed. */
  private encode(index: ProvenanceNode, previous?: ProvenanceNode): ComputedProvenance {
    const records = new Map<ObjectHash, Uint8Array>(), nodes = new Map<object, ObjectHash>();
    const root = encodeProvenance(index, (bytes) => {
      const hash = hashObject(bytes);
      records.set(hash, bytes);
      return hash;
    }, { get: (node) => this.written.get(node) ?? nodes.get(node), set: (node, hash) => nodes.set(node, hash) }, previous);
    return { root, index, records, nodes };
  }

  /** Record entries' indexes once their records are stored (with the entry,
   * in its journal append): one pointer row each, in one transaction and
   * never synced. A lost row is recomputed by the backfill. */
  publish(computed: Iterable<readonly [entry: ObjectHash, ComputedProvenance]>): void {
    const rows: Array<[ObjectHash, ObjectHash]> = [];
    for (const [entry, index] of computed) {
      for (const [node, hash] of index.nodes) this.written.set(node, hash);
      this.indexes.set(entry, index.index);
      rows.push([entry, index.root]);
    }
    this.pointers.set(rows);
  }

  /** Compute every missing index up to `head`, from the nearest earlier entry
   * that has one: plain, property and snapshot entries from their trace,
   * an answered entry rebound as a snapshot of its root. Never asks the
   * merge worker. Returns how many entries it indexed. Concurrent calls for one head share
   * a run. */
  fill(head: ObjectHash): Promise<number> {
    let run = this.filling.get(head);
    if (!run) {
      run = this.fillFrom(head).finally(() => this.filling.delete(head));
      this.filling.set(head, run);
    }
    return run;
  }

  private async fillFrom(head: ObjectHash): Promise<number> {
    const chain: Array<{ hash: ObjectHash; entry: LogEntry }> = [];
    let at: ObjectHash | null = head, previous: { index: ProvenanceNode; root: ObjectHash } | null = null;
    while (at) {
      const entry = await this.entryOf(at);
      const index = await this.index(at);
      if (index) { previous = { index, root: entry.root }; break; }
      chain.push({ hash: at, entry });
      at = entry.previous;
    }
    chain.reverse();
    const load = (hash: ObjectHash) => this.objects.read(hash);
    let batch: Array<[ObjectHash, ComputedProvenance]> = [];
    const flush = async () => {
      if (!batch.length) return;
      await this.objects.store(batch.flatMap(([, computed]) => [...computed.records].map(([hash, bytes]) => ({ hash, bytes }))));
      this.publish(batch);
      batch = [];
    };
    for (const { hash, entry } of chain) {
      let index: ProvenanceNode;
      if (entry.asked && previous) index = await rebindProvenance(previous.index, previous.root, entry.root, entry.change, load);
      else index = await entryProvenance(previous, entry, load).catch(async (error) => {
        // A trace the index cannot follow is taken as the snapshot it made.
        if (!previous) throw error;
        return rebindProvenance(previous.index, previous.root, entry.root, entry.change, load);
      });
      // Records are stored durably in batches, one journal append and one
      // sync per batch, and pointed to once stored.
      batch.push([hash, this.encode(index, previous?.index)]);
      if (batch.length >= FILL_BATCH) await flush();
      previous = { index, root: entry.root };
    }
    await flush();
    return chain.length;
  }

  /** Every record an index names, from its root record; absent records are
   * skipped (the index is a cache). */
  async records(root: ObjectHash, into: Set<ObjectHash>): Promise<void> {
    const pending = [root];
    while (pending.length) {
      const hash = pending.pop()!;
      if (into.has(hash)) continue;
      let bytes: Uint8Array;
      try { bytes = await this.objects.read(hash); }
      catch { continue; }
      into.add(hash);
      const record = decodeProvenanceRecord(bytes);
      if (record.kind === "directory") pending.push(...record.entries.map(([, child]) => child));
      else if (record.kind === "file" || record.kind === "page") pending.push(...record.chunks);
    }
  }
}
