/** A disposable overstoryd-shaped data root built from a Git repository's
 * first-parent history, for storage experiments that must not touch host
 * data. Each commit becomes one accepted update of one tree: its files and
 * directories as protocol objects (unchanged subtrees keep their hashes), a
 * log entry naming the previous one, an `accepted_updates` row, and a
 * `document_versions` row per changed file (the path stands in for the stable
 * key). Objects are staged without fsync; file times follow commit times.
 *
 * With `--traces`, a commit's Markdown modifications are first recorded as
 * one traced update (an `editSource` per run of changed lines), as an editor
 * would author them, and its other changes as a snapshot after it.
 *
 *   bun tests/performance/storage/git-history-fixture.ts <out-dir> [--repo .] [--rev HEAD] [--max-file-bytes 2000000] [--traces]
 */
import { Database } from "bun:sqlite";
import { mkdir, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ObjectStore } from "@ovst/object-store";
import { compareProtocolNames, encodeProtocolDirectory, executeExactSourceEdits, hashObject, type ProtocolDirectoryEntry, type SourceFrame, type SourceOperation } from "@ovst/protocol";
import { encodeLogEntry, LOG_ENTRY_FORMAT, type LogEntry } from "@ovst/merge-protocol";

const TREE = "tr_fixturegithistory";

interface Commit { sha: string; time: number; changes: Array<{ blob: string | null; path: string }> }

async function git(repo: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "inherit" });
  const text = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return text;
}

function parseLog(text: string): Commit[] {
  const commits: Commit[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("C\t")) {
      const [, sha, time] = line.split("\t");
      commits.push({ sha: sha!, time: Number(time) * 1000, changes: [] });
    } else if (line.startsWith(":")) {
      const [meta, path] = line.split("\t");
      const [, mode, , blob, status] = meta!.split(" ");
      if (!path || path.startsWith("\"")) continue; // Quoted (unusual) names are skipped.
      if (mode === "160000") continue; // Submodules.
      commits.at(-1)!.changes.push({ blob: status === "D" ? null : blob!, path });
    }
  }
  return commits;
}

/** Reads blobs through one `git cat-file --batch`. */
class Blobs {
  private child;
  private reader;
  private buffer = new Uint8Array(0);
  constructor(repo: string) {
    this.child = Bun.spawn(["git", "cat-file", "--batch"], { cwd: repo, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    this.reader = this.child.stdout.getReader();
  }
  private async fill(n: number) {
    while (this.buffer.length < n) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error("git cat-file ended");
      const next = new Uint8Array(this.buffer.length + value.length);
      next.set(this.buffer); next.set(value, this.buffer.length);
      this.buffer = next;
    }
  }
  private take(n: number) { const out = this.buffer.slice(0, n); this.buffer = this.buffer.slice(n); return out; }
  async read(sha: string): Promise<Uint8Array> {
    this.child.stdin.write(`${sha}\n`);
    await this.child.stdin.flush();
    let newline = -1;
    while ((newline = this.buffer.indexOf(10)) < 0) await this.fill(this.buffer.length + 1);
    const header = new TextDecoder().decode(this.take(newline + 1)).trim();
    const size = Number(header.split(" ")[2]);
    if (!Number.isFinite(size)) throw new Error(`Unexpected cat-file header: ${header}`);
    await this.fill(size + 1);
    const bytes = this.take(size);
    this.take(1);
    return bytes;
  }
  close() { this.child.stdin.end(); }
}

/** A mutable folder whose object hash is recomputed only when it changed. */
interface Folder { files: Map<string, string>; folders: Map<string, Folder>; hash?: string }
const folder = (): Folder => ({ files: new Map(), folders: new Map() });
const VALID_NAME = (name: string) => name.length > 0 && name === name.normalize("NFC") && !/[\\\0]/.test(name);

const utf8 = (bytes: Uint8Array) => { try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; } };

/** Byte-range edits turning `before` into `after`, one per run of changed
 * lines: common leading and trailing lines, then a longest common
 * subsequence of the rest (bounded; a larger middle is one edit). */
export function lineEdits(before: Uint8Array, after: Uint8Array): Array<{ offset: number; length: number; replacement: Uint8Array }> {
  const lines = (bytes: Uint8Array) => {
    const out: Array<[number, number]> = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) { out.push([start, i + 1]); start = i + 1; }
    if (start < bytes.length) out.push([start, bytes.length]);
    return out;
  };
  const a = lines(before), b = lines(after);
  const key = (bytes: Uint8Array, [s, e]: [number, number]) => Buffer.from(bytes.subarray(s, e)).toString("latin1");
  const ak = a.map((l) => key(before, l)), bk = b.map((l) => key(after, l));
  let head = 0;
  while (head < ak.length && head < bk.length && ak[head] === bk[head]) head++;
  let tail = 0;
  while (tail < ak.length - head && tail < bk.length - head && ak[ak.length - 1 - tail] === bk[bk.length - 1 - tail]) tail++;
  const am = ak.slice(head, ak.length - tail), bm = bk.slice(head, bk.length - tail);
  // Pairs of matching middle lines, by LCS when small enough.
  const pairs: Array<[number, number]> = [];
  if (am.length && bm.length && am.length * bm.length <= 4_000_000) {
    const n = am.length, m = bm.length, table = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      table[i * (m + 1) + j] = am[i] === bm[j] ? table[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(table[(i + 1) * (m + 1) + j]!, table[i * (m + 1) + j + 1]!);
    for (let i = 0, j = 0; i < n && j < m;) {
      if (am[i] === bm[j]) { pairs.push([head + i, head + j]); i++; j++; }
      else if (table[(i + 1) * (m + 1) + j]! >= table[i * (m + 1) + j + 1]!) i++;
      else j++;
    }
  }
  pairs.push([ak.length - tail, bk.length - tail]);
  const edits: Array<{ offset: number; length: number; replacement: Uint8Array }> = [];
  let ai = head, bi = head;
  const offsetOf = (list: Array<[number, number]>, i: number, bytes: Uint8Array) => (i < list.length ? list[i]![0] : bytes.length);
  for (const [pa, pb] of pairs) {
    if (pa > ai || pb > bi) {
      const offset = offsetOf(a, ai, before), end = offsetOf(a, pa, before);
      edits.push({ offset, length: end - offset, replacement: after.subarray(offsetOf(b, bi, after), offsetOf(b, pb, after)) });
    }
    ai = pa + 1; bi = pb + 1;
  }
  return edits;
}

export async function buildGitHistoryFixture(out: string, options: { repo?: string; rev?: string; maxFileBytes?: number; traces?: boolean; progress?: (m: string) => void } = {}) {
  const repo = resolve(options.repo ?? "."), maxFileBytes = options.maxFileBytes ?? 2_000_000;
  const progress = options.progress ?? (() => {});
  const commits = parseLog(await git(repo, ["log", "--reverse", "--first-parent", "-m", "--raw", "--no-renames", "--no-abbrev", "--format=C%x09%H%x09%at", options.rev ?? "HEAD"]));
  await mkdir(join(out, "objects"), { recursive: true });
  const store = new ObjectStore(join(out, "objects"));
  const db = new Database(join(out, "overstoryd.sqlite3"), { create: true });
  db.run("PRAGMA journal_mode=WAL");
  db.run("CREATE TABLE IF NOT EXISTS accepted_updates (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, tree_id TEXT NOT NULL, root TEXT NOT NULL, accepted_at INTEGER NOT NULL, entry TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS document_versions (tree_id TEXT NOT NULL, stable_key TEXT NOT NULL, update_id TEXT NOT NULL, entry_path TEXT NOT NULL, content_hash TEXT NOT NULL, accepted_at INTEGER NOT NULL)");
  const blobs = new Blobs(repo);
  const top = folder();
  const times = new Map<string, number>();
  let previous: string | null = null, objects = 0, bytes = 0;
  const put = async (value: Uint8Array, time: number) => {
    const hash = hashObject(value);
    if (!times.has(hash)) {
      await store.stage([{ hash, bytes: value }]);
      objects++; bytes += value.byteLength;
    }
    times.set(hash, time);
    return hash;
  };
  const hashFolder = async (f: Folder, time: number): Promise<string> => {
    if (f.hash) return f.hash;
    const entries: ProtocolDirectoryEntry[] = [];
    for (const [name, child] of f.folders) entries.push({ name, directory: await hashFolder(child, time) });
    for (const [name, file] of f.files) entries.push({ name, file });
    entries.sort((a, b) => compareProtocolNames(a.name, b.name));
    return (f.hash = await put(encodeProtocolDirectory({ type: "directory", entries }), time));
  };
  const insertUpdate = db.prepare("INSERT INTO accepted_updates (tree_id, root, accepted_at, entry) VALUES (?, ?, ?, ?)");
  const insertVersion = db.prepare("INSERT INTO document_versions (tree_id, stable_key, update_id, entry_path, content_hash, accepted_at) VALUES (?, ?, ?, ?, ?, ?)");
  /** Apply one change to the folder tree; the version written, if any. */
  const apply = async (change: Commit["changes"][number], time: number, content?: Uint8Array): Promise<string | null> => {
    const parts = change.path.split("/");
    if (!parts.every(VALID_NAME)) return null;
    const name = parts.pop()!;
    let at = top;
    const chain = [at];
    for (const part of parts) {
      let next = at.folders.get(part);
      if (!next) { if (!change.blob) break; next = folder(); at.folders.set(part, next); }
      at = next; chain.push(at);
    }
    if (chain.length !== parts.length + 1) return null;
    if (at.files.has(name) === false && at.folders.has(name)) return null; // A file replacing a folder is skipped.
    let hash: string | null = null;
    if (!change.blob) at.files.delete(name);
    else {
      content ??= await blobs.read(change.blob);
      if (content.byteLength > maxFileBytes) return null;
      hash = await put(content, time);
      at.files.set(name, hash);
    }
    for (const f of chain) f.hash = undefined;
    // Empty folders disappear, as they do in Git.
    for (let depth = parts.length; depth > 0; depth--) {
      const child = chain[depth]!;
      if (child.files.size || child.folders.size) break;
      chain[depth - 1]!.folders.delete(parts[depth - 1]!);
    }
    return hash;
  };
  const fileAt = (path: string): string | undefined => {
    const parts = path.split("/"), name = parts.pop()!;
    let at: Folder | undefined = top;
    for (const part of parts) at = at?.folders.get(part);
    return at?.files.get(name);
  };
  const record = async (root: string, time: number, change: string, trace: SourceFrame[] | null, versions: Array<[string, string]>, update: string) => {
    const entry: string = await put(encodeLogEntry({
      format: LOG_ENTRY_FORMAT, tree: TREE, previous, root, change, trace: trace as LogEntry["trace"], resolves: [], decisions: [],
    }), time);
    previous = entry;
    db.transaction(() => {
      insertUpdate.run(TREE, root, time, entry);
      for (const [path, hash] of versions) insertVersion.run(TREE, path, update, path, hash, time);
    })();
    entries++;
  };
  let entries = 0, traced = 0;
  for (const [index, commit] of commits.entries()) {
    const rest = commit.changes.slice();
    // Modified Markdown, when asked for, is one traced update of byte-range
    // edits against the previous root; everything else follows as a snapshot.
    if (options.traces && previous) {
      const before = await hashFolder(top, commit.time);
      const operations: SourceOperation[] = [], versions: Array<[string, string]> = [];
      for (const change of commit.changes) {
        const old = change.path.endsWith(".md") && change.blob ? fileAt(change.path) : undefined;
        if (!old) continue;
        const content = await blobs.read(change.blob!);
        const oldBytes = await store.load(old);
        if (content.byteLength > maxFileBytes || !utf8(content) || !utf8(oldBytes)) continue;
        for (const edit of lineEdits(oldBytes, content))
          operations.push({ key: `edit-${operations.length}`, kind: "editSource",
            source: { material: { kind: "basis", path: `/${change.path}`, object: old }, range: [edit.offset, edit.offset + edit.length] },
            text: new TextDecoder().decode(edit.replacement) });
        const hash = await apply(change, commit.time, content);
        if (hash) versions.push([change.path, hash]);
        rest.splice(rest.indexOf(change), 1);
      }
      if (operations.length) {
        const after = await hashFolder(top, commit.time);
        const executed = await executeExactSourceEdits(before, operations, (hash) => store.load(hash));
        if (executed.root !== after) throw new Error(`Traced edits of ${commit.sha} do not reproduce its Markdown`);
        await record(after, commit.time, `t${commit.sha.slice(0, 20)}`, [{ before, after, operations }], versions, commit.sha);
        traced++;
      }
    }
    const versions: Array<[string, string]> = [];
    for (const change of rest) {
      const hash = await apply(change, commit.time);
      if (hash) versions.push([change.path, hash]);
    }
    const root = await hashFolder(top, commit.time);
    if (rest.length || !options.traces || !previous) await record(root, commit.time, `c${commit.sha.slice(0, 20)}`, null, versions, commit.sha);
    if (index % 100 === 0) progress(`${index}/${commits.length} commits, ${entries} entries (${traced} traced), ${objects} objects, ${(bytes / 1e6).toFixed(1)} MB`);
  }
  blobs.close();
  db.close();
  // Object times follow the commit that last wrote or reused them.
  for (const [hash, time] of times) await utimes(store.path(hash), time / 1000, time / 1000);
  return { commits: commits.length, entries, traced, objects, bytes };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const repo = flag("--repo"), rev = flag("--rev"), max = flag("--max-file-bytes");
  const traces = args.includes("--traces");
  if (traces) args.splice(args.indexOf("--traces"), 1);
  const out = args[0];
  if (!out) { console.error("usage: git-history-fixture.ts <out-dir> [--repo .] [--rev HEAD] [--max-file-bytes N] [--traces]"); process.exit(2); }
  const result = await buildGitHistoryFixture(resolve(out), {
    ...(repo ? { repo } : {}), ...(rev ? { rev } : {}), ...(max ? { maxFileBytes: Number(max) } : {}), traces,
    progress: (m) => console.error(m),
  });
  console.log(JSON.stringify(result));
}
