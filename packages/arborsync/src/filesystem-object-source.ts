import { readFile } from "node:fs/promises";
import { snapshotDirectory, type DescribeSnapshotCollectionFile, type SnapshotObjectIndex } from "@arbor/fs";
import { ObjectIndex } from "@arbor/stores";
import { hashObject, type ObjectHash } from "@arbor/wire";

export interface FilesystemObjectScope {
  boundaries: ReadonlyMap<string, string>;
  exclusions: readonly string[];
  describe?: DescribeSnapshotCollectionFile;
}

/** Indexed access to existing filesystem bytes. Owns no replica, network or retained file copies. */
export class FilesystemObjectSource implements AsyncDisposable {
  private readonly rows: ObjectIndex;
  private audit?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(readonly root: string, databasePath: string, private readonly options: {
    exclusions: () => readonly string[];
    changed: (absolute: string) => void;
    revalidationMs: number;
  }) {
    this.rows = new ObjectIndex(databasePath);
    if (options.revalidationMs > 0) {
      this.timer = setInterval(() => { void this.revalidate().catch(() => {}); }, options.revalidationMs);
      this.timer.unref?.();
    }
  }

  index(): SnapshotObjectIndex {
    return {
      fileHash: (path, info) => this.rows.objectRow(path, info)?.hash,
      remember: (path, kind, info, hash) => this.rows.rememberObject(path, kind, info, hash),
    };
  }

  invalidate(paths: readonly string[]): void {
    for (const path of paths) this.rows.forgetObject(path);
  }

  async bytes(hash: ObjectHash, scope: FilesystemObjectScope): Promise<Uint8Array | undefined> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = this.rows.lookupHash(hash);
      if (!row) return undefined;
      const bytes = row.kind === "file"
        ? await readFile(row.path).catch(() => undefined)
        : await this.directoryBytes(row.path, hash, scope);
      if (bytes && hashObject(bytes) === hash) return bytes;
      this.rows.forgetObject(row.path);
    }
    return undefined;
  }

  private async directoryBytes(path: string, expected: ObjectHash, scope: FilesystemObjectScope): Promise<Uint8Array | undefined> {
    const cached: SnapshotObjectIndex = {
      ...this.index(),
      directoryHash: (absolute) => {
        const row = this.rows.storedObjectHash(absolute);
        return row?.kind === "directory" ? row.hash : undefined;
      },
    };
    // Verify a shallow reconstruction first; a real walk repairs stale child rows.
    for (const index of [cached, this.index()]) {
      try {
        const snapshot = await snapshotDirectory(path, scope.boundaries, scope.exclusions, scope.describe, index);
        if (snapshot.root === expected) return await snapshot.objects.get(snapshot.root)!.bytes();
      } catch { return undefined; }
    }
    return undefined;
  }

  /** Coalesce uncached audits; report changed file rows and prune vanished files. */
  revalidate(): Promise<void> {
    return this.audit ??= (async () => {
      const audited = new Set<string>();
      const index: SnapshotObjectIndex = {
        fileHash: () => undefined,
        remember: (path, kind, info, hash) => {
          if (kind !== "file") return;
          audited.add(path);
          const stored = this.rows.storedObjectHash(path);
          if (stored?.kind === "file" && stored.hash !== hash) this.options.changed(path);
          this.rows.rememberObject(path, "file", info, hash);
        },
      };
      // Boundaries affect directory encodings, not the file rows audited here.
      await snapshotDirectory(this.root, new Map(), this.options.exclusions(), undefined, index);
      for (const path of this.rows.storedObjectPaths("file")) {
        if (!audited.has(path)) this.rows.forgetObject(path);
      }
    })().finally(() => { this.audit = undefined; });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.audit) await this.audit.catch(() => {});
    this.rows.close();
  }
}
