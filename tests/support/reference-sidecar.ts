#!/usr/bin/env bun
/**
 * A minimal merge sidecar written against the object store and the merge
 * question alone: the proof that they are enough. It keeps no cache. It walks
 * the head's and the base's entries back to their common entry, merges each
 * file three ways against that entry's root, and keeps the head's version of
 * a file both sides changed as a whole-file choice. Traces are read as
 * snapshots: a sidecar need not use them. Not an example to copy; the real
 * sidecar is `packages/canopyd-merge`.
 *
 *   reference-sidecar.ts serve --objects DIR --staging DIR [--cache DIR, unused]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { compareProtocolNames, decodeProtocolDirectory, encodeProtocolDirectory, type ProtocolDirectoryEntry } from "@overstory/protocol";

const args = process.argv.slice(2), option = (name: string) => args[args.indexOf(name) + 1]!;
const shared = option("--objects"), staging = option("--staging");
const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const file = (root: string, hash: string) => join(root, hash.slice(7, 9), hash.slice(9));

// The object store: shared objects first, then this question's staging.
async function get(hash: string): Promise<Uint8Array> {
  for (const root of [shared, staging]) {
    const bytes = await readFile(file(root, hash)).then((b) => new Uint8Array(b), () => null);
    if (bytes && sha(bytes) === hash) return bytes;
  }
  throw new Error(`Missing object ${hash}`);
}
const written: string[] = [];
async function put(bytes: Uint8Array): Promise<string> {
  const hash = sha(bytes);
  if (!(await readFile(file(shared, hash)).then(() => true, () => false))) {
    await mkdir(join(staging, hash.slice(7, 9)), { recursive: true });
    await writeFile(file(staging, hash), bytes);
    if (!written.includes(hash)) written.push(hash);
  }
  return hash;
}

type Entry = { previous: string | null; root: string; decisions: Decision[] };
type Decision = { key: string; path?: string[]; range?: [number, number]; dependencies: string[]; selected: number; alternatives: Array<{ object: string; contributions: unknown[] }> };
const entry = async (hash: string): Promise<Entry> => JSON.parse(new TextDecoder().decode(await get(hash)));
const entries = async (dir: string) => new Map(decodeProtocolDirectory(await get(dir)).entries.map((e) => [e.name, e]));
const same = (a?: ProtocolDirectoryEntry, b?: ProtocolDirectoryEntry) => JSON.stringify(a) === JSON.stringify(b);

async function at(root: string, path: string[]): Promise<ProtocolDirectoryEntry | undefined> {
  let dir = root;
  for (const [i, name] of path.entries()) {
    const found = (await entries(dir)).get(name);
    if (!found || i === path.length - 1) return found;
    if (!found.directory) return undefined;
    dir = found.directory;
  }
}
async function replace(root: string, path: string[], value: ProtocolDirectoryEntry | undefined): Promise<string> {
  const map = await entries(root), [name, ...rest] = path as [string, ...string[]];
  const child = rest.length ? { name, directory: await replace(map.get(name)!.directory!, rest, value) } : value;
  if (child) map.set(name, child); else map.delete(name);
  return put(encodeProtocolDirectory({ type: "directory", entries: [...map.values()].sort((a, b) => compareProtocolNames(a.name, b.name)) }));
}

/** Three-way merge of one directory; conflicting entries keep the head's. */
async function merge(base: string | undefined, mine: string, theirs: string, path: string[], conflicts: string[][]): Promise<string> {
  const [b, m, t] = await Promise.all([base ? entries(base) : new Map(), entries(mine), entries(theirs)]);
  const out: ProtocolDirectoryEntry[] = [];
  for (const name of new Set([...b.keys(), ...m.keys(), ...t.keys()])) {
    const [x, y, z] = [b.get(name), m.get(name), t.get(name)];
    if (same(y, z) || same(x, z)) { if (y) out.push(y); continue; }
    if (same(x, y)) { if (z) out.push(z); continue; }
    if (y?.directory && z?.directory) { out.push({ name, directory: await merge(x?.directory, y.directory, z.directory, [...path, name], conflicts) }); continue; }
    conflicts.push([...path, name]);
    if (y) out.push(y);
  }
  return put(encodeProtocolDirectory({ type: "directory", entries: out.sort((a, b) => compareProtocolNames(a.name, b.name)) }));
}

async function answer(question: any) {
  written.length = 0;
  // The common entry of the head's and the base's chains.
  const seen = new Set<string>();
  for (let at: string | null = question.base; at; at = (await entry(at)).previous) seen.add(at);
  let common: string | null = question.head;
  while (common && !seen.has(common)) common = (await entry(common)).previous;
  const head = await entry(question.head), mergeBase = common ? (await entry(common)).root : undefined;
  const candidate = question.candidate, conflicts: string[][] = [];
  const root = await merge(mergeBase, head.root, candidate.root, [], conflicts);
  // Open choices stay unless resolved or replaced; each is rebased onto the new root.
  const decisions: Decision[] = [];
  for (const d of head.decisions) {
    if (candidate.resolves.includes(d.key) || !d.path || d.range) continue;
    if (conflicts.some((p) => p.join("/") === d.path!.join("/"))) continue;
    const alternatives = [];
    for (const a of d.alternatives) alternatives.push({ ...a, object: await replace(root, d.path, await at(a.object, d.path)) });
    decisions.push({ ...d, alternatives, dependencies: [] });
  }
  for (const path of conflicts)
    decisions.push({
      key: `reference:${candidate.change}:${path.join("/")}`, path, dependencies: [], selected: 0,
      alternatives: [
        { object: root, contributions: [] },
        { object: await replace(root, path, await at(candidate.root, path)), contributions: [{ change: candidate.change, operation: null }] },
      ],
    });
  return { root, objects: [...written], decisions, evidence: { rule: "reference-three-way" } };
}

if (args[0] !== "serve") throw new Error("Usage: reference-sidecar.ts serve --objects DIR --staging DIR");
for await (const line of createInterface({ input: process.stdin })) {
  try { process.stdout.write(JSON.stringify(await answer(JSON.parse(line))) + "\n"); }
  catch (error) { process.stdout.write(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }) + "\n"); }
}
