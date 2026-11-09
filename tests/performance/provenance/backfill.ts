/** Performance 004 step 3: time a cold provenance backfill of one tree on a
 * production copy, with answered entries rebound (no sidecar).
 *   bun tests/performance/provenance/backfill.ts <data-root> <tree> */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ObjectStore } from "@ovst/object-store";
import { decodeLogEntry } from "@ovst/merge-protocol";
import type { ObjectHash } from "@ovst/protocol";
import { ProvenanceStore } from "../../../packages/overstoryd/src/updates/provenance-store.ts";
import { acceptedEntries } from "../../support/log-entries.ts";

const [root, tree] = process.argv.slice(2);
if (!root || !tree) throw Error("usage: backfill.ts <data-root> <tree>");
await rm(join(root, "provenance"), { recursive: true, force: true });
const store = new ObjectStore(join(root, "objects"));
const provenance = new ProvenanceStore(root, store, async (hash) => decodeLogEntry(await store.read(hash)));
const entries = acceptedEntries(root, tree);
const before = { ...store.writes };
let started = performance.now();
const filled = await provenance.fill(entries.at(-1)!.hash as ObjectHash);
const ms = performance.now() - started;
console.log(JSON.stringify({ filled, seconds: Math.round(ms / 1000), objects: store.writes.objects - before.objects }));
// A warm writer: the head's index again from its predecessor, as acceptance would.
const head = entries.at(-1)!;
started = performance.now();
const prepared = await provenance.prepare(head.entry, undefined, new Map());
console.log(JSON.stringify({ prepareMs: Math.round(performance.now() - started), records: prepared?.records.size, bytes: [...prepared?.records.values() ?? []].reduce((n, b) => n + b.length, 0) }));
