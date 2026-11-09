/**
 * Protocol 002 rehearsal: build the entry time index from a copy of a real
 * data root, cold, the way a deploy does, and check what it answers.
 *
 *   bun tests/performance/rehearse-entry-times.ts <copy of /data>
 *
 * Works on the copy in place (run it on a copy you can throw away). Reports:
 * - the backfill's wall time, updates and rows, object reads, and the worst
 *   event-loop stall while it ran (requests are served meanwhile);
 * - a timed snapshot and a timed path read of each tree's head;
 * - how the heads' times compare with `entry_metadata` (the old route);
 * - a second cold start with the index present, and a rebuild from nothing
 *   that must give the same times.
 */
import { Database } from "bun:sqlite";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { HostDaemon } from "../../packages/overstoryd/src/index.ts";
import { bundleEntries, type ObjectHash } from "../../packages/protocol/src/index.ts";

const dataRoot = process.argv[2] ?? "";
if (!dataRoot) throw new Error("usage: rehearse-entry-times.ts <copy of /data>");
const indexPath = join(dataRoot, "entry-times.sqlite3");
const ms = (start: number) => Math.round(performance.now() - start);

async function removeIndex() {
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${indexPath}${suffix}`, { force: true });
}

/** The worst gap between 10 ms ticks while `work` runs: how long a request could wait. */
async function withStallMeter<T>(work: () => Promise<T>): Promise<{ value: T; worstStallMs: number }> {
  let last = performance.now(), worst = 0;
  const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 10); last = now; }, 10);
  try { return { value: await work(), worstStallMs: Math.round(worst) }; }
  finally { clearInterval(timer); }
}

async function coldStart(label: string) {
  const started = performance.now();
  const host = await HostDaemon.open(dataRoot);
  const opened = ms(started);
  const before = host.objectCounters();
  const { worstStallMs } = await withStallMeter(() => host.entryTimes.catchUpAll());
  const after = host.objectCounters();
  const report = {
    phase: label,
    openMs: opened,
    indexMs: ms(started) - opened,
    worstStallMs,
    objectReads: (after.reads ?? 0) - (before.reads ?? 0),
    readFiles: (after["read-files"] ?? 0) - (before["read-files"] ?? 0),
    readMs: Math.round((after["read-ms"] ?? 0) - (before["read-ms"] ?? 0)),
    ...host.entryTimes.stats(),
    indexBytes: (await stat(indexPath)).size + (await stat(`${indexPath}-wal`).then((s) => s.size, () => 0)),
  };
  console.log(JSON.stringify(report));
  return host;
}

async function headTimes(host: HostDaemon) {
  const db = new Database(join(dataRoot, "overstoryd.sqlite3"), { readonly: true });
  const trees = db.query("SELECT id, ref FROM trees").all() as Array<{ id: string; ref: ObjectHash }>;
  const metadata = db.query("SELECT path, modified_at FROM entry_metadata WHERE tree_id = ?");
  const all: Record<string, Record<string, number>> = {};
  const comparison = { entries: 0, same: 0, earlier: 0, later: 0, noMetadata: 0 };
  const examples: string[] = [];
  let snapshotMs = 0, pathReadMs = 0;
  for (const { id, ref } of trees) {
    let started = performance.now();
    const snapshot = await host.snapshotForRoot(id, ref);
    if (!snapshot) continue;
    const times = await host.entryTimesFor(id, ref, snapshot.objects);
    snapshotMs += performance.now() - started;
    all[id] = times;
    // A path read of the deepest page dated in the head.
    const deepest = Object.keys(times).sort((a, b) => b.split("/").length - a.split("/").length)[0];
    if (deepest) {
      started = performance.now();
      const objects = await host.pathRead(id, ref, deepest);
      await host.entryTimesFor(id, ref, objects!);
      pathReadMs += performance.now() - started;
    }
    if (Object.keys(times).length !== bundleEntries(ref, snapshot.objects).size) throw new Error(`${id}: times do not cover the head`);
    const old = new Map((metadata.all(id) as Array<{ path: string; modified_at: number }>).map((row) => [row.path, row.modified_at]));
    for (const [path, at] of Object.entries(times)) {
      comparison.entries += 1;
      const was = old.get(path);
      if (was === undefined) comparison.noMetadata += 1;
      else if (was === at) comparison.same += 1;
      else if (at < was) { comparison.earlier += 1; if (examples.length < 12) examples.push(`${id} ${path}: ${new Date(was).toISOString()} → ${new Date(at).toISOString()}`); }
      else { comparison.later += 1; if (examples.length < 12) examples.push(`LATER ${id} ${path}: ${new Date(was).toISOString()} → ${new Date(at).toISOString()}`); }
    }
  }
  db.close();
  console.log(JSON.stringify({ phase: "heads", trees: trees.length, snapshotMsTotal: Math.round(snapshotMs), pathReadMsTotal: Math.round(pathReadMs), comparison }));
  for (const line of examples) console.log(`  ${line}`);
  return all;
}

await removeIndex();
let host = await coldStart("first start: backfill from history");
const first = await headTimes(host);
await host[Symbol.asyncDispose]();

host = await coldStart("second start: index present");
await host[Symbol.asyncDispose]();

await removeIndex();
host = await coldStart("rebuild from nothing");
const rebuilt = await headTimes(host);
await host[Symbol.asyncDispose]();
const same = JSON.stringify(first) === JSON.stringify(rebuilt);
console.log(JSON.stringify({ phase: "rebuild matches", same }));
if (!same) process.exitCode = 1;
