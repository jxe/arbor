#!/usr/bin/env bun
import { resolve } from "node:path";
import { holdsObject, ObjectStore } from "@overstory/object-store";
import { MergeRefusal } from "@overstory/merge-protocol";
import { EvaluationFailure } from "./engine-contract.ts";
import { IntentError } from "./intent-model.ts";
import { engineDiagnostics } from "./intent-engine.ts";
import { savedStatesIn } from "./saved-states.ts";
import { REPLAY_MILLIS, Sidecar } from "./sidecar.ts";

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
export async function run(args = process.argv.slice(2), testing: { treeMerge?: ConstructorParameters<typeof Sidecar>[2] } = {}): Promise<void> {
  const mode = args.shift();
  if (mode !== "serve")
    throw new Error("Usage: arbor-merge serve --objects DIR --staging DIR [--cache DIR]");
  const options = new Map<string, string>();
  while (args.length) {
    const key = args.shift()!,
      value = args.shift();
    if (!["--objects", "--staging", "--cache"].includes(key) || !value || options.has(key))
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
  const stateMB = Number(process.env.ARBOR_MERGE_CACHE_MB);
  const replayMS = Number(process.env.ARBOR_MERGE_REPLAY_MS);
  const sidecar = new Sidecar({
    shared: { find: (hash) => shared.find(hash), has: (hash) => holdsObject(shared, hash) },
    staging: { find: (hash) => staging.find(hash), stage: (values) => staging.stage(values) },
    ...(options.has("--cache") ? { saved: savedStatesIn(options.get("--cache")!) } : {}),
  }, (Number.isFinite(stateMB) && stateMB >= 0 ? stateMB : 512) * 1024 * 1024, testing.treeMerge,
  Number.isFinite(replayMS) && replayMS > 0 ? replayMS : REPLAY_MILLIS);
  // One question per line, one response per line, in order.
  for await (const line of requests()) {
    for (const key of Object.keys(engineDiagnostics)) delete engineDiagnostics[key];
    const started = performance.now();
    let response: unknown;
    try {
      response = await sidecar.answer(JSON.parse(line));
    } catch (error) {
      // A refusal is a property of the question; anything else is a failure
      // to answer it. A time budget (`limit`) or an unfinished rebuild
      // (`unavailable`) is such a failure, reported with its code so canopyd
      // offers a retry.
      response = error instanceof MergeRefusal || error instanceof IntentError
        ? { refusal: { code: error.code, message: error.message } }
        : { error: {
            message: error instanceof Error ? error.message : "Merge evaluation failed",
            ...(error instanceof EvaluationFailure && error.code ? { code: error.code } : {}),
          } };
    }
    // Diagnostics only: no request content or hashes.
    process.stderr.write(JSON.stringify({ timings: { "total-ms": performance.now() - started, replayed: sidecar.replayed, restored: sidecar.restored, ...engineDiagnostics } }) + "\n");
    process.stdout.write(JSON.stringify(response) + "\n");
    // After answering, so a save never delays an answer or changes one.
    await sidecar.save().catch((error) => {
      process.stderr.write(`Saving a state failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
}
if (import.meta.main)
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
