import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  decodeProvenanceRecord, encodeProvenance, entryProvenance, hashObject, readProvenance, rebindProvenance,
  type ObjectHash, type ProvenanceNode,
} from "@ovst/protocol";
import type { LogEntry } from "@ovst/merge-protocol";
import type { ObjectStore } from "@ovst/object-store";
import { Recent } from "../recent.ts";

const HASH = /^sha256:[a-f0-9]{64}$/;
/** How far behind a tree's head a backfill asks the merge sidecar again for
 * an answered entry's index, as far back as a question's basis may be.
 * Older answered entries are rebound, as snapshots are. */
export const PROVENANCE_ANSWER_WINDOW = 128;

export interface ComputedProvenance {
  root: ObjectHash;
  index: ProvenanceNode;
  records: Map<ObjectHash, Uint8Array>;
  /** Nodes this computation wrote, shared with later ones once stored. */
  nodes: Map<object, ObjectHash>;
}

/** An answered entry's index, asked again: the root record and the objects
 * it needs, and the root the answer reached. */
export type AskAgain = (hash: ObjectHash, entry: LogEntry) => Promise<{ provenance: ObjectHash; root: ObjectHash; objects: ReadonlyMap<ObjectHash, Uint8Array> } | null>;

/**
 * The provenance index beside accepted history
 * (docs/architecture/overstoryd/provenance-index.md): records in the object
 * store, and per entry a pointer file `provenance/v1/<hex 0..2>/<hex 2..64>`
 * holding its root record's hash. A cache: nothing accepted depends on it,
 * and any part of it may be absent.
 */
export class ProvenanceStore {
  private readonly indexes = new Recent<ProvenanceNode>(64);
  /** Nodes whose records this process stored, by identity. */
  private readonly written = new WeakMap<object, ObjectHash>();
  private readonly filling = new Map<ObjectHash, Promise<number>>();

  constructor(
    private readonly dataRoot: string,
    private readonly objects: ObjectStore,
    private readonly entryOf: (hash: ObjectHash) => Promise<LogEntry>,
  ) {}

  path(entry: ObjectHash): string {
    if (!HASH.test(entry)) throw new Error(`Invalid entry hash: ${entry}`);
    return join(this.dataRoot, "provenance", "v1", entry.slice(7, 9), entry.slice(9));
  }

  /** The root record an entry's pointer names; null when it has none. */
  async pointer(entry: ObjectHash): Promise<ObjectHash | null> {
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
      const index = await readProvenance(root, (hash) => this.objects.read(hash));
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
    let index: ProvenanceNode;
    if (entry.asked) {
      if (!answered) return null;
      index = await readProvenance(answered, load);
    } else if (entry.previous) {
      const previous = await this.index(entry.previous);
      if (!previous) return null;
      const prior = { index: previous, root: (await this.entryOf(entry.previous)).root };
      // A trace the index cannot follow is taken as the snapshot it made.
      index = await entryProvenance(prior, entry, load)
        .catch(() => rebindProvenance(prior.index, prior.root, entry.root, entry.change, load));
    } else index = await entryProvenance(null, entry, load);
    return this.encode(index);
  }

  private encode(index: ProvenanceNode): ComputedProvenance {
    const records = new Map<ObjectHash, Uint8Array>(), nodes = new Map<object, ObjectHash>();
    const root = encodeProvenance(index, (bytes) => {
      const hash = hashObject(bytes);
      records.set(hash, bytes);
      return hash;
    }, { get: (node) => this.written.get(node) ?? nodes.get(node), set: (node, hash) => nodes.set(node, hash) });
    return { root, index, records, nodes };
  }

  /** Record an entry's index once its records are stored: its pointer,
   * written atomically. */
  async publish(entry: ObjectHash, computed: ComputedProvenance): Promise<void> {
    for (const [node, hash] of computed.nodes) this.written.set(node, hash);
    this.indexes.set(entry, computed.index);
    const path = this.path(entry), temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, `${computed.root}\n`);
    await rename(temporary, path);
  }

  /** Compute every missing index up to `head`, from the nearest earlier entry
   * that has one: plain, property and snapshot entries here, an answered
   * entry within `PROVENANCE_ANSWER_WINDOW` of `head` by `askAgain`, an
   * older one (or one `askAgain` cannot answer) rebound as a snapshot.
   * Returns how many entries it indexed. Concurrent calls for one head share
   * a run. */
  fill(head: ObjectHash, askAgain?: AskAgain): Promise<number> {
    let run = this.filling.get(head);
    if (!run) {
      run = this.fillFrom(head, askAgain).finally(() => this.filling.delete(head));
      this.filling.set(head, run);
    }
    return run;
  }

  private async fillFrom(head: ObjectHash, askAgain?: AskAgain): Promise<number> {
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
    for (const [position, { hash, entry }] of chain.entries()) {
      let index: ProvenanceNode | null = null;
      if (entry.asked && previous) {
        const again = chain.length - position <= PROVENANCE_ANSWER_WINDOW && askAgain ? await askAgain(hash, entry).catch(() => null) : null;
        if (again) {
          const answered = await readProvenance(again.provenance, (h) => this.objects.load(h, again.objects));
          index = again.root === entry.root ? answered
            : await rebindProvenance(answered, again.root, entry.root, entry.change, (h) => this.objects.load(h, again.objects));
        } else index = await rebindProvenance(previous.index, previous.root, entry.root, entry.change, load);
      } else index = await entryProvenance(previous, entry, load).catch(async (error) => {
        // A trace the index cannot follow is taken as the snapshot it made.
        if (!previous) throw error;
        return rebindProvenance(previous.index, previous.root, entry.root, entry.change, load);
      });
      const computed = this.encode(index);
      await this.objects.store([...computed.records].map(([hash, bytes]) => ({ hash, bytes })));
      await this.publish(hash, computed);
      previous = { index, root: entry.root };
    }
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
