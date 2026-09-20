#!/usr/bin/env bun
import { resolve } from "node:path";
import { ObjectStore } from "@overstory/object-store";
import { merge } from "./index.ts";
import { workerObjects } from "./worker-objects.ts";
import { CheckpointBatchLimitError } from "./checkpoint-batch.ts";
import { CHECKPOINT_BATCH_TOO_LARGE_EXIT } from "./checkpoint.ts";
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
async function* requests(lines: boolean): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    if (lines) {
      let end: number;
      while ((end = pending.indexOf(10)) !== -1) {
        if (end > maxRequestBytes)
          throw new Error("Merge request exceeds byte budget");
        yield pending.subarray(0, end).toString("utf8");
        pending = pending.subarray(end + 1);
      }
    }
    if (pending.length > maxRequestBytes)
      throw new Error("Merge request exceeds byte budget");
  }
  if (pending.length || !lines) yield pending.toString("utf8");
}

/** Storage paths are process configuration, never request-controlled capabilities. */
export async function run(args = process.argv.slice(2)): Promise<void> {
  const mode = args.shift();
  if (mode !== "evaluate" && mode !== "serve")
    throw new Error(
      "Usage: arbor-merge evaluate|serve --objects DIR --staging DIR",
    );
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
  if (mode === "evaluate") {
    for await (const text of requests(false))
      process.stdout.write(
        JSON.stringify(await merge(JSON.parse(text), objects)) + "\n",
      );
  } else {
    // Sequential JSON-lines request/response. No IDs or multiplexing are needed.
    for await (const line of requests(true)) {
      try {
        process.stdout.write(
          JSON.stringify(await timed(objects, (counted) => merge(JSON.parse(line), counted))) + "\n",
        );
      } catch (error) {
        process.stdout.write(
          JSON.stringify({
            error: {
              ...(error instanceof CheckpointBatchLimitError ? {code: "checkpoint-batch-too-large"} : {}),
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
}
if (import.meta.main)
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = error instanceof CheckpointBatchLimitError ? CHECKPOINT_BATCH_TOO_LARGE_EXIT : 1;
  });
