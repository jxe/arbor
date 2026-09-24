#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { link, lstat, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ObjectStore } from "@overstory/object-store";
import type { ObjectHash } from "@overstory/protocol";
import { retainedObjects } from "./retention.ts";
import { assertCurrentHostSchema } from "./schema.ts";

/**
 * The object collector: deletes stored objects that nothing retained names
 * (see `retainedObjects`), and only those unused for a grace period, like
 * git's prune expiry. It may run against a data root that a live canopyd is
 * serving, from another process:
 *
 * - The cutoff is taken before the database is read. An object an accepted
 *   update commits after that read was written or freshened by the
 *   acceptance (`ObjectStore.store`, graph validation, merge answers), so its
 *   time is later than the cutoff unless the acceptance took longer than the
 *   grace period.
 * - Each candidate is first renamed aside, then its time is read again. One
 *   freshened in the meantime is linked back; a freshen that finds the file
 *   gone fails its acceptance instead of committing a dangling reference.
 *
 * Nothing but whole object files is removed: shard directories stay, and
 * files that are not objects (temporary writes) are counted and left.
 */
export interface CollectOptions {
  /** Delete; otherwise report what would be deleted. */
  delete?: boolean;
  /** Keep unreferenced objects used within this many milliseconds. */
  graceMs?: number;
  now?: () => number;
  progress?: (message: string) => void;
  /** Test hook: runs after candidates are chosen, before any is removed. */
  beforeRemoval?: (candidates: readonly ObjectHash[]) => Promise<void>;
}

export interface Tally { objects: number; bytes: number }

export interface CollectReport {
  mode: "dry-run" | "delete";
  dataRoot: string;
  graceHours: number;
  cutoff: string;
  rows: number;
  entries: number;
  scanned: Tally;
  live: Tally;
  /** Unreferenced but used within the grace period. */
  young: Tally;
  /** Unreferenced and old: deleted, or in a dry run, deletable. */
  deleted: Tally;
  /** Candidates freshened by a concurrent writer and put back. */
  kept: number;
  /** Optional pins (replay inputs) that were never stored. */
  absent: number;
  /** Files in the store that are not objects, left alone. */
  other: number;
  /** Set-aside files from an interrupted run, restored first. */
  recovered: number;
  ms: number;
}

const DAY = 24 * 60 * 60 * 1000;
const OBJECT_NAME = /^[a-f0-9]{62}$/;
const ASIDE = /^([a-f0-9]{62})\.[0-9a-f-]{36}\.collect$/;
const SHARD = /^[a-f0-9]{2}$/;

export async function collectObjects(dataRoot: string, options: CollectOptions = {}): Promise<CollectReport> {
  const started = performance.now();
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? DAY;
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error("Grace period must be a nonnegative number");
  const progress = options.progress ?? (() => {});
  const remove = options.delete ?? false;
  const root = resolve(dataRoot), objectsRoot = join(root, "objects");
  const store = new ObjectStore(objectsRoot);

  // Put back anything an interrupted run set aside before deciding anything.
  let recovered = 0;
  for (const { shard, name } of await storeFiles(objectsRoot)) {
    const match = ASIDE.exec(name);
    if (!match) continue;
    recovered++;
    if (remove) await restore(join(objectsRoot, shard, name), join(objectsRoot, shard, match[1]!));
  }

  const cutoff = now() - graceMs;
  const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
  let retained: Awaited<ReturnType<typeof retainedObjects>>;
  try {
    assertCurrentHostSchema(db);
    progress("walking retained history");
    retained = await retainedObjects(db, store);
  } finally {
    db.close();
  }
  progress(`${retained.live.size} live objects from ${retained.rows} rows and ${retained.entries} entries`);

  const tally = () => ({ objects: 0, bytes: 0 });
  const scanned = tally(), live = tally(), young = tally(), deleted = tally();
  let other = 0;
  const candidates: Array<{ hash: ObjectHash; path: string; bytes: number }> = [];
  for (const { shard, name } of await storeFiles(objectsRoot)) {
    if (!OBJECT_NAME.test(name)) { if (!ASIDE.test(name)) other++; continue; }
    const hash = `sha256:${shard}${name}`, path = join(objectsRoot, shard, name);
    const info = await lstat(path).catch(missing);
    if (!info?.isFile()) { if (info) other++; continue; }
    const add = (t: Tally) => { t.objects++; t.bytes += info.size; };
    add(scanned);
    if (retained.live.has(hash)) add(live);
    else if (info.mtimeMs >= cutoff) add(young);
    else candidates.push({ hash, path, bytes: info.size });
  }
  progress(`${scanned.objects} objects scanned; ${candidates.length} unreferenced and older than the grace period`);
  await options.beforeRemoval?.(candidates.map((c) => c.hash));

  let kept = 0;
  for (const candidate of candidates) {
    if (!remove) { deleted.objects++; deleted.bytes += candidate.bytes; continue; }
    const aside = `${candidate.path}.${crypto.randomUUID()}.collect`;
    try { await rename(candidate.path, aside); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const info = await lstat(aside);
    if (info.mtimeMs >= cutoff) {
      await restore(aside, candidate.path);
      kept++;
      young.objects++; young.bytes += info.size;
      continue;
    }
    await unlink(aside);
    deleted.objects++; deleted.bytes += info.size;
  }
  if (remove) progress(`deleted ${deleted.objects} objects, ${deleted.bytes} bytes`);

  return {
    mode: remove ? "delete" : "dry-run",
    dataRoot: root,
    graceHours: graceMs / 3_600_000,
    cutoff: new Date(cutoff).toISOString(),
    rows: retained.rows,
    entries: retained.entries,
    scanned, live, young, deleted, kept,
    absent: retained.absent,
    other,
    recovered,
    ms: Math.round(performance.now() - started),
  };
}

/** Link a set-aside object back under its name (a writer may already have
 * republished it) and drop the aside name. */
async function restore(aside: string, path: string): Promise<void> {
  try { await link(aside, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await unlink(aside);
}

async function storeFiles(objectsRoot: string): Promise<Array<{ shard: string; name: string }>> {
  const files: Array<{ shard: string; name: string }> = [];
  for (const shard of await readdir(objectsRoot)) {
    if (!SHARD.test(shard)) continue;
    const names = await readdir(join(objectsRoot, shard)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return [] as string[];
      throw error;
    });
    for (const name of names) files.push({ shard, name });
  }
  return files;
}

function missing(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}

const USAGE = "usage: bun run packages/canopyd/src/collect-objects.ts <data-root> [--delete] [--grace-hours N]";

if (import.meta.main) {
  const args = process.argv.slice(2);
  let dataRoot: string | undefined, remove = false, graceHours = 24;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--delete") remove = true;
    else if (arg === "--grace-hours") {
      graceHours = Number(args[++i]);
      if (!Number.isFinite(graceHours) || graceHours < 0) { console.error(USAGE); process.exit(2); }
    } else if (!arg.startsWith("--") && !dataRoot) dataRoot = arg;
    else { console.error(USAGE); process.exit(2); }
  }
  if (!dataRoot) { console.error(USAGE); process.exit(2); }
  const report = await collectObjects(dataRoot, {
    delete: remove,
    graceMs: graceHours * 3_600_000,
    progress: (message) => console.error(`collect-objects: ${message}`),
  });
  console.log(JSON.stringify(report));
}
