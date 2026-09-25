import { AsyncLocalStorage } from "node:async_hooks";
import { objectReadError, type ObjectReadReporter } from "./object-read-diagnostics.ts";
import { readFile } from "node:fs/promises";
import {
  loadIgnorePolicy,
  membershipSkip,
  snapshotDirectory,
  trackedEntries,
  type DescribeSnapshotCollectionFile,
  type SkipPath,
  type SnapshotObjectIndex,
  type TrackedLookup,
} from "@overstory/fs";
import { toTreePath } from "@overstory/protocol/path";
import { ObjectIndex } from "./state/index.ts";
import { hashObject, type ObjectHash } from "@overstory/protocol";

/** A root whose entries stay synchronized where an ignore rule matches them, and how to read its directories. */
export interface TrackedRoot {
  root: ObjectHash;
  load: (hash: ObjectHash) => Promise<Uint8Array>;
}

const trackedLookups = new AsyncLocalStorage<true>();

/**
 * Read objects on behalf of a tracked-path lookup. A directory rebuilt from
 * disk inside it never consults tracked paths itself, so a lookup that reads
 * the folder's own directories cannot recurse into another lookup.
 */
export function forTrackedLookup<T>(run: () => Promise<T>): Promise<T> {
  return trackedLookups.run(true, run);
}

const EVERY_PATH_TRACKED: TrackedLookup = async () => true;

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
  private tracked?: () => Promise<TrackedRoot | null>;

  constructor(readonly root: string, databasePath: string, private readonly options: {
    exclusions: () => readonly string[];
    changed: (absolute: string) => void;
    revalidationMs: number;
    report?: ObjectReadReporter;
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

  /** Drop directory rows at and beneath `absolute`: their encodings followed rules that changed. */
  invalidateDirectories(absolute: string): void {
    this.rows.forgetDirectoriesBeneath(absolute);
  }

  /** Where the folder's tracked root comes from; without one, every ignored path is left out. */
  setTracked(tracked: (() => Promise<TrackedRoot | null>) | undefined): void {
    this.tracked = tracked;
  }

  /** The folder's tracked paths now, or none when they cannot be read. */
  private async trackedLookup(): Promise<TrackedLookup | null> {
    const tracked = await this.tracked?.().catch(() => null);
    return tracked ? trackedEntries(tracked.root, tracked.load) : null;
  }

  /** The folder's membership for a walk of `absolute`, as the folder scan decides it. */
  private async skip(absolute: string, exclusions: readonly string[], tracked: TrackedLookup | null): Promise<SkipPath> {
    const policy = await loadIgnorePolicy(this.root, { excludedRoots: exclusions });
    return membershipSkip(policy, tracked, toTreePath(this.root, absolute));
  }

  async bytes(hash: ObjectHash, scope: FilesystemObjectScope): Promise<Uint8Array | undefined> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = this.rows.lookupHash(hash);
      if (!row) {
        this.options.report?.({ source: "filesystem", reason: "missing", hash });
        return undefined;
      }
      const bytes = row.kind === "file"
        ? await readFile(row.path).catch((error) => {
          this.options.report?.(objectReadError({ source: "filesystem", hash, path: row.path }, error));
          return undefined;
        })
        : await this.directoryBytes(row.path, hash, scope);
      if (bytes && hashObject(bytes) === hash) return bytes;
      // Inside a tracked lookup a directory that does not rebuild from rows is not stale, only unknown here.
      if (!bytes && row.kind === "directory" && trackedLookups.getStore()) return undefined;
      if (bytes) this.options.report?.({ source: "filesystem", reason: "hash-mismatch", hash, path: row.path });
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
    // Inside a tracked lookup the tracked set is unknown: try the two
    // encodings it can take here (no ignored path tracked, every one tracked)
    // from the rows alone; the caller falls back to other sources.
    const lookup = trackedLookups.getStore();
    const attempts: Array<{ tracked: TrackedLookup | null; index: SnapshotObjectIndex }> = lookup
      ? [{ tracked: null, index: cached }, { tracked: EVERY_PATH_TRACKED, index: cached }]
      : await this.trackedLookup().then((tracked) => [{ tracked, index: cached }, { tracked, index: this.index() }]);
    // Verify a shallow reconstruction first; a real walk repairs stale child rows.
    for (const { tracked, index } of attempts) {
      try {
        const skip = await this.skip(path, scope.exclusions, tracked);
        const snapshot = await snapshotDirectory(path, scope.boundaries, scope.exclusions, scope.describe, index, skip);
        if (snapshot.root === expected) return await snapshot.objects.get(snapshot.root)!.bytes();
      } catch (error) {
        this.options.report?.(objectReadError({ source: "filesystem", hash: expected, path }, error));
        return undefined;
      }
    }
    if (lookup) return undefined;
    this.options.report?.({ source: "filesystem", reason: "hash-mismatch", hash: expected, path });
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
      const exclusions = this.options.exclusions();
      const skip = await this.skip(this.root, exclusions, await this.trackedLookup());
      await snapshotDirectory(this.root, new Map(), exclusions, undefined, index, skip);
      for (const path of this.rows.storedObjectPaths("file")) {
        if (!audited.has(path)) this.rows.forgetObject(path);
      }
    })().catch((error) => {
      this.options.report?.(objectReadError({ source: "filesystem", path: this.root }, error));
      throw error;
    }).finally(() => { this.audit = undefined; });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.audit) await this.audit.catch(() => {});
    this.rows.close();
  }
}
