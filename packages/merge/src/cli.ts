#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { ObjectStore } from "@arbor/object-store";
import { merge, parseRequest } from "./index.ts";

/** Storage paths are process configuration, never request-controlled capabilities. */
export async function run(args = process.argv.slice(2)): Promise<void> {
  const mode = args.shift();
  if (mode !== "evaluate" && mode !== "serve") throw new Error("Usage: arbor-merge evaluate|serve --objects DIR --staging DIR");
  const options = new Map<string, string>();
  while (args.length) {
    const key = args.shift()!, value = args.shift();
    if (!["--objects", "--staging"].includes(key) || !value || options.has(key)) throw new Error("Invalid merge tool options");
    options.set(key, resolve(value));
  }
  if (!options.has("--objects") || !options.has("--staging") || options.get("--objects") === options.get("--staging")) throw new Error("Separate shared and staging directories are required");
  const shared = new ObjectStore(options.get("--objects")!);
  const staging = new ObjectStore(options.get("--staging")!);
  const objects = { read: async (hash: string) => await staging.find(hash) ?? await shared.read(hash), store: staging.store.bind(staging) };
  if (mode === "evaluate") {
    const request = parseRequest(JSON.parse(await Bun.stdin.text()));
    process.stdout.write(JSON.stringify(await merge(request, objects)) + "\n");
  } else {
    // Sequential JSON-lines request/response. No IDs or multiplexing are needed.
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      try { process.stdout.write(JSON.stringify(await merge(parseRequest(JSON.parse(line)), objects)) + "\n"); }
      catch (error) { process.stdout.write(JSON.stringify({ error: { message: error instanceof Error ? error.message : "Merge evaluation failed" } }) + "\n"); }
    }
  }
}
if (import.meta.main) run().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
