import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  arborPrivateRoot,
  decodeTreeSnapshotJSON,
  decodeProtocolDirectory,
  encodeCandidateUpdateJSON,
  hashObject,
  decodeBase64,
  transitionPayload,
  TreeReader,
  ProtocolError,
  protocolEntryObject,
  ProtocolClient,
  type LazyTreeSnapshot,
  type ObjectHash,
  type SharedTreePlacement,
  type TreeSnapshot,
  type LocalTreeDescriptor,
} from "@overstory/protocol";
import { materializeTree } from "@overstory/fs";
import {
  equal,
  localChangeRequest,
  snapshotJSON,
  UpdateCoordinator,
  UpdateValidationError,
  type AcceptedBase,
  type AcceptedSource,
  type AcceptedTree,
  type LocalChange,
  type LocalChangeBasis,
  type UpdateState,
  type UpdateTransport,
} from "@overstory/working-tree";
import { ChangeLog, FileControlStore } from "@overstory/working-tree/node";

/** What the daemon provides one folder's synchronization. */
export interface FolderSyncHost {
  placement(): SharedTreePlacement | undefined;
  client(placement: SharedTreePlacement): Promise<ProtocolClient>;
  updateSyncMetadata(placement: SharedTreePlacement): Promise<unknown>;
  setSyncState(state: NonNullable<LocalTreeDescriptor["sync"]>): void;
  /** Serialize this folder's filesystem reads and writes; never held across protocol I/O. */
  withWorkspaceIO<T>(run: () => Promise<T>): Promise<T>;
  /** Walk the folder into a lazy graph through its stat index. */
  scan(): Promise<LazyTreeSnapshot>;
  /** The folder's root on disk. */
  readonly root: string;
  excludedMounts(): readonly string[];
  /** Verified bytes by hash: the folder's index, then Canopy. */
  objectBytes(hash: ObjectHash): Promise<Uint8Array | undefined>;
  /** Accepted bytes were written to the folder. */
  materialized(): void;
}

/** Where one tree's change log, control record and folder record live. */
export function folderStateRoot(tree: string): string {
  return join(arborPrivateRoot(), "trees", Buffer.from(tree).toString("base64url"));
}

/** Bytes a pending local change in `log` carries, whole or as a delta. */
export async function pendingBytes(log: ChangeLog, hash: string): Promise<Uint8Array | undefined> {
  for (const record of await log.retained()) {
    const object = record.candidate.objects.find((object) => object.hash === hash);
    if (object) return decodeBase64(object.bytes);
  }
  return undefined;
}

/** The root the folder held when it was last written or scanned, and the log basis a change to it names. */
interface KnownFolder { root: string; basis: LocalChangeBasis }

const INITIAL_WATCH_BACKOFF_MS = 1_000;
const MAX_WATCH_BACKOFF_MS = 30_000;
const SCAN_DELAY_MS = 250;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Every hash reachable from `root` through the directories `objects` holds. */
function reachable(root: string, objects: ReadonlyMap<string, Uint8Array>): Set<string> {
  const seen = new Set<string>();
  const pending = [{ hash: root, kind: "directory" as "file" | "directory" }];
  for (let next = pending.pop(); next; next = pending.pop()) {
    if (seen.has(next.hash)) continue;
    seen.add(next.hash);
    if (next.kind !== "directory") continue;
    const bytes = objects.get(next.hash);
    if (!bytes) throw new Error(`Folder graph is missing directory ${next.hash}`);
    for (const entry of decodeProtocolDirectory(bytes).entries) {
      const child = protocolEntryObject(entry);
      if (child) pending.push(child);
    }
  }
  return seen;
}

/** The sync state a placement reports for a machine state. */
export function folderSyncState(state: UpdateState): NonNullable<LocalTreeDescriptor["sync"]> {
  switch (state.kind) {
    case "current": return "idle";
    case "offline": return state.availability.kind === "transport" ? "offline" : "error";
    case "held": return "conflict";
    case "terminal": return "error";
    default: return "syncing";
  }
}

/**
 * One placed folder on the update machine. The folder is the runner's
 * accepted tree and its only source: a watcher event schedules a scan, and a
 * scan whose root differs from what the folder last held appends a
 * `trace: null` change to the change log. Accepted bytes are written to the
 * folder only when no local change is pending and the folder still holds what
 * it last wrote or scanned (spec 09 rule 13); otherwise the accepted state is
 * recorded and the next scan publishes the folder against what it held.
 */
export class FolderSync implements AcceptedTree {
  readonly log: ChangeLog;
  readonly coordinator: UpdateCoordinator;
  private readonly knownPath: string;
  private known?: KnownFolder;
  private scanTimer?: ReturnType<typeof setTimeout>;
  private scanning?: Promise<void>;
  private rescan = false;
  private watch?: { abort: AbortController; done: Promise<void>; key: string };
  private closed = false;
  private readonly pausedPath: string;
  private paused: boolean;
  /** The change the last preview prepared; the next scan of the same folder sends exactly it. */
  private previewed?: LocalChange;

  constructor(readonly tree: string, stateRoot: string, private readonly host: FolderSyncHost, options: { pollIntervalMs?: number } = {}) {
    // Folder records are sparse (directories and new files), so the log keeps
    // every object it names rather than leaning on a folder that keeps changing.
    this.log = new ChangeLog(tree, stateRoot);
    this.knownPath = join(stateRoot, "sync", "folder.json");
    this.pausedPath = join(stateRoot, "sync", "paused.json");
    this.paused = existsSync(this.pausedPath);
    const transport: UpdateTransport = {
      submitUpdates: async (tree, request) => (await this.client()).submitUpdates(tree, request),
      descriptor: async (tree) => (await this.client()).descriptor(tree),
      object: async (tree, hash) => (await this.client()).object(tree, hash),
      snapshot: async (tree, root) => (await this.client()).snapshot(tree, root),
    };
    this.coordinator = new UpdateCoordinator(tree, this.log, new FileControlStore(stateRoot), transport, this, {
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      onState: (state) => { if (state.kind !== "unplaced") this.report(folderSyncState(state)); },
    });
  }

  /** A paused folder reports `paused` unless its changes are held. */
  private report(state: NonNullable<LocalTreeDescriptor["sync"]>): void {
    this.host.setSyncState(this.paused && state !== "conflict" ? "paused" : state);
  }

  private async client(): Promise<ProtocolClient> {
    const placement = this.host.placement();
    if (!placement) throw new UpdateValidationError(`Tree has no placement: ${this.tree}`);
    return this.host.client(placement);
  }

  // MARK: The folder's own record

  private async loadKnown(): Promise<KnownFolder | undefined> {
    if (this.known) return this.known;
    try {
      const value = JSON.parse(await readFile(this.knownPath, "utf8")) as KnownFolder;
      if (typeof value?.root !== "string" || !value.basis) throw new Error(`Invalid folder record: ${this.knownPath}`);
      this.known = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A folder the earlier synchronizer left clean held its accepted state.
      const accepted = await this.accepted();
      if (accepted) this.known = { root: accepted.root, basis: { kind: "accepted", root: accepted.root, update: accepted.update } };
    }
    return this.known;
  }

  private async saveKnown(known: KnownFolder): Promise<void> {
    const temporary = `${this.knownPath}.${crypto.randomUUID()}.tmp`;
    await mkdir(dirname(this.knownPath), { recursive: true, mode: 0o700 });
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(known)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.knownPath);
    } finally { await rm(temporary, { force: true }); }
    this.known = known;
  }

  // MARK: AcceptedTree

  async accepted(): Promise<AcceptedBase | undefined> {
    const placement = this.host.placement();
    if (!placement?.ref || !placement.update) return undefined;
    return { root: placement.ref, update: placement.update, ...(placement.cursor ? { cursor: placement.cursor } : {}),
      ...(placement.conflicted === undefined ? {} : { conflicted: placement.conflicted }) };
  }

  object(hash: string): Promise<Uint8Array | undefined> {
    return this.host.objectBytes(hash as ObjectHash);
  }

  async recordAccepted(base: AcceptedBase): Promise<void> {
    const placement = this.host.placement();
    if (!placement) throw new UpdateValidationError(`Tree has no placement: ${this.tree}`);
    await this.host.updateSyncMetadata({ ...placement, ref: base.root, update: base.update, cursor: base.cursor,
      ...(base.conflicted === undefined ? {} : { conflicted: base.conflicted }) });
  }

  async install(base: AcceptedBase, source: AcceptedSource, local: { pending: boolean }): Promise<void> {
    let rescan = false;
    await this.host.withWorkspaceIO(async () => {
      const known = await this.loadKnown();
      if (!local.pending && known) {
        if (known.root !== base.root) {
          if ((await this.host.scan()).root === known.root) await this.write(base.root, (hash) => source.object(hash));
          else rescan = true;
        }
        if (!rescan) await this.saveKnown({ root: base.root, basis: { kind: "accepted", root: base.root, update: base.update } });
      }
      await this.recordAccepted(base);
    });
    // The folder changed since it was last scanned: publish what it holds.
    if (rescan) this.scheduleScan(0);
  }

  /** Write `root` to the folder and prove the folder now holds it. */
  private async write(root: string, load: (hash: string) => Promise<Uint8Array>): Promise<void> {
    await materializeTree(this.host.root, root as ObjectHash, load, undefined, this.host.excludedMounts());
    if ((await this.host.scan()).root !== root) throw new UpdateValidationError("The folder does not hold the accepted root it was given");
    this.host.materialized();
  }

  // MARK: The folder as a source

  /** Schedule a scan after the folder settles; watcher events call this. */
  scheduleScan(delay = SCAN_DELAY_MS): void {
    if (this.closed) return;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      void this.scan().catch(() => {});
    }, delay);
    this.scanTimer.unref?.();
  }

  /** Append the folder's current root as a local change when it differs from what the folder last held. */
  async scan(): Promise<void> {
    if (this.scanning) {
      this.rescan = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      try {
        do {
          this.rescan = false;
          await this.scanOnce();
        } while (this.rescan && !this.closed);
      } finally { this.scanning = undefined; }
    })();
    return this.scanning;
  }

  private async scanOnce(): Promise<void> {
    const placement = this.host.placement();
    if (!placement?.ref || !placement.update) return;
    await this.coordinator.start();
    if (this.paused) return this.report(folderSyncState(this.coordinator.state));
    const appended = await this.host.withWorkspaceIO(async () => {
      const known = await this.loadKnown();
      if (!known) return false;
      const lazy = await this.host.scan();
      if (lazy.root === known.root) return false;
      if (placement.access !== "write") {
        // A read-only placement cannot publish; its edits wait, visibly.
        this.report("conflict");
        return false;
      }
      const previewed = this.previewed;
      this.previewed = undefined;
      const change = previewed && equal(previewed.basis, known.basis) && previewed.candidate.root === lazy.root
        ? previewed : await this.prepare(known, lazy);
      await this.log.retain(change);
      await this.saveKnown({ root: lazy.root, basis: { kind: "authored", change: change.change } });
      return true;
    });
    if (appended) await this.coordinator.noteLocalChange();
  }

  /** A `trace: null` change from what the folder held to what it holds: both graphs sparse (directories, plus the candidate's new files), the element carrying exactly the objects its basis lacks, whole or as deltas. */
  private async prepare(known: KnownFolder, lazy: LazyTreeSnapshot): Promise<LocalChange> {
    let graph: TreeSnapshot;
    let graphJSON: LocalChange["graph"] | undefined;
    if (known.basis.kind === "authored") {
      const change = known.basis.change;
      const prior = (await this.log.retained()).find((record) => record.change === change);
      if (!prior) throw new UpdateValidationError(`The folder's last change is no longer in its change log: ${change}`);
      graphJSON = prior.candidate;
      graph = decodeTreeSnapshotJSON(prior.candidate);
    } else {
      graph = await this.spine(known.basis.root);
    }
    const retained = reachable(graph.root, graph.objects);
    const objects = new Map<ObjectHash, Uint8Array>();
    const pending = [{ hash: lazy.root, kind: "directory" as "file" | "directory" }];
    for (let next = pending.pop(); next; next = pending.pop()) {
      if (objects.has(next.hash as ObjectHash)) continue;
      if (next.kind === "file" && retained.has(next.hash)) continue;
      const source = lazy.objects.get(next.hash as ObjectHash);
      const bytes = graph.objects.get(next.hash as ObjectHash) ?? await source?.bytes();
      if (!bytes || hashObject(bytes) !== next.hash) throw new UpdateValidationError(`The folder changed while it was scanned: ${next.hash}`);
      objects.set(next.hash as ObjectHash, bytes);
      if (next.kind === "directory") for (const entry of decodeProtocolDirectory(bytes).entries) {
        const child = protocolEntryObject(entry);
        if (child) pending.push(child);
      }
    }
    const candidate: TreeSnapshot = { root: lazy.root, objects };
    const change = `folder-${crypto.randomUUID()}`;
    // Against an accepted basis each changed object may go as a delta from
    // the object at its path there, which the host retains. A chained
    // authored basis is not retained when the host preflights the request,
    // so its objects go whole.
    const payload = known.basis.kind === "accepted"
      ? await transitionPayload(graph.root, lazy.root, new TreeReader(async (hash) => {
        const bytes = objects.get(hash) ?? graph.objects.get(hash) ?? await this.host.objectBytes(hash);
        if (!bytes) throw new UpdateValidationError(`Accepted object is unavailable: ${hash}`);
        return bytes;
      }, { verified: true }), { known: retained })
      : { objects: [...objects].filter(([hash]) => !graph.objects.has(hash)).map(([hash, bytes]) => ({ hash, bytes })), deltas: [] };
    const update = encodeCandidateUpdateJSON({ change, candidate: lazy.root, trace: null, resolves: [],
      deltas: payload.deltas.sort((a, b) => a.result.localeCompare(b.result)),
      objects: payload.objects.sort((a, b) => a.hash.localeCompare(b.hash)) });
    return { change, tree: this.tree, basis: known.basis, graph: graphJSON ?? snapshotJSON(graph), sourcePath: null, document: null,
      candidate: snapshotJSON(candidate), update };
  }

  /** The directories reachable from an accepted root. */
  private async spine(root: string): Promise<TreeSnapshot> {
    const objects = new Map<ObjectHash, Uint8Array>();
    const pending = [root];
    for (let next = pending.pop(); next; next = pending.pop()) {
      if (objects.has(next as ObjectHash)) continue;
      const bytes = await this.host.objectBytes(next as ObjectHash);
      if (!bytes) throw new UpdateValidationError(`Accepted directory is unavailable: ${next}`);
      objects.set(next as ObjectHash, bytes);
      for (const entry of decodeProtocolDirectory(bytes).entries) if (entry.directory) pending.push(entry.directory);
    }
    return { root: root as ObjectHash, objects };
  }

  // MARK: Placement

  /** Adopt an accepted state the daemon installed outside the machine (activation, first placement). */
  async placed(base: AcceptedBase): Promise<void> {
    await this.saveKnown({ root: base.root, basis: { kind: "accepted", root: base.root, update: base.update } });
  }

  /** Place a folder with no accepted base: adopt the host's state when the folder already holds it, or write it into an empty folder. */
  async placeFromHost(): Promise<void> {
    const placement = this.host.placement();
    if (!placement) throw new UpdateValidationError(`Tree has no placement: ${this.tree}`);
    const client = await this.host.client(placement);
    const current = await client.descriptor(this.tree);
    await this.host.withWorkspaceIO(async () => {
      const lazy = await this.host.scan();
      if (lazy.root !== current.tree.root) {
        const root = decodeProtocolDirectory(await lazy.objects.get(lazy.root)!.bytes());
        if (root.entries.length) {
          throw new ProtocolError("conflict", "A new placement contains local content but has no accepted-update base", 409, {
            tree: this.tree, path: "/", details: { kind: "workspace-revision" },
          });
        }
        await this.write(current.tree.root, async (hash) => await this.host.objectBytes(hash as ObjectHash) ?? client.object(this.tree, hash));
      }
      await this.host.updateSyncMetadata({ ...placement, ref: current.tree.root, update: current.tree.update, cursor: current.observedThrough,
        conflicted: current.tree.conflicted, access: current.tree.access === "none" ? "read" : current.tree.access });
      await this.saveKnown({ root: current.tree.root, basis: { kind: "accepted", root: current.tree.root, update: current.tree.update } });
    });
    this.report("idle");
  }

  // MARK: Watching

  /** Keep one live watch; a finished loop restarts on the next call. */
  ensureWatch(): void {
    const placement = this.host.placement();
    if (!placement || this.closed) return;
    const key = `${placement.configurationTree ?? "legacy"}:${placement.endpoint}`;
    if (this.watch?.key === key) return;
    this.watch?.abort.abort();
    const abort = new AbortController();
    const done = this.runWatch(key, abort.signal).catch(() => {}).finally(() => {
      if (this.watch?.abort === abort) this.watch = undefined;
    });
    this.watch = { abort, done, key };
  }

  private async runWatch(key: string, signal: AbortSignal): Promise<void> {
    let backoff = INITIAL_WATCH_BACKOFF_MS;
    while (!signal.aborted) {
      const placement = this.host.placement();
      if (!placement?.update || `${placement.configurationTree ?? "legacy"}:${placement.endpoint}` !== key) return;
      const connection = new AbortController();
      const stop = () => connection.abort();
      signal.addEventListener("abort", stop, { once: true });
      try {
        const client = await this.host.client(placement);
        const cursor = await this.coordinator.watchCursor() ?? (await client.descriptor(this.tree)).observedThrough;
        for await (const event of client.watch(this.tree, cursor, { signal: connection.signal })) {
          backoff = INITIAL_WATCH_BACKOFF_MS;
          await this.coordinator.observe(event);
          if (event.kind === "resync-required") break;
        }
      } catch {
        // Transport failures fall through to the backoff below.
      } finally {
        signal.removeEventListener("abort", stop);
        connection.abort();
      }
      if (signal.aborted) return;
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, MAX_WATCH_BACKOFF_MS);
    }
  }

  // MARK: Pausing

  get isPaused(): boolean { return this.paused; }

  /** Stop publishing the folder's changes, durably; accepted updates still arrive. */
  async pause(): Promise<void> {
    await mkdir(dirname(this.pausedPath), { recursive: true, mode: 0o700 });
    const file = await open(this.pausedPath, "w", 0o600);
    try { await file.writeFile(JSON.stringify({ paused: true })); await file.sync(); } finally { await file.close(); }
    this.paused = true;
    this.report(folderSyncState(this.coordinator.state));
  }

  /** Publish again, starting with what the folder holds now. */
  async resume(): Promise<void> {
    await rm(this.pausedPath, { force: true });
    this.paused = false;
    this.report(folderSyncState(this.coordinator.state));
    await this.scan();
  }

  /**
   * The request the next publication would send, retaining nothing: the
   * log's unsettled chain and, when the folder differs from what it last
   * held, the change a scan would append, assembled as the change log
   * assembles a request. Null when nothing is pending.
   */
  async preview(): Promise<ReturnType<typeof localChangeRequest> | null> {
    const placement = this.host.placement();
    if (!placement?.ref || !placement.update) return null;
    const change = await this.host.withWorkspaceIO(async () => {
      const known = await this.loadKnown();
      if (!known || placement.access !== "write") return undefined;
      const lazy = await this.host.scan();
      if (lazy.root === known.root) return undefined;
      return this.previewed = await this.prepare(known, lazy);
    });
    const records = await this.log.retained();
    const unsettled = new Set((await this.coordinator.pendingChanges()).map((record) => record.change));
    const settled = new Set(records.filter((record) => !unsettled.has(record.change)).map((record) => record.change));
    const through = change?.change ?? await this.log.nextPublication(settled);
    return through ? localChangeRequest(change ? [...records, change] : records, through, settled) : null;
  }

  // MARK: Operations

  /** Publish what the folder holds now, retry, or catch up, and wait for the result. */
  async syncOnce() {
    await this.scan();
    return this.coordinator.syncOnce();
  }

  /** Discard a held request and every change authored on it; the folder then returns to the accepted state. */
  async discardHeldChanges(): Promise<void> {
    await this.coordinator.discardHeldChanges();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.coordinator.close();
    const watch = this.watch;
    watch?.abort.abort();
    await watch?.done;
    await this.scanning?.catch(() => {});
  }
}
