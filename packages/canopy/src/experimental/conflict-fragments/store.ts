import { Database } from "bun:sqlite";
import { stableJSONString } from "@arbor/core";
import { encodeWireDirectory, hashObject, type WireDirectoryEntry } from "@arbor/wire";

type ContributionRef = { change: string; operation: string | null };
export interface Alternative { id: string; revision: string; node: string; contributions: ContributionRef[] }
export type Fragment =
  | { kind: "slice"; object: string; range: [number, number] }
  | { kind: "sequence"; children: string[] }
  | { kind: "directory"; entries: Array<{ name: string; node: string }> }
  | { kind: "absent" }
  | { kind: "choice"; id: string; selected: string; alternatives: Alternative[] };
export type Choice = Extract<Fragment, { kind: "choice" }>;
export interface Guard { conflict: string; alternatives: string[] }
export interface State { id: string; tree: string; previous: string | null; graph: string; root: string; conflicted: boolean }
interface Projection { kind: "file" | "directory" | "absent"; hash?: string; bytes?: Uint8Array }
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** Isolated storage/lifecycle proof. Never open a production Canopy database.
 * Inputs are constructed internally; this is not a Wire decoder or merge rule.
 * There is no pruning, packing, concurrent reconciliation or public endpoint.
 */
export class FragmentStore {
  private db: Database;
  constructor(filename: string) {
    this.db = new Database(filename);
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    if (tables.some(t => !["fragment_objects", "fragment_nodes", "fragment_states", "fragment_heads", "fragment_receipts"].includes(t.name))) {
      this.db.close(); throw new Error("Fragment experiment requires a separate database");
    }
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA synchronous=FULL");
    this.db.run("CREATE TABLE IF NOT EXISTS fragment_objects (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS fragment_nodes (hash TEXT PRIMARY KEY, json TEXT NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS fragment_states (id TEXT PRIMARY KEY, tree TEXT NOT NULL, json TEXT NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS fragment_heads (tree TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT)");
    this.db.run("CREATE TABLE IF NOT EXISTS fragment_receipts (tree TEXT, request TEXT, digest TEXT, state TEXT, PRIMARY KEY(tree,request))");
  }
  close() { this.db.close(); }
  create(tree: string, owner: string) { this.db.run("INSERT INTO fragment_heads VALUES (?,?,NULL)", [tree, owner]); }
  private authorize(tree: string, owner: string): string | null {
    const row = this.db.query("SELECT owner,state FROM fragment_heads WHERE tree=?").get(tree) as { owner: string; state: string | null } | null;
    if (!row || row.owner !== owner) throw new Error("Tree access denied");
    return row.state;
  }
  object(bytes: Uint8Array): string {
    const hash = hashObject(bytes);
    this.db.run("INSERT OR IGNORE INTO fragment_objects VALUES (?,?)", [hash, bytes]); return hash;
  }
  private bytes(hash: string): Uint8Array {
    const row = this.db.query("SELECT bytes FROM fragment_objects WHERE hash=?").get(hash) as { bytes: Uint8Array } | null;
    if (!row || hashObject(row.bytes) !== hash) throw new Error("Missing or corrupt fragment object");
    return row.bytes;
  }
  put(node: Fragment): string {
    const json = stableJSONString(node), hash = hashObject(encoder.encode(json));
    this.db.run("INSERT OR IGNORE INTO fragment_nodes VALUES (?,?)", [hash, json]); return hash;
  }
  node(hash: string): Fragment {
    const row = this.db.query("SELECT json FROM fragment_nodes WHERE hash=?").get(hash) as { json: string } | null;
    if (!row || hashObject(encoder.encode(row.json)) !== hash) throw new Error("Missing or corrupt fragment node");
    return JSON.parse(row.json);
  }
  text(text: string): string {
    const bytes = encoder.encode(text);
    if (decoder.decode(bytes) !== text) throw new Error("Invalid scalar text");
    return this.put({ kind: "slice", object: this.object(bytes), range: [0, bytes.length] });
  }
  state(tree: string, owner: string, id?: string): State {
    const head = this.authorize(tree, owner);
    const row = this.db.query("SELECT json FROM fragment_states WHERE id=? AND tree=?").get(id ?? head, tree) as { json: string } | null;
    if (!row) throw new Error("State not retained in tree"); return JSON.parse(row.json);
  }
  private children(node: Fragment): string[] {
    return node.kind === "sequence" ? node.children : node.kind === "directory" ? node.entries.map(e => e.node)
      : node.kind === "choice" ? node.alternatives.map(a => a.node) : [];
  }
  /** Every occurrence is visited, including hidden branches. Repeated bytes may
   * share objects, but a decision ID cannot name two different occurrences. */
  choices(graph: string): Array<{ choice: Choice; ancestors: Array<{ conflict: string; alternative: string }> }> {
    const found: ReturnType<FragmentStore["choices"]> = [], ids = new Set<string>();
    let count = 0;
    const visit = (hash: string, ancestors: Array<{ conflict: string; alternative: string }>, depth: number) => {
      if (++count > 20000 || depth > 128) throw new Error("Fragment graph bound exceeded");
      const node = this.node(hash);
      if (node.kind === "choice") {
        if (ids.has(node.id) || node.alternatives.length < 2 ||
          new Set(node.alternatives.map(a => a.id)).size !== node.alternatives.length || !node.alternatives.some(a => a.id === node.selected)) throw new Error("Invalid choice identity");
        ids.add(node.id); found.push({ choice: node, ancestors });
        for (const a of node.alternatives) visit(a.node, [...ancestors, { conflict: node.id, alternative: a.id }], depth + 1);
      } else for (const child of this.children(node)) visit(child, ancestors, depth + 1);
    };
    visit(graph, [], 0); return found;
  }
  private project(graph: string, memo = new Map<string, Projection>(), depth = 0): Projection {
    if (depth > 128) throw new Error("Fragment graph bound exceeded");
    const prior = memo.get(graph); if (prior) return prior;
    const n = this.node(graph), child = (hash: string) => this.project(hash, memo, depth + 1);
    let result: Projection;
    if (n.kind === "slice") {
      const bytes = this.bytes(n.object), [start, end] = n.range;
      decoder.decode(bytes);
      if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end > bytes.length ||
        [start, end].some(i => i < bytes.length && (bytes[i]! & 0xc0) === 0x80)) throw new Error("Invalid source slice");
      const output = bytes.subarray(start, end); result = { kind: "file", hash: this.object(output), bytes: output };
    } else if (n.kind === "sequence") {
      const parts = n.children.map(child);
      if (parts.some(p => p.kind !== "file")) throw new Error("Non-text sequence child");
      const output = new Uint8Array(Buffer.concat(parts.map(p => p.bytes!)));
      result = { kind: "file", hash: this.object(output), bytes: output };
    } else if (n.kind === "directory") {
      const names = new Set<string>();
      const entries = n.entries.flatMap<WireDirectoryEntry>(e => {
        if (!e.name || /[/\\\0]/.test(e.name) || e.name === "." || e.name === ".." || e.name.normalize("NFC") !== e.name || names.has(e.name)) throw new Error("Invalid directory occurrence");
        names.add(e.name); const p = child(e.node);
        return p.kind === "absent" ? [] : p.kind === "file" ? [{ name: e.name, file: p.hash! }] : [{ name: e.name, directory: p.hash! }];
      }).sort((a,b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
      const bytes = encodeWireDirectory({ type: "directory", entries }); result = { kind: "directory", hash: this.object(bytes), bytes };
    } else if (n.kind === "choice") {
      // Validate hidden content and compatible kinds, not merely the projection.
      const values = n.alternatives.map(a => child(a.node));
      const kinds = new Set(values.filter(v => v.kind !== "absent").map(v => v.kind));
      if (kinds.size > 1) throw new Error("Mixed choice kinds");
      const selected = n.alternatives.findIndex(a => a.id === n.selected);
      if (selected < 0) throw new Error("Missing selection"); result = values[selected]!;
    } else result = { kind: "absent" };
    memo.set(graph, result); return result;
  }
  inspect(tree: string, owner: string, id?: string) {
    const state = this.state(tree, owner, id);
    return { state, choices: this.choices(state.graph) };
  }
  alternative(tree: string, owner: string, state: string, conflict: string, alternative: string): Uint8Array {
    const choice = this.inspect(tree, owner, state).choices.find(c => c.choice.id === conflict)?.choice;
    const selected = choice?.alternatives.find(a => a.id === alternative);
    if (!selected) throw new Error("Alternative not retained in state");
    const value = this.project(selected.node);
    if (value.kind !== "file") throw new Error("Alternative is not text"); return value.bytes!;
  }
  file(tree: string, owner: string, path: string[], id?: string): Uint8Array {
    let graph = this.state(tree, owner, id).graph;
    for (const name of path) {
      let node = this.node(graph);
      while (node.kind === "choice") { const selected = node.selected; graph = node.alternatives.find(a => a.id === selected)!.node; node = this.node(graph); }
      if (node.kind !== "directory") throw new Error("Not a directory");
      const entry = node.entries.find(e => e.name === name); if (!entry) throw new Error("Absent path"); graph = entry.node;
    }
    const value = this.project(graph); if (value.kind !== "file") throw new Error("Not a file"); return value.bytes!;
  }
  /** Ancestor alternative revisions change when a nested choice changes. */
  rewrite(graph: string, conflict: string, update: (choice: Choice) => string): string {
    const n = this.node(graph);
    if (n.kind === "choice" && n.id === conflict) return update(n);
    if (n.kind === "slice" || n.kind === "absent") return graph;
    const replace = (hash: string) => this.rewrite(hash, conflict, update);
    const next: Fragment = n.kind === "sequence" ? { ...n, children: n.children.map(replace) }
      : n.kind === "directory" ? { ...n, entries: n.entries.map(e => ({ ...e, node: replace(e.node) })) }
      : { ...n, alternatives: n.alternatives.map(a => { const node = replace(a.node); return node === a.node ? a : { ...a, node, revision: crypto.randomUUID() }; }) };
    return this.put(next);
  }
  editAlternative(graph: string, conflict: string, alternative: string, revision: string, node: string, contribution: ContributionRef): string {
    let found = false;
    const next = this.rewrite(graph, conflict, choice => {
      const prior = choice.alternatives.find(a => a.id === alternative);
      if (!prior || prior.revision !== revision) throw new Error("Stale alternative revision"); found = true;
      return this.put({ ...choice, alternatives: choice.alternatives.map(a => a.id !== alternative ? a :
        { ...a, node, revision: crypto.randomUUID(), contributions: [...a.contributions, contribution] }) });
    });
    if (!found) throw new Error("Unknown decision"); return next;
  }
  resolve(graph: string, conflict: string, alternative: string): string {
    let found = false;
    const next = this.rewrite(graph, conflict, choice => {
      const selected = choice.alternatives.find(a => a.id === alternative); if (!selected) throw new Error("Unknown alternative");
      found = true; return selected.node;
    });
    if (!found) throw new Error("Unknown decision"); return next;
  }
  commit(tree: string, owner: string, previous: string | null, request: string, graph: string, guards: Guard[] = []): State {
    return this.db.transaction(() => {
      const head = this.authorize(tree, owner);
      const digest = hashObject(encoder.encode(stableJSONString({ previous, graph, guards })));
      const receipt = this.db.query("SELECT digest,state FROM fragment_receipts WHERE tree=? AND request=?").get(tree, request) as { digest: string; state: string } | null;
      if (receipt) {
        if (receipt.digest !== digest) throw new Error("Request identity reused"); return this.state(tree, owner, receipt.state);
      }
      if (head !== previous) throw new Error("Stale accepted state");
      const before = head ? this.choices(this.state(tree, owner, head).graph) : [];
      const after = this.choices(graph);
      const guarded = new Set<string>();
      for (const guard of guards) {
        const choice = before.find(c => c.choice.id === guard.conflict)?.choice;
        if (guarded.has(guard.conflict) || !choice || stableJSONString([...guard.alternatives].sort()) !== stableJSONString(choice.alternatives.map(a => a.id).sort())) throw new Error("Incomplete resolution guard");
        guarded.add(guard.conflict);
        if (after.some(c => c.choice.id === guard.conflict)) throw new Error("Resolution still contains decision");
      }
      for (const { choice } of before) {
        const retained = after.find(c => c.choice.id === choice.id)?.choice;
        if (!retained && !guarded.has(choice.id)) throw new Error("Unresolved decision would be lost");
        if (retained) for (const a of choice.alternatives) {
          const b = retained.alternatives.find(b => b.id === a.id);
          if (!b || b.revision === a.revision && stableJSONString(b) !== stableJSONString(a)) throw new Error("Alternative evidence would be lost");
          if (stableJSONString(b.contributions.slice(0, a.contributions.length)) !== stableJSONString(a.contributions)) throw new Error("Alternative provenance would be lost");
        }
      }
      const projection = this.project(graph);
      if (projection.kind !== "directory") throw new Error("Accepted tree must be a directory");
      const state: State = { id: crypto.randomUUID(), tree, previous, graph, root: projection.hash!, conflicted: after.length > 0 };
      this.db.run("INSERT INTO fragment_states VALUES (?,?,?)", [state.id, tree, stableJSONString(state)]);
      this.db.run("UPDATE fragment_heads SET state=? WHERE tree=?", [state.id, tree]);
      this.db.run("INSERT INTO fragment_receipts VALUES (?,?,?,?)", [tree, request, digest, state.id]); return state;
    })();
  }
}
