import { readFile } from "node:fs/promises";
import { pendingTreeUpdate } from "@arbor/canopy-client";
import { snapshotDirectory, type DescribeSnapshotCollectionFile, type SnapshotObjectIndex } from "@arbor/fs";
import { decodeObjectEnvelopes, encodeWireObject, hashObject, type ObjectHash, type WireClient } from "@arbor/wire";
import type { Workspace } from "./workspace.ts";

export const OBJECT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface TreeObjectCacheDeps {
  workspaceFor(tree: string): Promise<Workspace | undefined>;
  boundariesFor(workspace: Workspace): ReadonlyMap<string, string>;
  exclusionsFor(workspace: Workspace): readonly string[];
  /** The account client for a placed tree, or an anonymous client for `origin`. */
  clientFor(tree: string, origin?: string): Promise<WireClient | undefined>;
  /** Bounded bytes retained for fetched-through objects. */
  maxFetchedBytes?: number;
}

/** A small byte-bounded LRU keyed by object hash. */
class ByteLRU {
  private entries = new Map<ObjectHash, Uint8Array>();
  private held = 0;
  constructor(private readonly limit: number) {}

  get(hash: ObjectHash): Uint8Array | undefined {
    const bytes = this.entries.get(hash);
    if (!bytes) return undefined;
    this.entries.delete(hash);
    this.entries.set(hash, bytes);
    return bytes;
  }

  set(hash: ObjectHash, bytes: Uint8Array): void {
    if (bytes.byteLength > this.limit) return;
    const previous = this.entries.get(hash);
    if (previous) {
      this.held -= previous.byteLength;
      this.entries.delete(hash);
    }
    this.entries.set(hash, bytes);
    this.held += bytes.byteLength;
    for (const [oldest, old] of this.entries) {
      if (this.held <= this.limit) break;
      this.entries.delete(oldest);
      this.held -= old.byteLength;
    }
  }
}

/**
 * Serves tree objects by hash from, in order, the placed workspace's object
 * index (re-encoding the file or directory on disk), the stored pending
 * update body, and Canopy through the tree's account client. Every result is
 * hash-verified before it is returned, so a stale index row falls through
 * rather than serving wrong bytes.
 */
export class TreeObjectCache {
  private readonly fetched: ByteLRU;

  constructor(private readonly deps: TreeObjectCacheDeps) {
    this.fetched = new ByteLRU(deps.maxFetchedBytes ?? 64 * 1024 * 1024);
  }

  async bytes(tree: string, hash: ObjectHash, origin?: string): Promise<Uint8Array | undefined> {
    return await this.fromIndex(tree, hash)
      ?? await this.fromPending(tree, hash)
      ?? await this.fromCanopy(tree, hash, origin);
  }

  private async fromIndex(tree: string, hash: ObjectHash): Promise<Uint8Array | undefined> {
    const workspace = await this.deps.workspaceFor(tree).catch(() => undefined);
    if (!workspace) return undefined;
    const rows = workspace.objectRows();
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = rows.lookupHash(hash);
      if (!row) return undefined;
      const bytes = row.kind === "file"
        ? await this.encodeFile(row.path)
        : await this.encodeDirectory(workspace, row.path, hash);
      if (bytes && hashObject(bytes) === hash) return bytes;
      rows.forgetObject(row.path);
    }
    return undefined;
  }

  private async encodeFile(path: string): Promise<Uint8Array | undefined> {
    try {
      return encodeWireObject({ type: "file", bytes: await readFile(path) });
    } catch {
      return undefined;
    }
  }

  private async encodeDirectory(workspace: Workspace, path: string, expected: ObjectHash): Promise<Uint8Array | undefined> {
    const boundaries = this.deps.boundariesFor(workspace);
    const exclusions = this.deps.exclusionsFor(workspace);
    const describe: DescribeSnapshotCollectionFile = (directory, name) => workspace.describeWireCollectionFile(directory, name);
    const rows = workspace.objectRows();
    const cachedIndex: SnapshotObjectIndex = {
      ...workspace.objectIndex(),
      directoryHash: (absolute) => {
        const stored = rows.storedObjectHash(absolute);
        return stored?.kind === "directory" ? stored.hash : undefined;
      },
    };
    // First adopt child directory rows without recursing; if the produced
    // object does not verify, a real walk of the subtree repairs the rows.
    for (const index of [cachedIndex, workspace.objectIndex()]) {
      try {
        const snapshot = await snapshotDirectory(path, boundaries, exclusions, describe, index);
        if (snapshot.root === expected) return await snapshot.objects.get(snapshot.root)!.bytes();
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private async fromPending(tree: string, hash: ObjectHash): Promise<Uint8Array | undefined> {
    const pending = await pendingTreeUpdate(tree).catch(() => undefined);
    if (!pending) return undefined;
    const bodies = [pending, ...(pending.successors ?? [])];
    for (const body of bodies) {
      let envelopes: Array<{ hash: ObjectHash; bytes: Uint8Array }>;
      try { envelopes = decodeObjectEnvelopes(body.objects); } catch { continue; }
      const match = envelopes.find((object) => object.hash === hash);
      if (match && hashObject(match.bytes) === hash) return match.bytes;
    }
    return undefined;
  }

  private async fromCanopy(tree: string, hash: ObjectHash, origin?: string): Promise<Uint8Array | undefined> {
    const cached = this.fetched.get(hash);
    if (cached) return cached;
    const client = await this.deps.clientFor(tree, origin).catch(() => undefined);
    if (!client) return undefined;
    let bytes: Uint8Array;
    try { bytes = await client.object(tree, hash); } catch { return undefined; }
    if (hashObject(bytes) !== hash) return undefined;
    this.fetched.set(hash, bytes);
    return bytes;
  }
}
