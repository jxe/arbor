#!/usr/bin/env bun
import { resolve } from "node:path";
import { IntentError } from "./intent-model.ts";
import { ObjectStore } from "@overstory/object-store";
import { merge } from "./index.ts";
import { workerObjects } from "./worker-objects.ts";
import { CheckpointBatchLimitError } from "./checkpoint-batch.ts";
import { engineDiagnostics } from "./intent-engine.ts";
import type { MergeObjects } from "./index.ts";

/** Time one request and count its object reads; the summary goes to stderr as
 * one JSON line for the host's diagnostics. No request content or hashes. */
async function timed<T>(objects: MergeObjects, work: (objects: MergeObjects) => Promise<T>): Promise<T> {
  const counts = { reads: 0, "read-bytes": 0, "read-ms": 0, stores: 0 };
  const counted: MergeObjects = {
    read: async (hash) => {
      const started = performance.now();
      const bytes = await objects.read(hash);
      counts.reads++; counts["read-bytes"] += bytes.byteLength; counts["read-ms"] += performance.now() - started;
      return bytes;
    },
    store: async (values) => { for (const _ of values) counts.stores++; return objects.store(values); },
  };
  for (const key of Object.keys(engineDiagnostics)) delete engineDiagnostics[key];
  const started = performance.now();
  try {
    return await work(counted);
  } finally {
    const timings = { "total-ms": performance.now() - started, ...counts, ...engineDiagnostics };
    process.stderr.write(JSON.stringify({ timings }) + "\n");
  }
}

const maxRequestBytes = 8 * 1024 * 1024;
/** One request per stdin line. Chunks are kept as a list until a line ends. */
async function* requests(): AsyncGenerator<string> {
  let chunks: Buffer[] = [], bytes = 0;
  for await (const input of process.stdin) {
    let chunk = Buffer.from(input), end: number;
    while ((end = chunk.indexOf(10)) !== -1) {
      if (bytes + end > maxRequestBytes)
        throw new Error("Merge request exceeds byte budget");
      chunks.push(chunk.subarray(0, end));
      yield Buffer.concat(chunks).toString("utf8");
      chunks = []; bytes = 0;
      chunk = chunk.subarray(end + 1);
    }
    chunks.push(chunk); bytes += chunk.length;
    if (bytes > maxRequestBytes)
      throw new Error("Merge request exceeds byte budget");
  }
  if (bytes) yield Buffer.concat(chunks).toString("utf8");
}

/** Storage paths are process configuration, never request-controlled capabilities. */
export async function run(args = process.argv.slice(2)): Promise<void> {
  const mode = args.shift();
  if (mode !== "serve")
    throw new Error("Usage: arbor-merge serve --objects DIR --staging DIR");
  const options = new Map<string, string>();
  while (args.length) {
    const key = args.shift()!,
      value = args.shift();
    if (!["--objects", "--staging"].includes(key) || !value || options.has(key))
      throw new Error("Invalid merge tool options");
    options.set(key, resolve(value));
  }
  if (
    !options.has("--objects") ||
    !options.has("--staging") ||
    options.get("--objects") === options.get("--staging")
  )
    throw new Error("Separate shared and staging directories are required");
  const cacheMB = Number(process.env.ARBOR_OBJECT_CACHE_MB);
  const shared = new ObjectStore(options.get("--objects")!, { cacheBytes: (Number.isFinite(cacheMB) && cacheMB >= 0 ? cacheMB : 256) * 1024 * 1024 });
  const staging = new ObjectStore(options.get("--staging")!);
  const objects = workerObjects(shared, staging);
  // Sequential JSON-lines request/response. No IDs or multiplexing are needed.
  for await (const line of requests()) {
    try {
      process.stdout.write(
        JSON.stringify(await timed(objects, (counted) => merge(JSON.parse(line), counted))) + "\n",
      );
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          error: {
            ...(error instanceof CheckpointBatchLimitError ? {code: "checkpoint-batch-too-large"}
              : error instanceof IntentError ? {code: error.code} : {}),
            message:
              error instanceof Error
                ? error.message
                : "Merge evaluation failed",
          },
        }) + "\n",
      );
    }
  }
}
if (import.meta.main)
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
