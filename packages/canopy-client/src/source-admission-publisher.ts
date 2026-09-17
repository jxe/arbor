import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeCandidateUpdateJSON, updateRequestDigests, verifyTreeSnapshotGraph,
  type CurrentTree, type TreeSnapshot, type WireClient } from "@arbor/wire";
import { SourceAdmissionQueue } from "./source-admission-queue.ts";

const publishers = new Map<string, Promise<unknown>>();

/** Publishes immutable admissions in journal order. The owning client must hold
 * exclusive process ownership of its state directory, as for SourceAdmissionQueue.
 * Materialization must durably install both the projection and accepted identity;
 * it must serialize with watch installation. No client-owned conflict is created.
 */
export class SourceAdmissionPublisher {
  readonly path: string;
  constructor(readonly queue: SourceAdmissionQueue,
    private readonly transport: Pick<WireClient, "submitUpdates" | "descriptor" | "snapshot">,
    private readonly install: (current: CurrentTree, snapshot: TreeSnapshot) => Promise<void>) {
    this.path = join(dirname(queue.path), "source-settlements.json");
  }

  async pending(): Promise<string[]> {
    const records = await this.queue.retained();
    const settled = await this.settled();
    const known = new Set(records.map(record => record.change));
    if (settled.some(change => !known.has(change))) throw new Error("Settlement has no retained admission");
    return records.filter(record => !settled.includes(record.change)).map(record => record.change);
  }

  private async settled(): Promise<string[]> {
    let value: unknown;
    try { value = JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (!value || typeof value !== "object") throw new Error("Invalid source settlements");
    const state = value as { tree: unknown; changes: unknown };
    if (state.tree !== this.queue.tree || !Array.isArray(state.changes) ||
        state.changes.some(change => typeof change !== "string" || !change) ||
        new Set(state.changes).size !== state.changes.length) throw new Error("Invalid source settlements");
    return state.changes;
  }

  /** One admission per pass keeps newly admitted work independent of an in-flight
   * request. Uncertain outcomes repeat its original ancestry, including accepted
   * prefixes; a visible peer projection never becomes an authored basis.
   */
  async publishNext(): Promise<boolean> {
    const previous = publishers.get(this.path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.publish());
    publishers.set(this.path, next);
    try { return await next; } finally { if (publishers.get(this.path) === next) publishers.delete(this.path); }
  }

  private async publish(): Promise<boolean> {
    const change = (await this.pending())[0];
    if (!change) return false;
    const prepared = await this.queue.request(change);
    const request = { base: prepared.request.base, updates: prepared.request.updates.map(update => decodeCandidateUpdateJSON(update)) };
    const expected = updateRequestDigests(this.queue.tree, request);
    const response = await this.transport.submitUpdates(this.queue.tree, request);
    if (response.results.length !== expected.length || response.results.some((result, index) =>
      result.requestDigest !== expected[index] || result.update.tree !== this.queue.tree || !result.update.id)) {
      throw new Error("Source receipt does not match retained request");
    }
    // A replay receipt is historical. Always fetch the current descriptor and its
    // projection; settlement is independent of whether Canopy selected our bytes.
    const current = await this.transport.descriptor(this.queue.tree);
    if (current.tree.id !== this.queue.tree || !current.tree.update) throw new Error("Wrong source projection identity");
    const snapshot = await this.transport.snapshot(this.queue.tree, current.tree.root);
    if (snapshot.root !== current.tree.root) throw new Error("Wrong source projection root");
    verifyTreeSnapshotGraph(snapshot, "sparse-files");
    await this.install(current, snapshot);
    const changes = [...new Set([...(await this.settled()), ...request.updates.map(update => update.change)])];
    const directory = dirname(this.path), temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ tree: this.queue.tree, changes })); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
      const dir = await open(directory, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temporary, { force: true }); }
    return true;
  }
}
