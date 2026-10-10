/** Read-only inputs; all experimental writes go to a fresh temporary cache.
 * bun packages/overstoryd-merge/scripts/benchmark-cache.ts CHECKPOINT.json ... */
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { hashObject } from "@ovst/protocol";
import { decodeRetainedState, encodeRetainedState } from "../src/retained-state.ts";
import { CheckpointStore } from "../src/checkpoint-store.ts";
import type { SavedCheckpoint } from "../src/sidecar.ts";

if (process.argv[2] === "--restore") {
  const cache = new CheckpointStore(process.argv[3]!);
  const started = performance.now();
  const checkpoint = cache.read(process.argv[4]!, process.argv[5]!)!;
  console.log(JSON.stringify({ restoreMs: performance.now() - started, states: checkpoint.states.size,
    estimatedBytes: [...checkpoint.states.values()].reduce((n, s) => n + s.bytes, 0), peakRSS: process.resourceUsage().maxRSS }));
  cache.close(); process.exit(0);
}
const files = process.argv.slice(2);
if (!files.length) throw new Error("Pass one or more legacy checkpoint files");
const directory = await mkdtemp(join(tmpdir(), "story-cache-benchmark-"));
const cache = new CheckpointStore(directory);
const rows = [];
const identities: Array<[string, string]> = [];
for (const file of files) {
  const bytes = await readFile(file);
  const started = performance.now();
  const legacy = JSON.parse(bytes.toString());
  const states = new Map(Object.entries(legacy.states).map(([id, raw]) => {
    const decoded = decodeRetainedState(raw);
    if (id !== decoded.id) throw new Error("Legacy identity mismatch");
    return [id, decoded.state] as const;
  }));
  const decodedMs = performance.now() - started;
  const checkpoint: SavedCheckpoint = { ...legacy, states,
    objects: legacy.objects.map(([id, value]: [string, string]) => [id, Buffer.from(value, "base64")]) };
  const saveStart = performance.now();
  cache.write(checkpoint);
  identities.push([checkpoint.tree, checkpoint.entry]);
  const saveMs = performance.now() - saveStart;
  // Verify exact shape and key order, beyond semantic identities alone.
  const restoreStart = performance.now();
  const restored = cache.read(checkpoint.tree, checkpoint.entry)!;
  const restoreMs = performance.now() - restoreStart;
  for (const [id, state] of restored.states) {
    if (hashObject(Buffer.from(JSON.stringify(encodeRetainedState(state)))) !== hashObject(Buffer.from(JSON.stringify(legacy.states[id]))))
      throw new Error("Checkpoint representation changed");
  }
  rows.push({ originalBytes: bytes.length, gzipBytes: gzipSync(bytes).length, decodedMs, saveMs, restoreMs });
}
cache.close();
const cold = [];
for (const [tree, entry] of identities) {
  const child = Bun.spawn([process.execPath, import.meta.path, "--restore", directory, tree, entry], { stdout: "pipe", stderr: "inherit" });
  cold.push(JSON.parse(await new Response(child.stdout).text()));
  if (await child.exited !== 0) throw new Error("Cold restore failed");
}
console.log(JSON.stringify({ directory, rows, cold, databaseBytes: (await stat(join(directory, "records-v2.sqlite"))).size,
  peakRSS: process.resourceUsage().maxRSS }, null, 2));
