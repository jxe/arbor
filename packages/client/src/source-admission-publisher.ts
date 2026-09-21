import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeCandidateUpdateJSON, updateRequestDigests, verifyTreeSnapshotGraph,
  type CurrentTree, type TreeSnapshot, type WireClient, type CandidateUpdateJSON } from "@overstory/protocol";
import { SourceAdmissionQueue } from "./source-admission-queue.ts";

const publishers = new Map<string, Promise<unknown>>();

/** Publishes immutable admissions in journal order. The owning client must hold
 * exclusive process ownership of its state directory, as for SourceAdmissionQueue.
 * Materialization must durably install both the projection and accepted identity;
 * it must serialize with watch installation. No client-owned conflict is created.
 */
export class SourceAdmissionPublisher {
  readonly path: string;
  readonly attemptPath: string;
  constructor(readonly queue: SourceAdmissionQueue,
    private readonly transport: Pick<WireClient, "submitUpdates" | "descriptor" | "snapshot">,
    private readonly install: (current: CurrentTree, snapshot: TreeSnapshot) => Promise<void>) {
    this.path = join(dirname(queue.path), "source-settlements.json");
    this.attemptPath = join(dirname(queue.path), "source-attempt.json");
  }

  async pending(): Promise<string[]> {
    const settled = await this.settled();
    await this.queue.compact(new Set(settled), true);
    const records = await this.queue.retained();
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

  /** Batch one pending authored branch, freezing the exact request durably
   * before transmission. Admissions during the request form the next batch;
   * uncertain outcomes repeat the frozen body, including its accepted prefix.
   */
  async publishNext(): Promise<boolean> {
    const previous = publishers.get(this.path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.publish());
    publishers.set(this.path, next);
    try { return await next; } finally { if (publishers.get(this.path) === next) publishers.delete(this.path); }
  }

  private async publish(): Promise<boolean> {
    // Validate settlements even when retrying a persisted attempt.
    const settled = new Set(await this.settled());
    let frozen: { tree: string; request: { base: string; updates: CandidateUpdateJSON[] }; digests: string[] };
    try { frozen = JSON.parse(await readFile(this.attemptPath, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const change = await this.queue.nextPublication(settled);
      if (!change) return false;
      const prepared = await this.queue.request(change, settled);
      frozen = { tree: this.queue.tree, request: prepared.request, digests: updateRequestDigests(this.queue.tree, {
        base: prepared.request.base, updates: prepared.request.updates.map(update => decodeCandidateUpdateJSON(update)),
      }) };
      await this.writeJSON(this.attemptPath, frozen);
    }
    if (frozen?.tree !== this.queue.tree || !frozen.request?.base || !Array.isArray(frozen.request.updates) || !frozen.request.updates.length)
      throw new Error("Invalid source attempt");
    const request = { base: frozen.request.base, updates: frozen.request.updates.map(update => decodeCandidateUpdateJSON(update)) };
    const expected = updateRequestDigests(this.queue.tree, request);
    if (JSON.stringify(expected) !== JSON.stringify(frozen.digests)) throw new Error("Source attempt digest mismatch");
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
    await this.writeSettled(changes);
    await this.queue.compact(new Set(changes), true);
    const retained = new Set((await this.queue.retained()).map(record => record.change));
    await this.writeSettled(changes.filter(change => retained.has(change)));
    await rm(this.attemptPath);
    const directory = await open(dirname(this.path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  }

  private async writeSettled(changes: string[]): Promise<void> {
    await this.writeJSON(this.path, { tree: this.queue.tree, changes });
  }

  private async writeJSON(path: string, value: unknown): Promise<void> {
    const directory = dirname(path), temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
      const dir = await open(directory, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
}
