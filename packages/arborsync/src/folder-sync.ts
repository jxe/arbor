import { existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  arborPrivateRoot,
  decodeTreeSnapshotJSON,
  decodeProtocolDirectory,
  encodeCandidateUpdateJSON,
  encodeProtocolDirectory,
  hashObject,
  decodeBase64,
  transitionPayload,
  TreeReader,
  ProtocolError,
  protocolEntryObject,
  ProtocolClient,
  type LazyTreeSnapshot,
  type ObjectHash,
  type ProtocolDirectoryEntry,
  type ProtocolObjectSource,
  type SharedTreePlacement,
  type TreeSnapshot,
  type LocalTreeDescriptor,
} from "@overstory/protocol";
import {
  ignoreFilesIn,
  loadIgnorePolicy,
  materializeTree,
  membershipSkip,
  trackedEntries,
  withoutPlatformMetadata,
  type SkipPath,
} from "@overstory/fs";
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
import { differences, entryAt, maskDeclined, resolveDeclined, within, type LoadObject } from "./declined-paths.ts";
import { forTrackedLookup, type TrackedRoot } from "./filesystem-object-source.ts";

/** What the daemon provides one folder's synchronization. */
export interface FolderSyncHost {
  placement(): SharedTreePlacement | undefined;
  client(placement: SharedTreePlacement): Promise<ProtocolClient>;
  updateSyncMetadata(placement: SharedTreePlacement): Promise<unknown>;
  setSyncState(state: NonNullable<LocalTreeDescriptor["sync"]>): void;
  /** Serialize this folder's filesystem reads and writes; never held across protocol I/O. */
  withWorkspaceIO<T>(run: () => Promise<T>): Promise<T>;
  /**
   * Walk the folder into a lazy graph through its stat index. An ignored path
   * is left out unless `tracked` holds it, or when `also` leaves it out.
   */
  scan(tracked: TrackedRoot | null, also?: SkipPath): Promise<LazyTreeSnapshot>;
  /** The folder's root on disk. */
  readonly root: string;
  excludedMounts(): readonly string[];
  /** Verified bytes by hash: the folder's index, then Canopy. */
  objectBytes(hash: ObjectHash): Promise<Uint8Array | undefined>;
  /** Accepted bytes were written to the folder. */
  materialized(): void;
  /** The folder's declined paths changed. */
  setDeclined(declined: LocalTreeDescriptor["declined"]): void;
}

/**
 * Declined folder work, kept on disk: the host definitively rejected a
 * request, and `paths` are the entries it changed. Each stays declined until
 * the folder agrees with the accepted state there, or the work is restored or
 * resent. Everything else syncs.
 */
export interface DeclinedFolder {
  /** Why the host declined, as it said. */
  detail?: string;
  paths: string[];
  since: string;
  /** The refused request, for reference; the folder itself holds its intent. */
  request: { digest: string; base: { root: string; update: string }; candidate: string };
}

/** What `arbor declined` shows: the record, and where declined work is on disk now. */
export interface DeclinedReport extends DeclinedFolder {
  tree: string;
  /** Where the declined paths are now, including content a declined path moved elsewhere. */
  points: string[];
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

const EMPTY_DIRECTORY_BYTES = encodeProtocolDirectory({ type: "directory", entries: [] });
const EMPTY_DIRECTORY = hashObject(EMPTY_DIRECTORY_BYTES);
/** Directory objects kept for tracked lookups; content-addressed, so never stale. */
const TRACKED_OBJECT_LIMIT = 4_096;

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

async function writeFileAtomic(path: string, bytes: Uint8Array | string, mode = 0o600): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", mode);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** The scanned folder's bytes first, then an accepted source's, without failing on a hash neither has. */
function fromLazyThen(lazy: LazyTreeSnapshot, load: (hash: string) => Promise<Uint8Array>) {
  return async (hash: ObjectHash): Promise<Uint8Array | undefined> =>
    await lazy.objects.get(hash)?.bytes() ?? await load(hash).catch(() => undefined);
}

/** Durably replace a small private JSON record. */
async function writeRecord(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, JSON.stringify(value));
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
  private readonly declinedPath: string;
  private declined?: { value: DeclinedFolder | undefined };
  private settling?: Promise<boolean>;
  /** The change the last preview prepared; the next scan of the same folder sends exactly it. */
  private previewed?: LocalChange;
  /** Objects of the scan that last became the folder's known root: its directories, for tracked lookups. */
  private recentObjects?: ReadonlyMap<ObjectHash, ProtocolObjectSource>;
  private readonly trackedObjects = new Map<ObjectHash, Uint8Array>();

  constructor(readonly tree: string, stateRoot: string, private readonly host: FolderSyncHost, options: { pollIntervalMs?: number } = {}) {
    // Folder records are sparse (directories and new files), so the log keeps
    // every object it names rather than leaning on a folder that keeps changing.
    this.log = new ChangeLog(tree, stateRoot);
    this.knownPath = join(stateRoot, "sync", "folder.json");
    this.pausedPath = join(stateRoot, "sync", "paused.json");
    this.declinedPath = join(stateRoot, "sync", "declined.json");
    this.paused = existsSync(this.pausedPath);
    const transport: UpdateTransport = {
      submitUpdates: async (tree, request) => (await this.client()).submitUpdates(tree, request),
      descriptor: async (tree) => (await this.client()).descriptor(tree),
      object: async (tree, hash) => (await this.client()).object(tree, hash),
      snapshot: async (tree, root) => (await this.client()).snapshot(tree, root),
    };
    this.coordinator = new UpdateCoordinator(tree, this.log, new FileControlStore(stateRoot), transport, this, {
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      onState: (state) => {
        if (state.kind !== "unplaced") this.report(folderSyncState(state));
        // A definitive refusal becomes declined paths once the transition finishes.
        if (state.kind === "held" && state.reason === "rejected") setTimeout(() => void this.settleRefusal().catch(() => {}), 0);
      },
    });
  }

  /** A paused folder reports `paused` unless a request is held whole. */
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
    await writeRecord(this.knownPath, known);
    this.known = known;
  }

  private async loadDeclined(): Promise<DeclinedFolder | undefined> {
    if (this.declined) return this.declined.value;
    let value: DeclinedFolder | undefined;
    try {
      value = JSON.parse(await readFile(this.declinedPath, "utf8")) as DeclinedFolder;
      if (!Array.isArray(value?.paths) || typeof value.since !== "string") throw new Error(`Invalid declined record: ${this.declinedPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.declined = { value };
    this.reportDeclined();
    return value;
  }

  /** Record declined work, or clear it when nothing is declined. */
  private async saveDeclined(declined: DeclinedFolder | undefined): Promise<void> {
    const value = declined?.paths.length ? declined : undefined;
    if (value) await writeRecord(this.declinedPath, value);
    else await rm(this.declinedPath, { force: true });
    this.declined = { value };
    this.reportDeclined();
  }

  private reportDeclined(): void {
    const declined = this.declined?.value;
    this.host.setDeclined(declined ? { paths: declined.paths, since: declined.since, ...(declined.detail === undefined ? {} : { detail: declined.detail }) } : undefined);
  }

  /** Objects by hash: those given, the scanned folder's, then the folder's index and Canopy. */
  private loader(lazy?: LazyTreeSnapshot, first?: (hash: ObjectHash) => Promise<Uint8Array | undefined>): LoadObject {
    return async (hash) => {
      const bytes = await first?.(hash) ?? await lazy?.objects.get(hash)?.bytes() ?? await this.host.objectBytes(hash);
      if (!bytes) throw new UpdateValidationError(`Object is unavailable: ${hash}`);
      return bytes;
    };
  }

  /**
   * `root` as the tracked set. Its directories come from the scan that
   * produced it when still at hand, otherwise from the folder's index, its
   * pending changes or Canopy, read so that no directory is rebuilt from disk
   * through another tracked lookup.
   */
  private tracking(root: string): TrackedRoot {
    return {
      root: root as ObjectHash,
      load: async (hash) => {
        const kept = this.trackedObjects.get(hash);
        if (kept) return kept;
        const bytes = await this.recentObjects?.get(hash)?.bytes().catch(() => undefined)
          ?? await forTrackedLookup(() => this.host.objectBytes(hash));
        if (!bytes) throw new UpdateValidationError(`Tracked object is unavailable: ${hash}`);
        if (this.trackedObjects.size >= TRACKED_OBJECT_LIMIT) this.trackedObjects.clear();
        this.trackedObjects.set(hash, bytes);
        return bytes;
      },
    };
  }

  /** The folder as a scan compares it with what it last held: the root it held is the tracked set. */
  private scanKnown(known: KnownFolder | undefined): Promise<LazyTreeSnapshot> {
    return this.host.scan(known ? this.tracking(known.root) : null);
  }

  /** The tracked root the folder's own object reads use: the root it last held. */
  async trackedRoot(): Promise<TrackedRoot | null> {
    const known = await this.loadKnown();
    return known ? this.tracking(known.root) : null;
  }

  /**
   * A path an ignore rule keeps out changed. It matters only when the folder
   * still tracks it; a lookup that fails schedules the scan anyway.
   */
  async noteIgnoredChange(treePath: string): Promise<void> {
    try {
      const known = await this.loadKnown();
      if (!known) return;
      const tracked = trackedEntries(known.root as ObjectHash, this.tracking(known.root).load);
      if (!(await tracked(treePath, false)) && !(await tracked(treePath, true))) return;
    } catch {}
    this.scheduleScan();
  }

  /**
   * The folder as it may be published: what it holds, with the accepted
   * state at every declined point. `record` lifts declined paths the folder now
   * agrees with the accepted state on.
   */
  private async publishable(lazy: LazyTreeSnapshot, accepted: string, record: boolean): Promise<LazyTreeSnapshot> {
    const declined = await this.loadDeclined();
    if (!declined) return lazy;
    const load = this.loader(lazy);
    const { points, lifted } = await resolveDeclined(declined.paths, lazy.root, accepted as ObjectHash, load);
    if (record && lifted.length) await this.saveDeclined({ ...declined, paths: declined.paths.filter((path) => !lifted.includes(path)) });
    if (!points.length) return lazy;
    const masked = await maskDeclined(lazy.root, accepted as ObjectHash, points, load);
    const objects = new Map(lazy.objects);
    for (const [hash, bytes] of masked.objects) objects.set(hash, { hash, bytes: async () => bytes });
    // The accepted content at declined points need not be in the folder.
    const add = async (entry: ProtocolDirectoryEntry | null): Promise<void> => {
      const object = entry ? protocolEntryObject(entry) : undefined;
      if (!object || objects.has(object.hash)) return;
      const source: ProtocolObjectSource = { hash: object.hash, bytes: () => load(object.hash) };
      objects.set(object.hash, source);
      if (object.kind === "directory") for (const child of decodeProtocolDirectory(await source.bytes()).entries) await add(child);
    };
    for (const point of points) await add(await entryAt(accepted as ObjectHash, point, load));
    return { root: masked.root, objects };
  }

  private osPath(path: string): string {
    return join(this.host.root, ...path.split("/").filter(Boolean));
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
    let uncovered = false;
    await this.host.withWorkspaceIO(async () => {
      const known = await this.loadKnown();
      if (!local.pending && known) {
        if (known.root !== base.root) {
          const lazy = await this.scanKnown(known);
          const installed = (await this.accepted())?.root ?? known.root;
          if ((await this.publishable(lazy, installed, true)).root === known.root) {
            const written = await this.write(base.root, (hash) => source.object(hash), this.tracking(known.root));
            if (written === "changed") rescan = true;
            else uncovered = written;
          } else rescan = true;
        }
        if (!rescan) await this.saveKnown({ root: base.root, basis: { kind: "accepted", root: base.root, update: base.update } });
      }
      await this.recordAccepted(base);
    });
    // The folder changed since it was last scanned, or a rule the new root
    // removed uncovered local content: publish what it holds.
    if (rescan || uncovered) this.scheduleScan(0);
  }

  /**
   * Write `root` to the folder, except at declined points, and prove the
   * folder now holds it there. Local content the folder does not own is never
   * deleted: a path that `root` lacks stays when the rules the folder held
   * (`held`, the root it last held) or the rules `root` brings ignore it. True
   * when content only the earlier rules ignored remains, which the folder
   * must now publish, as when `root` holds platform metadata the folder
   * leaves out. `"changed"` when something else changed the folder while it
   * was written: it then holds local changes on the root it last held, and
   * publishes them rather than stopping.
   */
  private async write(root: string, load: (hash: string) => Promise<Uint8Array>, held: TrackedRoot | null): Promise<boolean | "changed"> {
    const tracked: TrackedRoot = { root: root as ObjectHash, load };
    const declined = await this.loadDeclined();
    let points: string[] = [];
    if (declined) {
      const lazy = await this.host.scan(tracked);
      points = (await resolveDeclined(declined.paths, lazy.root, root as ObjectHash, this.loader(lazy, fromLazyThen(lazy, load)))).points;
    }
    const mounts = this.host.excludedMounts();
    const lookup = trackedEntries(tracked.root, load);
    // Both rule sets come from roots, not from a folder that changes as it is written.
    const rulesOf = (source: TrackedRoot | null) => loadIgnorePolicy(this.host.root, {
      excludedRoots: mounts,
      read: source ? ignoreFilesIn(source.root, source.load) : async () => null,
    });
    const before = membershipSkip(await rulesOf(held), lookup);
    const after = membershipSkip(await rulesOf(tracked), lookup);
    await materializeTree(this.host.root, root as ObjectHash, load, undefined, [...mounts, ...points.map((point) => this.osPath(point))],
      async (path, isDirectory) => await after(path, isDirectory) || await before(path, isDirectory));
    let uncovered = false;
    const written = await this.host.scan(tracked, async (path, isDirectory) => {
      if (!(await before(path, isDirectory))) return false;
      uncovered = true;
      return true;
    });
    const shown = points.length
      ? (await maskDeclined(written.root, root as ObjectHash, points, this.loader(written, fromLazyThen(written, load)))).root
      : written.root;
    const loadHash = (hash: ObjectHash) => load(hash);
    const holdable = await withoutPlatformMetadata(root as ObjectHash, loadHash);
    if (shown !== holdable) {
      // A folder that still holds what it held was not written at all: stop.
      if (!held || shown === await withoutPlatformMetadata(held.root, (hash) => held.load(hash))) {
        throw new UpdateValidationError("The folder does not hold the accepted root it was given");
      }
      console.error(`[arborsync:folder] ${this.tree} changed while it was written; publishing what it holds`);
      this.host.materialized();
      return "changed";
    }
    this.recentObjects = written.objects;
    this.host.materialized();
    return uncovered || holdable !== root;
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
      const lazy = await this.publishable(await this.scanKnown(known), placement.ref!, true);
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
      this.recentObjects = lazy.objects;
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
      // Nothing is tracked before a first placement: ignore rules apply to the first snapshot.
      const lazy = await this.host.scan(null);
      const load = async (hash: ObjectHash) => await this.host.objectBytes(hash) ?? client.object(this.tree, hash);
      if (lazy.root !== await withoutPlatformMetadata(current.tree.root as ObjectHash, load)) {
        const root = decodeProtocolDirectory(await lazy.objects.get(lazy.root)!.bytes());
        if (root.entries.length) {
          throw new ProtocolError("conflict", "A new placement contains local content but has no accepted-update base", 409, {
            tree: this.tree, path: "/", details: { kind: "workspace-revision" },
          });
        }
        await this.write(current.tree.root, (hash) => load(hash as ObjectHash), null);
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
      const lazy = await this.publishable(await this.scanKnown(known), placement.ref!, false);
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
    const presentation = await this.coordinator.syncOnce();
    await this.settleRefusal();
    // A refusal became declined paths: publish the rest of the folder now.
    return presentation.state === "held" && this.coordinator.state.kind !== "held" ? this.coordinator.syncOnce() : presentation;
  }

  /** Turn a definitively rejected request into declined paths, once. True when it did. */
  private settleRefusal(): Promise<boolean> {
    return this.settling ??= this.declineRefused().finally(() => { this.settling = undefined; });
  }

  /**
   * A refused request's footprint (the entries it changed) becomes declined
   * paths, and the request leaves the machine. The folder still holds that
   * work on disk; the next scan publishes everything else against the
   * accepted state with fresh identity.
   */
  private async declineRefused(): Promise<boolean> {
    const refused = this.coordinator.heldRequest();
    const accepted = await this.accepted();
    if (refused?.reason !== "rejected" || !accepted) return false;
    const { attempt } = refused;
    await this.host.withWorkspaceIO(async () => {
      const objects = new Map<string, Uint8Array>();
      for (const record of await this.log.retained()) for (const snapshot of [record.graph, record.candidate]) {
        for (const [hash, bytes] of decodeTreeSnapshotJSON(snapshot).objects) objects.set(hash, bytes);
      }
      const footprint = await differences(attempt.base.root as ObjectHash, attempt.candidate as ObjectHash,
        this.loader(undefined, async (hash) => objects.get(hash)));
      const prior = await this.loadDeclined();
      await this.saveDeclined({
        ...(refused.detail === undefined ? {} : { detail: refused.detail }),
        paths: [...new Set([...(prior?.paths ?? []), ...footprint])].sort(),
        since: prior?.since ?? new Date().toISOString(),
        request: { digest: attempt.digest, base: attempt.base, candidate: attempt.candidate },
      });
      // Nothing of the refused chain is published: the next change starts from the accepted state.
      await this.saveKnown({ root: accepted.root, basis: { kind: "accepted", root: accepted.root, update: accepted.update } });
    });
    await this.coordinator.discardHeldChanges();
    await this.scan();
    return true;
  }

  /** The folder's declined work and where it is now, or null. */
  async declinedReport(): Promise<DeclinedReport | null> {
    await this.settling;
    const accepted = await this.accepted();
    return this.host.withWorkspaceIO(async () => {
      const declined = await this.loadDeclined();
      if (!declined || !accepted) return null;
      const lazy = await this.scanKnown(await this.loadKnown());
      const { points } = await resolveDeclined(declined.paths, lazy.root, accepted.root as ObjectHash, this.loader(lazy));
      return { tree: this.tree, ...declined, points };
    });
  }

  /** Discard a request held whole (one the host does not support) and every change authored on it; the folder then returns to the accepted state. */
  async discardHeldChanges(): Promise<void> {
    if (this.coordinator.heldRequest()?.reason === "unsupported") await this.coordinator.discardHeldChanges();
  }

  /** Put the accepted state back at every declined point; the folder's other changes are kept. */
  async restoreDeclined(): Promise<void> {
    await this.settleRefusal();
    const accepted = await this.accepted();
    await this.host.withWorkspaceIO(async () => {
      const declined = await this.loadDeclined();
      if (!declined || !accepted) return;
      const lazy = await this.scanKnown(await this.loadKnown());
      const load = this.loader(lazy);
      const { points } = await resolveDeclined(declined.paths, lazy.root, accepted.root as ObjectHash, load);
      const policy = await loadIgnorePolicy(this.host.root, { excludedRoots: this.host.excludedMounts() });
      const tracked = trackedEntries(accepted.root as ObjectHash, load);
      for (const point of points) {
        await this.restore(point, await entryAt(accepted.root as ObjectHash, point, load), load, membershipSkip(policy, tracked, point));
      }
      await this.saveDeclined(undefined);
      this.host.materialized();
    });
    await this.scan();
  }

  /** Publish declined work again as the folder holds it now, with fresh identity. */
  async resendDeclined(): Promise<void> {
    await this.settleRefusal();
    await this.host.withWorkspaceIO(() => this.saveDeclined(undefined));
    await this.scan();
  }

  /**
   * Put the accepted entry (or its absence) at one declined point on disk.
   * `skip` is the folder's membership beneath the point: local content it
   * leaves out is never deleted.
   */
  private async restore(point: string, entry: ProtocolDirectoryEntry | null, load: LoadObject, skip: SkipPath): Promise<void> {
    const target = this.osPath(point);
    const mounts = this.host.excludedMounts();
    if (mounts.some((mount) => within(mount, target) || within(target, mount))) {
      throw new UpdateValidationError(`A placed tree is mounted at or beneath ${point}; move it before restoring`);
    }
    if (entry?.tree) return;
    const existing = await lstat(target).catch(() => undefined);
    if (existing && !entry?.directory) {
      if (existing.isDirectory()) {
        // Remove what the folder owns beneath it; the directory stays while ignored content remains.
        await materializeTree(target, EMPTY_DIRECTORY, async (hash) => hash === EMPTY_DIRECTORY ? EMPTY_DIRECTORY_BYTES : load(hash), undefined, mounts, skip);
        await rmdir(target).catch(() => {});
      } else if (!(await skip("/", false))) {
        await rm(target, { force: true });
      }
    }
    if (entry?.file) {
      await mkdir(dirname(target), { recursive: true });
      await writeFileAtomic(target, await load(entry.file), 0o644);
    } else if (entry?.directory) {
      if (existing && !existing.isDirectory()) await rm(target, { force: true });
      await materializeTree(target, entry.directory, load, undefined, mounts, skip);
    }
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
