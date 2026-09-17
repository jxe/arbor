#!/usr/bin/env bun
import { resolve } from "node:path";
import { ObjectStore } from "@arbor/object-store";
import { merge } from "./index.ts";
import { hashObject } from "@arbor/wire";

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
  const shared = new ObjectStore(options.get("--objects")!);
  const staging = new ObjectStore(options.get("--staging")!);
  const objects = {
    read: async (hash: string) =>
      (await staging.find(hash)) ?? (await shared.read(hash)),
    store: async (values: Parameters<ObjectStore["store"]>[0]) => {
      for (const value of values) {
        if (hashObject(value.bytes) !== value.hash) throw new Error("Object hash mismatch");
        // Existing immutable material is already available to both processes.
        if (!(await shared.find(value.hash))) await staging.store([value]);
      }
    },
  };
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
          JSON.stringify(await merge(JSON.parse(line), objects)) + "\n",
        );
      } catch (error) {
        process.stdout.write(
          JSON.stringify({
            error: {
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
    process.exitCode = 1;
  });
