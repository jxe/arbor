/** Cold restores from a private checkpoint cache, read-only.
 * bun packages/overstoryd-merge/scripts/benchmark-cache.ts CACHE_DIRECTORY */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { CheckpointStore } from "../src/checkpoint-store.ts";

if (process.argv[2] === "--restore") {
  const cache = new CheckpointStore(process.argv[3]!);
  const started = performance.now();
  const checkpoint = cache.read(process.argv[4]!, process.argv[5]!)!;
  console.log(JSON.stringify({ restoreMs: performance.now() - started, states: checkpoint.states.size,
    estimatedBytes: [...checkpoint.states.values()].reduce((n, s) => n + s.bytes, 0), peakRSS: process.resourceUsage().maxRSS }));
  cache.close(); process.exit(0);
}
const directory = process.argv[2];
if (!directory) throw new Error("Pass a checkpoint cache directory");
const cache = new CheckpointStore(directory);
const identities = cache.list();
cache.close();
const cold = [];
for (const { tree, entry } of identities) {
  const child = Bun.spawn([process.execPath, import.meta.path, "--restore", directory, tree, entry], { stdout: "pipe", stderr: "inherit" });
  cold.push({ tree, entry, ...JSON.parse(await new Response(child.stdout).text()) });
  if (await child.exited !== 0) throw new Error("Cold restore failed");
}
console.log(JSON.stringify({ directory, cold, databaseBytes: (await stat(join(directory, "records-v2.sqlite"))).size }, null, 2));
