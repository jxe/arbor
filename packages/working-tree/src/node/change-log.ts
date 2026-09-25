import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { decodeCandidateUpdateJSON, decodeTreeSnapshotJSON, encodeObjectEnvelopes, hashObject, type CandidateUpdateJSON, type TreeSnapshotJSON } from "@overstory/protocol";
import { equal, localChangeRequest, snapshotJSON, validateLocalChanges, type ChangeLogJournal, type ChangeLogObjectStore, type LocalChange,
  type StoredLocalChange, type StoredSnapshot } from "../local-change.ts";
import { publicationTip } from "../update-machine.ts";

interface JournalFingerprint { size: number; modified: number; inode: number }

const writers = new Map<string, Promise<unknown>>();
/** The durable log of a working tree's local changes (schema 4). One client
 * process owns a state directory; instances in that process serialize commits
 * to the same canonical path. The update coordinator publishes it. */
export class ChangeLog {
  readonly path: string;
  readonly objectsPath: string;
  private records?: LocalChange[];
  private fingerprint?: JournalFingerprint;
  private readonly objects = new Map<string, Uint8Array>();
  private readonly earlier: { path: string; objects: string };
  private adopted = false;
  constructor(readonly tree: string, stateRoot: string, private readonly platform?: ChangeLogObjectStore) {
    this.path = resolve(stateRoot, "sync", "change-log.json");
    this.objectsPath = resolve(stateRoot, "sync", "change-log-objects");
    this.earlier = { path: resolve(stateRoot, "sync", "source-admissions.json"), objects: resolve(stateRoot, "sync", "source-admission-objects") };
  }
  /** Move a journal written under its earlier name (the same schema) to the
   * change log's names once. Objects move first; the journal marks a complete move. */
  private async adoptEarlier(): Promise<void> {
    if (this.adopted) return;
    this.adopted = true;
    const exists = (path: string) => stat(path).then(() => true, () => false);
    if (await exists(this.path) || !await exists(this.earlier.path)) return;
    if (await exists(this.earlier.objects) && !await exists(this.objectsPath)) await rename(this.earlier.objects, this.objectsPath);
    await rename(this.earlier.path, this.path);
    const dir = await open(dirname(this.path), "r"); try { await dir.sync(); } finally { await dir.close(); }
  }
  /** Changes a request carries remain until settled; nothing else in the log changes. */
  async discard(changes: ReadonlySet<string>): Promise<void> {
    const previous = writers.get(this.path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await this.load();
      const removed = new Set(changes);
      for (const record of this.records!) if (record.basis.kind === "authored" && removed.has(record.basis.change)) removed.add(record.change);
      const retained = this.records!.filter(record => !removed.has(record.change));
      if (retained.length !== this.records!.length) await this.write(retained);
    });
    writers.set(this.path, next);
    try { await next; } finally { if (writers.get(this.path) === next) writers.delete(this.path); }
  }
  async retained(): Promise<LocalChange[]> {
    const fingerprint = await this.currentFingerprint();
    if (!this.records || !equal(fingerprint, this.fingerprint)) await this.load();
    return structuredClone(this.records!);
  }
  async retain(value: LocalChange | LocalChange[]): Promise<void> {
    const batch = structuredClone(Array.isArray(value) ? value : [value]);
    const previous = writers.get(this.path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const records = await this.retained();
      for (const record of batch) {
        const prior = records.find(r => r.change === record.change);
        if (prior && !equal(prior, record)) throw new Error("Authored identity was reused");
        if (!prior) records.push(record);
      }
      // Repeat the durable write on an exact retry: an earlier rename may have
      // succeeded before directory synchronization failed.
      validateLocalChanges(records, this.tree);
      await this.write(records);
    });
    writers.set(this.path, next);
    try { await next; } finally { if (writers.get(this.path) === next) writers.delete(this.path); }
  }
  /** Remove settled records unless a pending authored descendant still needs
   * them. The newest record per open document and its ancestry stay while the
   * tail is preserved; nothing else survives acceptance. */
  async compact(settled: ReadonlySet<string>, preservingSettledTail = true): Promise<boolean> {
    const previous = writers.get(this.path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await this.load();
      const records = this.records!;
      const required = new Set(records.filter(record => !settled.has(record.change)).map(record => record.change));
      if (preservingSettledTail && records.length) {
        required.add(records.at(-1)!.change);
        const documents = new Set<string>();
        for (const record of records.slice().reverse()) if (record.document && !documents.has(record.document.path)) {
          documents.add(record.document.path); required.add(record.change);
        }
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of records) if (required.has(record.change) && record.basis.kind === "authored" && !required.has(record.basis.change)) {
          required.add(record.basis.change); changed = true;
        }
      }
      const retained = records.filter(record => required.has(record.change));
      if (retained.length !== records.length) await this.write(retained);
      return retained.length === 0;
    });
    writers.set(this.path, next);
    try { return await next; } finally { if (writers.get(this.path) === next) writers.delete(this.path); }
  }
  async nextPublication(accepted: ReadonlySet<string>): Promise<string | undefined> {
    return publicationTip((await this.retained()).map(record => ({
      change: record.change, parent: record.basis.kind === "authored" ? record.basis.change : undefined,
    })), accepted);
  }
  async request(through: string, accepted: ReadonlySet<string> = new Set()): Promise<{ base: { root: string; update: string }; request: { base: string; updates: CandidateUpdateJSON[] } }> {
    return localChangeRequest(await this.retained(), through, accepted);
  }

  private async load(settled: ReadonlySet<string> = new Set()): Promise<void> {
    await this.adoptEarlier();
    let value: unknown;
    try { value = JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.records = []; this.fingerprint = undefined; return;
      }
      throw error;
    }
    const journal = value as Partial<ChangeLogJournal>;
    if (journal.schema !== 4 || journal.tree !== this.tree || !Array.isArray(journal.records)) throw new Error("Invalid change log journal");
    if (journal.records.length && journal.records.every(record => typeof record.change === "string" && settled.has(record.change))) {
      await this.write([]); return;
    }
    const hashes = new Set(journal.records.flatMap(record => [...record.graph.objects, ...record.candidate.objects, ...record.updateObjects]));
    await Promise.all([...hashes].map(async hash => {
      if (!this.objects.has(hash)) this.objects.set(hash, await this.objectBytes(hash));
    }));
    const records = journal.records.map(record => this.materialize(record));
    validateLocalChanges(records, this.tree);
    this.records = records;
    this.fingerprint = await this.currentFingerprint();
  }

  private async write(records: LocalChange[]): Promise<void> {
    const snapshots = records.flatMap(record => [decodeTreeSnapshotJSON(record.graph), decodeTreeSnapshotJSON(record.candidate)]);
    const presented = new Map<string, Uint8Array>();
    for (const snapshot of snapshots) for (const [hash, bytes] of snapshot.objects) {
      if (!this.platform) presented.set(hash, bytes);
      this.objects.set(hash, bytes);
    }
    // Update envelopes are exactly the objects introduced relative to each
    // graph. They remain queue-owned until the admission settles.
    for (const record of records) for (const object of decodeCandidateUpdateJSON(record.update).objects) {
      presented.set(object.hash, object.bytes);
    }
    await mkdir(this.objectsPath, { recursive: true, mode: 0o700 });
    await Promise.all([...presented].map(([hash, bytes]) => this.writeObject(hash, bytes)));
    const journal: ChangeLogJournal = { schema: 4, tree: this.tree, records: records.map(record => this.stored(record)) };
    const directory = dirname(this.path), temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(journal)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
      const dir = await open(directory, "r"); try { await dir.sync(); } finally { await dir.close(); }
      const parent = await open(dirname(directory), "r"); try { await parent.sync(); } finally { await parent.close(); }
    } finally { await rm(temporary, { force: true }); }
    const retained = new Set(journal.records.flatMap(record => [...record.graph.objects, ...record.candidate.objects, ...record.updateObjects]));
    for (const name of await readdir(this.objectsPath)) {
      const hash = `sha256:${name}`;
      if (/^[0-9a-f]{64}$/.test(name) && !retained.has(hash)) await rm(resolve(this.objectsPath, name), { force: true });
    }
    for (const hash of this.objects.keys()) if (!retained.has(hash)) this.objects.delete(hash);
    this.records = structuredClone(records);
    this.fingerprint = await this.currentFingerprint();
  }

  private stored(record: LocalChange): StoredLocalChange {
    const { graph, candidate, update, ...rest } = record;
    return { ...rest,
      graph: { root: graph.root, objects: graph.objects.map(object => object.hash).sort() },
      candidate: { root: candidate.root, objects: candidate.objects.map(object => object.hash).sort() },
      update: { ...update, objects: [] }, updateObjects: update.objects.map(object => object.hash).sort() };
  }

  private materialize(record: StoredLocalChange): LocalChange {
    const snapshot = (stored: StoredSnapshot): TreeSnapshotJSON => snapshotJSON({ root: stored.root,
      objects: new Map(stored.objects.map(hash => {
        const bytes = this.objects.get(hash); if (!bytes) throw new Error(`Missing change log object ${hash}`); return [hash, bytes];
      })) });
    const { updateObjects, ...stored } = record;
    const update = { ...stored.update, objects: encodeObjectEnvelopes(updateObjects.map(hash => {
      const bytes = this.objects.get(hash); if (!bytes) throw new Error(`Missing change log object ${hash}`); return [hash, bytes] as const;
    })) };
    return { ...stored, update, graph: snapshot(record.graph), candidate: snapshot(record.candidate) } as LocalChange;
  }

  private objectPath(hash: string): string {
    if (!/^sha256:[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid change log object hash");
    return resolve(this.objectsPath, hash.slice("sha256:".length));
  }
  private async readObject(hash: string): Promise<Uint8Array> {
    const bytes = new Uint8Array(await readFile(this.objectPath(hash)));
    if (hashObject(bytes) !== hash) throw new Error(`Change log object hash mismatch: ${hash}`);
    return bytes;
  }
  private async objectBytes(hash: string): Promise<Uint8Array> {
    try { return await this.readObject(hash); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !this.platform) throw error;
    }
    const bytes = await this.platform.bytes(hash);
    if (!bytes) throw new Error(`Missing change log object ${hash}`);
    if (hashObject(bytes) !== hash) throw new Error(`Change log object hash mismatch: ${hash}`);
    return bytes;
  }
  private async writeObject(hash: string, bytes: Uint8Array): Promise<void> {
    if (hashObject(bytes) !== hash) throw new Error(`Change log object hash mismatch: ${hash}`);
    const destination = this.objectPath(hash);
    try {
      const existing = await this.readObject(hash);
      if (!equal([...existing], [...bytes])) throw new Error(`Change log object changed: ${hash}`);
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, destination);
      const dir = await open(this.objectsPath, "r"); try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  private async currentFingerprint(): Promise<JournalFingerprint | undefined> {
    await this.adoptEarlier();
    try {
      const value = await stat(this.path);
      return { size: value.size, modified: value.mtimeMs, inode: Number(value.ino) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
}
