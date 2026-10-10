/** Saved merge states for Performance 002 measurements (`packages/overstoryd-merge/scripts/benchmark-cache.ts`), made by the reference
 * sidecar over a disposable data root (such as `git-history-fixture.ts`
 * builds): never point it at host data. For each tree it replays the log to
 * two heads and saves both, as the sidecar does after 32 replayed entries.
 * With `--choices`, it first records concurrent snapshots that conflict, so
 * the saves carry open decisions whose alternatives name other states.
 *
 *   bun tests/performance/storage/merge-cache-fixture.ts <data-root> <saves-dir> [--choices 3]
 */
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { ObjectStore, holdsObject } from "@ovst/object-store";
import { decodeProtocolDirectory, encodeProtocolDirectory, hashObject, compareProtocolNames } from "@ovst/protocol";
import { decodeLogEntry, encodeLogEntry, LOG_ENTRY_FORMAT } from "@ovst/merge-protocol";
import { Sidecar } from "../../../packages/overstoryd-merge/src/sidecar.ts";
import { savedStatesIn } from "../../../packages/overstoryd-merge/src/saved-states.ts";

const RULES = { id: "tree-default", revision: 1 };

export async function buildMergeCacheFixture(dataRoot: string, saves: string, options: { choices?: number; progress?: (m: string) => void } = {}) {
  const progress = options.progress ?? (() => {});
  const store = new ObjectStore(join(dataRoot, "objects"), { cacheBytes: 256 * 1024 * 1024 });
  const db = new Database(join(dataRoot, "overstoryd.sqlite3"), { readonly: true });
  const rows = db.query("SELECT tree_id AS tree, entry FROM accepted_updates ORDER BY ordinal").all() as Array<{ tree: string; entry: string }>;
  db.close();
  const heads = new Map<string, string[]>();
  for (const row of rows) (heads.get(row.tree) ?? heads.set(row.tree, []).get(row.tree)!).push(row.entry);
  const generated = new Map<string, Uint8Array>();
  const sidecar = new Sidecar({
    shared: { find: async (hash) => generated.get(hash) ?? store.find(hash), has: async (hash) => generated.has(hash) || holdsObject(store, hash) },
    // overstoryd adopts an accepted answer's objects; the fixture keeps them in memory.
    staging: { find: async (hash) => generated.get(hash) ?? null, stage: async (values) => { for (const v of values) generated.set(v.hash, v.bytes); } },
    saved: savedStatesIn(saves),
  }, Number.MAX_SAFE_INTEGER, undefined, Number.POSITIVE_INFINITY);
  const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); generated.set(hash, bytes); return hash; };
  const read = async (hash: string) => generated.get(hash) ?? store.load(hash);
  const entryOf = async (hash: string) => decodeLogEntry(await read(hash));
  const saved: string[] = [];
  for (const [tree, chain] of heads) {
    const stops = [Math.max(1, Math.floor(chain.length * 0.9)) - 1, chain.length - 1];
    for (const stop of stops) {
      let head = chain[stop]!;
      const started = performance.now();
      // A no-op snapshot of the head's own root replays the chain to it.
      const entry = await entryOf(head);
      await sidecar.answer({ base: head, head, candidate: { root: entry.root, change: "replay", trace: null, resolves: [] }, rules: RULES });
      // Concurrent snapshots that conflict in the largest text file leave
      // choices open, as an editor offline for a while would.
      for (let i = 0; i < (options.choices ?? 0) && stop === stops.at(-1); i++) {
        const baseHash = chain[Math.max(0, stop - 5 - i)]!, base = await entryOf(baseHash);
        const candidate = await editLargest(base.root, read, put, `concurrent ${i}`);
        if (!candidate) break;
        const question = { base: baseHash, head, candidate: { root: candidate, change: `concurrent-${i}`, trace: null, resolves: [] }, rules: RULES };
        const answer = await sidecar.answer(question);
        head = put(encodeLogEntry({ format: LOG_ENTRY_FORMAT, tree, previous: head, root: answer.root, change: `concurrent-${i}`,
          trace: null, resolves: [], decisions: answer.decisions, asked: { base: baseHash, rules: RULES } }));
        await sidecar.answer({ base: head, head, candidate: { root: answer.root, change: "replay", trace: null, resolves: [] }, rules: RULES });
      }
      await sidecar.save();
      saved.push(head);
      progress(`${tree}: saved entry ${stop + 1}/${chain.length} after ${sidecar.replayed} replayed in ${Math.round(performance.now() - started)} ms`);
    }
  }
  return { saved, generated };
}

/** `root` with its largest Markdown file prefixed by `line`; null when none. */
async function editLargest(root: string, read: (h: string) => Promise<Uint8Array>, put: (b: Uint8Array) => string, line: string): Promise<string | null> {
  const edit = async (hash: string): Promise<{ hash: string; size: number } | null> => {
    const directory = decodeProtocolDirectory(await read(hash));
    let best: { index: number; size: number; replacement: string } | null = null;
    for (const [index, entry] of directory.entries.entries()) {
      if (entry.file && entry.name.endsWith(".md")) {
        const size = (await read(entry.file)).byteLength;
        if (!best || size > best.size) best = { index, size, replacement: entry.file };
      } else if (entry.directory) {
        const inner = await edit(entry.directory);
        if (inner && (!best || inner.size > best.size)) best = { index, size: inner.size, replacement: inner.hash };
      }
    }
    if (!best) return null;
    const entries = directory.entries.slice();
    const target = entries[best.index]!;
    if (target.file) {
      const text = new TextDecoder().decode(await read(target.file));
      entries[best.index] = { name: target.name, file: put(new TextEncoder().encode(`${line}\n\n${text}`)) };
    } else entries[best.index] = { name: target.name, directory: best.replacement };
    entries.sort((a, b) => compareProtocolNames(a.name, b.name));
    return { hash: put(encodeProtocolDirectory({ ...directory, entries })), size: best.size };
  };
  return (await edit(root))?.hash ?? null;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--choices");
  const choices = i >= 0 ? Number(args.splice(i, 2)[1]) : 0;
  const [dataRoot, saves] = args;
  if (!dataRoot || !saves) { console.error("usage: merge-cache-fixture.ts <data-root> <saves-dir> [--choices N]"); process.exit(2); }
  const result = await buildMergeCacheFixture(resolve(dataRoot), resolve(saves), { choices, progress: (m) => console.error(m) });
  console.log(JSON.stringify({ saved: result.saved }));
}
