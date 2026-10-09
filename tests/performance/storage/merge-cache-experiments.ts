/** Performance 002 experiments on copied saved merge states (a copy of
 * `merge-cache/`, in the whole-JSON format `<tree>/<entry digest>.json`, or
 * one `merge-cache-fixture.ts` wrote): never point it at a live cache. For the
 * saves in time order it measures the current files, compressed copies, and
 * the shared-record checkpoint store at several granularities, batch sizes and
 * zstd levels; then it restores every checkpoint in a fresh process and checks
 * that each state's identity and contents match the original decoding.
 *
 *   bun tests/performance/storage/merge-cache-experiments.ts <saves-copy> [--work DIR] [--quick] [--json FILE]
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { constants, gzipSync, zstdCompressSync } from "node:zlib";
import { hashObject, stableJSONString } from "@overstory/protocol";
import {
  decodeRetainedState, encodeStateRecords, StateRecordReader, viewState,
  type PublishedRecords, type RecordOptions, type RetainedState,
} from "../../../packages/canopyd-merge/src/retained-state.ts";
import { savedStatesIn } from "../../../packages/canopyd-merge/src/saved-states.ts";

interface Save { tree: string; entry: string; path: string; bytes: number; mtime: number }

function listSaves(directory: string): Save[] {
  const out: Save[] = [];
  for (const tree of readdirSync(directory)) {
    const dir = join(directory, tree);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const match = /^([a-f0-9]{64})\.json$/.exec(name);
      if (!match) continue;
      const info = statSync(join(dir, name));
      out.push({ tree, entry: `sha256:${match[1]}`, path: join(dir, name), bytes: info.size, mtime: info.mtimeMs });
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

interface Legacy {
  format: string; tree: string; entry: string; object: string; state: string; decisions: unknown[];
  states: Record<string, unknown>; objects: Array<[string, string]>;
}

const MB = (n: number) => +(n / 1048576).toFixed(2);
const ms = (n: number) => Math.round(n);
const zstd = (bytes: Uint8Array, level: number) => zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: level } } as never);

function heapMB() { Bun.gc(true); return MB(process.memoryUsage().heapUsed); }

/** Records of every save, encoded in time order against one published map
 * (as one sidecar process saving them would). */
function encodeAll(decoded: Array<{ save: Save; legacy: Legacy; states: Map<string, RetainedState> }>, options: RecordOptions) {
  const published: PublishedRecords = new WeakMap();
  const all = new Map<string, Uint8Array>();
  const perSave: Array<{ entry: string; newRecords: number; newRawMB: number; encodeMs: number; reused: number }> = [];
  const manifests: Array<{ save: Save; manifest: Uint8Array; states: Record<string, string>; records: Map<string, Uint8Array>; reused: Set<string> }> = [];
  for (const { save, legacy, states } of decoded) {
    const started = performance.now();
    const records = new Map<string, Uint8Array>(), reused = new Set<string>(), ids: Record<string, string> = {};
    for (const [id, state] of states) {
      const encoded = encodeStateRecords(state, published, options);
      for (const [r, b] of encoded.records) if (!all.has(r)) records.set(r, b);
      for (const r of encoded.reused) reused.add(r);
      for (const [value, r] of encoded.fresh) published.set(value, r);
      ids[id] = encoded.id;
    }
    const encodeMs = performance.now() - started;
    // Cache-only objects, binary and stored once by hash.
    for (const [hash, base64] of legacy.objects) if (!all.has(hash) && !records.has(hash)) records.set(hash, new Uint8Array(Buffer.from(base64, "base64")));
    for (const [r, b] of records) all.set(r, b);
    const manifest = new TextEncoder().encode(JSON.stringify({ format: "arbor-merge-checkpoint-1", tree: save.tree, entry: save.entry,
      object: legacy.object, state: legacy.state, decisions: legacy.decisions, states: ids }));
    manifests.push({ save, manifest, states: ids, records, reused });
    perSave.push({ entry: save.entry.slice(7, 19), newRecords: records.size, newRawMB: MB([...records.values()].reduce((n, b) => n + b.byteLength, 0)), encodeMs: ms(encodeMs), reused: reused.size });
  }
  return { all, perSave, manifests };
}

/** Compressed size of `records` in batches of `batchBytes`, in write order. */
function batched(records: Map<string, Uint8Array>, batchBytes: number, level: number) {
  let compressed = 0, batches = 0, pending: Uint8Array[] = [], size = 0;
  const started = performance.now();
  const flush = () => {
    if (!pending.length) return;
    const joined = new Uint8Array(size);
    let o = 0;
    for (const b of pending) { joined.set(b, o); o += b.byteLength; }
    compressed += zstd(joined, level).byteLength; batches++;
    pending = []; size = 0;
  };
  for (const bytes of records.values()) { pending.push(bytes); size += bytes.byteLength; if (size >= batchBytes) flush(); }
  flush();
  return { compressedMB: MB(compressed), batches, ms: ms(performance.now() - started) };
}

if (import.meta.main && !process.argv[2]?.startsWith("--restore")) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const bool = (name: string) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
  const quick = bool("--quick");
  const jsonOut = flag("--json");
  const directory = resolve(args[0] ?? "");
  const work = resolve(flag("--work") ?? join(directory, "..", `merge-cache-experiments-${process.pid}`));
  if (!args[0]) { console.error("usage: merge-cache-experiments.ts <saves-copy> [--work DIR] [--quick] [--json FILE]"); process.exit(2); }
  const progress = (m: string) => console.error(`merge-cache-experiments: ${m}`);
  const saves = listSaves(directory);
  if (!saves.length) throw new Error("No saves found");

  // ---- The current format ---------------------------------------------------
  const baseline = { saves: saves.length, rawMB: 0, gzipMB: 0, zstd3MB: 0, parseMs: 0, decodeMs: 0, heapBeforeMB: heapMB(), heapAfterMB: 0 };
  const decoded: Array<{ save: Save; legacy: Legacy; states: Map<string, RetainedState> }> = [];
  const views = new Map<string, string>();
  const shape = new Map<string, Record<string, number>>();
  for (const save of saves) {
    const bytes = readFileSync(save.path);
    baseline.rawMB += MB(bytes.byteLength);
    baseline.gzipMB += MB(gzipSync(bytes).byteLength);
    baseline.zstd3MB += MB(zstd(bytes, 3).byteLength);
    let started = performance.now();
    const legacy = JSON.parse(bytes.toString("utf8")) as Legacy;
    baseline.parseMs += performance.now() - started;
    started = performance.now();
    const states = new Map<string, RetainedState>();
    for (const [id, encoded] of Object.entries(legacy.states)) {
      const { id: actual, state } = decodeRetainedState(encoded);
      if (actual !== id) throw new Error(`Save ${save.entry} has a state that does not match its identity`);
      states.set(id, state);
      const parts: Record<string, number> = {};
      for (const [field, value] of Object.entries(encoded as Record<string, unknown>)) parts[field] = JSON.stringify(value).length;
      shape.set(id.slice(7, 19), parts);
    }
    baseline.decodeMs += performance.now() - started;
    for (const [id, state] of states) views.set(id, hashObject(new TextEncoder().encode(stableJSONString(viewState(state)))));
    decoded.push({ save, legacy, states });
    progress(`${save.tree}/${save.entry.slice(7, 19)}: ${MB(bytes.byteLength)} MB, ${states.size} states, ${legacy.objects.length} objects`);
  }
  baseline.heapAfterMB = heapMB();
  for (const key of ["rawMB", "gzipMB", "zstd3MB"] as const) baseline[key] = +baseline[key].toFixed(2);
  baseline.parseMs = ms(baseline.parseMs); baseline.decodeMs = ms(baseline.decodeMs);
  const objectHashes = new Map<string, number>();
  for (const { legacy } of decoded) for (const [hash, base64] of legacy.objects) objectHashes.set(hash, Buffer.from(base64, "base64").byteLength);
  const objects = { unique: objectHashes.size, rawMB: MB([...objectHashes.values()].reduce((n, b) => n + b, 0)),
    referencedTotal: decoded.reduce((n, d) => n + d.legacy.objects.length, 0) };
  progress(`baseline ${JSON.stringify(baseline)}; objects ${JSON.stringify(objects)}`);

  // ---- Granularity, batch size and level ---------------------------------------
  const granularity: Array<Record<string, unknown>> = [];
  const variants: RecordOptions[] = quick ? [{ minRecordBytes: 256, minStringChars: 256 }]
    : [{ minRecordBytes: 64, minStringChars: 128 }, { minRecordBytes: 256, minStringChars: 256 }, { minRecordBytes: 1024, minStringChars: 1024 }, { minRecordBytes: 4096, minStringChars: 4096 }];
  let chosen: ReturnType<typeof encodeAll> | undefined;
  for (const options of variants) {
    const encoded = encodeAll(decoded, options);
    const raw = [...encoded.all.values()].reduce((n, b) => n + b.byteLength, 0);
    const row = { ...options, records: encoded.all.size, rawMB: MB(raw), batched1M_l3: batched(encoded.all, 1 << 20, 3), perSave: encoded.perSave };
    granularity.push(row);
    progress(`records ≥${options.minRecordBytes} B / strings ≥${options.minStringChars}: ${row.records} records, ${row.rawMB} MB raw, ${row.batched1M_l3.compressedMB} MB compressed; per save ${JSON.stringify(encoded.perSave)}`);
    if (options.minRecordBytes === 256) chosen = encoded;
  }
  const compression: Array<Record<string, unknown>> = [];
  for (const batchBytes of quick ? [1 << 20] : [256 << 10, 1 << 20, 4 << 20])
    for (const level of quick ? [3] : [1, 3, 9, 19]) {
      const r = batched(chosen!.all, batchBytes, level);
      compression.push({ batchKB: batchBytes >> 10, level, ...r });
      progress(`batches ${batchBytes >> 10} KiB, zstd ${level}: ${r.compressedMB} MB in ${r.ms} ms`);
    }

  // ---- The store: write each checkpoint, then restore in a fresh process ------
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const store = savedStatesIn(work);
  const writes: Array<Record<string, unknown>> = [];
  for (const m of chosen!.manifests) {
    const started = performance.now();
    await store.write(m.save.tree, m.save.entry, m.manifest, m.records, m.reused, []);
    writes.push({ entry: m.save.entry.slice(7, 19), ms: ms(performance.now() - started), records: m.records.size });
  }
  const stats = store.stats();
  store.close();
  const files = readdirSync(work).filter((name) => name.startsWith("states.sqlite3"));
  const storeBytes = files.reduce((n, name) => n + statSync(join(work, name)).size, 0);
  progress(`store: ${MB(storeBytes)} MB on disk (${files.join(", ")}), ${stats.records} records in ${stats.batches} batches; writes ${JSON.stringify(writes)}`);
  const restores: Array<Record<string, unknown>> = [];
  for (const m of chosen!.manifests) {
    const child = Bun.spawn([process.execPath, import.meta.path, "--restore", work, m.save.entry], { stdout: "pipe", stderr: "inherit" });
    const result = JSON.parse(await new Response(child.stdout).text()) as { ms: number; decoded: number; heapMB: number; rssMB: number; views: Record<string, string> };
    if (await child.exited !== 0) throw new Error("Restore failed");
    for (const [id, view] of Object.entries(result.views))
      if (views.get(id) !== view) throw new Error(`Restored state ${id} differs from the original`);
    restores.push({ entry: m.save.entry.slice(7, 19), ms: result.ms, decodedRecords: result.decoded, heapMB: result.heapMB, rssMB: result.rssMB, states: Object.keys(result.views).length });
  }
  const legacyRestores: Array<Record<string, unknown>> = [];
  for (const { save } of decoded) {
    const child = Bun.spawn([process.execPath, import.meta.path, "--restore-legacy", save.path], { stdout: "pipe", stderr: "inherit" });
    legacyRestores.push({ entry: save.entry.slice(7, 19), ...JSON.parse(await new Response(child.stdout).text()) });
    await child.exited;
  }
  progress(`restores ${JSON.stringify(restores)}; whole-JSON restores ${JSON.stringify(legacyRestores)}`);
  rmSync(work, { recursive: true, force: true });
  const report = { baseline, objects, shape: Object.fromEntries(shape), granularity, compression,
    store: { diskMB: MB(storeBytes), ...stats, rawMB: MB(stats.raw), compressedMB: MB(stats.compressed), writes }, restores, legacyRestores };
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

/** In a fresh process: rebuild a checkpoint's states from the store. */
async function restoreChild(work: string, entry: string) {
  const store = savedStatesIn(work);
  const started = performance.now();
  const manifest = JSON.parse(new TextDecoder().decode((await store.manifest(entry))!)) as { states: Record<string, string> };
  const reader = new StateRecordReader((id) => store.record(id));
  const restored = Object.entries(manifest.states).map(([id, record]) => {
    const { id: actual, state } = reader.state(record);
    if (actual !== id) throw new Error(`Restored identity ${actual} is not ${id}`);
    return [id, state] as const;
  });
  const elapsed = performance.now() - started;
  const heap = heapMB(), rss = MB(process.memoryUsage().rss);
  const views = Object.fromEntries(restored.map(([id, state]) => [id, hashObject(new TextEncoder().encode(stableJSONString(viewState(state))))]));
  console.log(JSON.stringify({ ms: ms(elapsed), decoded: reader.decoded, heapMB: heap, rssMB: rss, views }));
}

/** In a fresh process: the current format's restore, for comparison. */
function restoreLegacyChild(path: string) {
  const started = performance.now();
  const legacy = JSON.parse(readFileSync(path, "utf8")) as Legacy;
  for (const encoded of Object.values(legacy.states)) decodeRetainedState(encoded);
  const objects = legacy.objects.map(([hash, base64]) => [hash, new Uint8Array(Buffer.from(base64, "base64"))] as const);
  for (const [hash, bytes] of objects) if (hashObject(bytes) !== hash) throw new Error("Object mismatch");
  const elapsed = performance.now() - started;
  console.log(JSON.stringify({ ms: ms(elapsed), heapMB: heapMB(), rssMB: MB(process.memoryUsage().rss) }));
}

if (process.argv[2] === "--restore") await restoreChild(process.argv[3]!, process.argv[4]!);
if (process.argv[2] === "--restore-legacy") restoreLegacyChild(process.argv[3]!);
