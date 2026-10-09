import { Database } from "bun:sqlite";
import { lstat, readdir, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ObjectStore, type PackCandidate } from "@overstory/object-store";
import { decodeProtocolDirectory, type ObjectHash } from "@overstory/protocol";

/**
 * canopyd 001: packs cold loose objects in the background. One coordinator
 * per process owns packing; at most one pass runs at a time and an accepted
 * update never waits for it.
 *
 * - **Trigger.** Loose objects are counted at startup and as this process
 *   writes them. After an acceptance (`notify`) a pass is scheduled once the
 *   count or bytes cross the high thresholds; notifications coalesce, and the
 *   pass waits for `debounceMs` without new ones. A startup check and a
 *   low-frequency idle check pick up leftovers; neither scans when the counts
 *   show nothing to do.
 * - **What is packed.** Loose objects older than `minAgeMs`, outside every
 *   tree's current closure (the hot set stays loose), in batches of at most
 *   `batchObjects` / `batchBytes`, yielding between batches. Each object's
 *   document is its `document_versions` stable key, else its path in the
 *   accepted root that introduced it, or its tree's log for log entries; each
 *   document's versions share zstd frames of about 1 MiB (see
 *   `prepareRecords`).
 * - **Headroom.** A pass defers when free disk is under twice a batch.
 */
export interface PackMaintenanceOptions {
  minAgeMs?: number;
  highObjects?: number;
  highBytes?: number;
  debounceMs?: number;
  idleMs?: number;
  batchObjects?: number;
  batchBytes?: number;
}

export interface PackReport {
  trigger: string;
  scanned: number;
  hot: number;
  young: number;
  packed: number;
  bytes: number;
  packBytes: number;
  batches: number;
  deferred?: string;
  ms: number;
}

const OBJECT_NAME = /^[a-f0-9]{62}$/;
const SHARD = /^[a-f0-9]{2}$/;

export class PackMaintenance {
  private readonly options: Required<PackMaintenanceOptions>;
  private loose = { objects: 0, bytes: 0, counted: false };
  private written = 0;
  private running: Promise<PackReport | null> | null = null;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** The last few passes, newest last; a diagnostic. */
  readonly reports: PackReport[] = [];

  constructor(private readonly db: Database, private readonly objects: ObjectStore, private readonly root: string, options: PackMaintenanceOptions = {}) {
    this.options = {
      minAgeMs: 60 * 60_000, highObjects: 4000, highBytes: 64 << 20, debounceMs: 30_000, idleMs: 30 * 60_000,
      batchObjects: 4000, batchBytes: 32 << 20, ...options,
    };
  }

  /** Count loose objects and schedule the idle check; packs if over threshold. */
  start(): void {
    void this.check("startup");
    this.scheduleIdle();
  }

  /** After an acceptance: schedule a pass if loose objects crossed a threshold. */
  notify(): void {
    if (this.disposed) return;
    const fresh = this.objects.writes.written - this.written;
    this.written = this.objects.writes.written;
    this.loose.objects += fresh;
    this.loose.bytes += fresh * 1024; // An estimate until the next scan.
    if (this.loose.objects < this.options.highObjects && this.loose.bytes < this.options.highBytes) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.check("threshold"), this.options.debounceMs);
    this.debounce.unref?.();
  }

  private scheduleIdle(): void {
    if (this.disposed) return;
    this.idle = setTimeout(async () => {
      await this.check("idle");
      this.scheduleIdle();
    }, this.options.idleMs);
    this.idle.unref?.();
  }

  private async check(trigger: string): Promise<void> {
    if (this.disposed) return;
    if (this.loose.counted && trigger === "idle" && this.loose.objects < this.options.highObjects / 4) return;
    await this.run(trigger).catch((error) => {
      process.stderr.write(`Object packing failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }

  /** One pass now (or the one already running). */
  run(trigger = "manual"): Promise<PackReport | null> {
    if (!this.running) this.running = this.pass(trigger).finally(() => { this.running = null; });
    return this.running;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
    clearTimeout(this.debounce);
    clearTimeout(this.idle);
    await this.running?.catch(() => {});
  }

  private async pass(trigger: string): Promise<PackReport> {
    const started = performance.now();
    const report: PackReport = { trigger, scanned: 0, hot: 0, young: 0, packed: 0, bytes: 0, packBytes: 0, batches: 0, ms: 0 };
    const finish = () => {
      report.ms = Math.round(performance.now() - started);
      this.reports.push(report);
      if (this.reports.length > 16) this.reports.shift();
      return report;
    };
    // Recover anything an interrupted pass left: unindexed packs.
    await this.objects.packs.removeOrphans();
    const cutoff = Date.now() - this.options.minAgeMs;
    const files = await looseObjects(this.root);
    report.scanned = files.length;
    this.loose = { objects: files.length, bytes: files.reduce((n, f) => n + f.size, 0), counted: true };
    this.written = this.objects.writes.written;
    const old = files.filter((f) => f.mtimeMs < cutoff);
    report.young = files.length - old.length;
    if (!old.length) return finish();
    const { hot, keys } = await this.classify(new Set(old.map((f) => f.hash)));
    const eligible = old.filter((f) => !hot.has(f.hash));
    report.hot = old.length - eligible.length;
    // Oldest first, so each document's versions arrive in order.
    eligible.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (let i = 0; i < eligible.length && !this.disposed;) {
      let size = 0;
      const batch: typeof eligible = [];
      while (i < eligible.length && batch.length < this.options.batchObjects && size < this.options.batchBytes) {
        size += eligible[i]!.size; batch.push(eligible[i++]!);
      }
      const free = await statfs(this.root).then((s) => s.bavail * s.bsize, () => Infinity);
      if (free < 2 * size) { report.deferred = `free disk ${free} bytes`; break; }
      const candidates: PackCandidate[] = [];
      for (const f of batch) {
        const bytes = await this.objects.find(f.hash);
        if (bytes) candidates.push({ hash: f.hash, bytes, key: keys.get(f.hash) ?? `object:${f.hash}`, usedAt: f.mtimeMs });
      }
      const result = await this.objects.pack(candidates);
      report.packed += result.packed; report.bytes += result.bytes; report.packBytes += result.packBytes; report.batches++;
      this.loose.objects -= result.packed; this.loose.bytes -= result.bytes;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return finish();
  }

  /**
   * The hot set (every tree's current closure) and a document key for each
   * of `wanted`: its stable key, else the path of its first appearance in an
   * accepted root, else its tree's log for a log entry.
   */
  private async classify(wanted: Set<ObjectHash>): Promise<{ hot: Set<ObjectHash>; keys: Map<ObjectHash, string> }> {
    const keys = new Map<ObjectHash, string>();
    const versions = this.db.query("SELECT tree_id AS tree, stable_key AS key, content_hash AS hash FROM document_versions ORDER BY rowid").all() as Array<{ tree: string; key: string; hash: string }>;
    for (const v of versions) if (wanted.has(v.hash) && !keys.has(v.hash)) keys.set(v.hash, `doc:${v.tree}:${v.key}`);
    const rows = this.db.query("SELECT tree_id AS tree, root, entry FROM accepted_updates ORDER BY ordinal").all() as Array<{ tree: string; root: string; entry: string }>;
    const heads = new Map<string, string>();
    for (const row of rows) {
      heads.set(row.tree, row.root);
      if (wanted.has(row.entry)) keys.set(row.entry, `log:${row.tree}`);
    }
    const hot = new Set<ObjectHash>();
    for (const root of heads.values()) await this.walk(root, "", null, (hash) => { hot.add(hash); return true; });
    // Paths for the rest, from the roots that introduced them (newest first:
    // a later walk skips what an earlier one saw).
    const seen = new Set<ObjectHash>();
    for (const row of rows.slice().reverse()) {
      await this.walk(row.root, "", seen, (hash, path, kind) => {
        if (wanted.has(hash) && !keys.has(hash)) keys.set(hash, `${kind === "directory" ? "dir" : "path"}:${row.tree}:${path || "/"}`);
        return true;
      });
    }
    return { hot, keys };
  }

  private async walk(root: ObjectHash, path: string, seen: Set<ObjectHash> | null, visit: (hash: ObjectHash, path: string, kind: "file" | "directory") => boolean): Promise<void> {
    const pending: Array<[ObjectHash, string]> = [[root, path]];
    const local = seen ?? new Set<ObjectHash>();
    while (pending.length) {
      const [hash, at] = pending.pop()!;
      if (local.has(hash)) continue;
      local.add(hash);
      const bytes = await this.objects.find(hash);
      if (!bytes || !visit(hash, at, "directory")) continue;
      let directory;
      try { directory = decodeProtocolDirectory(bytes); } catch { continue; }
      for (const entry of directory.entries) {
        const child = `${at}/${entry.name}`;
        if (entry.directory) pending.push([entry.directory, child]);
        else if (entry.file && !local.has(entry.file)) { local.add(entry.file); visit(entry.file, child, "file"); }
      }
    }
  }
}

/** Every loose object file under `root`, with its size and time. */
export async function looseObjects(root: string): Promise<Array<{ hash: ObjectHash; size: number; mtimeMs: number }>> {
  const out: Array<{ hash: ObjectHash; size: number; mtimeMs: number }> = [];
  for (const shard of await readdir(root).catch(() => [] as string[])) {
    if (!SHARD.test(shard)) continue;
    for (const name of await readdir(join(root, shard)).catch(() => [] as string[])) {
      if (!OBJECT_NAME.test(name)) continue;
      const info = await lstat(join(root, shard, name)).catch(() => null);
      if (info?.isFile()) out.push({ hash: `sha256:${shard}${name}`, size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  return out;
}

const USAGE = "usage: bun run packages/canopyd/src/pack-maintenance.ts <data-root> [--min-age-hours N] | <data-root> --unpack";

/** One pass from the command line, for a copy of a data root or a stopped
 * host: `--unpack` expands every pack back into loose files instead. It may
 * also run beside a serving canopyd, which packs on its own schedule. */
if (import.meta.main) {
  const args = process.argv.slice(2);
  let dataRoot: string | undefined, minAgeHours = 1, unpack = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--unpack") unpack = true;
    else if (arg === "--min-age-hours") {
      minAgeHours = Number(args[++i]);
      if (!Number.isFinite(minAgeHours) || minAgeHours < 0) { console.error(USAGE); process.exit(2); }
    } else if (!arg.startsWith("--") && !dataRoot) dataRoot = resolve(arg);
    else { console.error(USAGE); process.exit(2); }
  }
  if (!dataRoot) { console.error(USAGE); process.exit(2); }
  const store = new ObjectStore(join(dataRoot, "objects"));
  if (unpack) console.log(JSON.stringify(await store.unpack()));
  else {
    const db = new Database(join(dataRoot, "canopy.sqlite3"), { readonly: true });
    try {
      const report = await new PackMaintenance(db, store, join(dataRoot, "objects"), { minAgeMs: minAgeHours * 3_600_000 }).run("command");
      console.log(JSON.stringify(report));
    } finally { db.close(); }
  }
}
