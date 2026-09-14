import { Database } from "bun:sqlite";
import { decodeWireDirectory, hashObject, type ObjectHash, type TreeSnapshot } from "@arbor/wire";
import { continueTerms, type Term } from "./algebra.ts";
import { preservesConflicts, project, resolveRegions, type Objects, type Region, type Resolution } from "./projection.ts";

interface State {
  tree: string;
  update: number;
  root: ObjectHash;
  terms: Term<ObjectHash>[];
}
export interface Review extends State { conflicts: Region[] }
interface Row { tree: string; update_id: number; root: ObjectHash; terms: string }

/**
 * Executable backend experiment. Uses ordinary Wire objects but has NO production
 * routes, schema migration, exports, or extension identifier. Its database must
 * be separate from Canopy. Authorization is deliberately one owner per TreeID.
 */
export class ConflictTermsBackend {
  private readonly db: Database;

  constructor(filename: string, private readonly maxTerms = 65) {
    if (!Number.isSafeInteger(maxTerms) || maxTerms < 3) throw new Error("Invalid term limit");
    this.db = new Database(filename);
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    if (tables.some(({ name }) => !["experiment_trees", "experiment_updates", "experiment_objects", "experiment_requests"].includes(name))) {
      this.db.close();
      throw new Error("Conflict experiment requires a separate database");
    }
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = FULL");
    this.db.run(`CREATE TABLE IF NOT EXISTS experiment_trees (tree TEXT PRIMARY KEY, owner TEXT NOT NULL, head INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS experiment_updates (
      tree TEXT NOT NULL REFERENCES experiment_trees(tree), update_id INTEGER NOT NULL,
      root TEXT NOT NULL, terms TEXT NOT NULL, PRIMARY KEY (tree, update_id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS experiment_objects (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS experiment_requests (
      tree TEXT NOT NULL REFERENCES experiment_trees(tree), request_id TEXT NOT NULL,
      digest TEXT NOT NULL, update_id INTEGER NOT NULL, PRIMARY KEY (tree, request_id))`);
  }

  close(): void { this.db.close(); }

  private authorize(tree: string, subject: string): number {
    const row = this.db.query("SELECT owner, head FROM experiment_trees WHERE tree = ?").get(tree) as { owner: string; head: number } | null;
    if (!row || row.owner !== subject) throw new Error("Tree access denied");
    return row.head;
  }

  private state(tree: string, update: number): State {
    const row = this.db.query("SELECT * FROM experiment_updates WHERE tree = ? AND update_id = ?").get(tree, update) as Row | null;
    if (!row) throw new Error("Accepted base is no longer retained");
    return { tree, update, root: row.root, terms: JSON.parse(row.terms) as Term<ObjectHash>[] };
  }

  private load(hash: ObjectHash): Uint8Array {
    const row = this.db.query("SELECT bytes FROM experiment_objects WHERE hash = ?").get(hash) as { bytes: Uint8Array } | null;
    if (!row || hashObject(row.bytes) !== hash) throw new Error("Missing or corrupt object");
    return row.bytes;
  }

  /** Validate graph kinds, hashes and resource bounds before admitting any root. */
  private graph(roots: ObjectHash[], load: (hash: ObjectHash) => Uint8Array): Set<ObjectHash> {
    const hashes = new Set<ObjectHash>();
    const directories = new Set<ObjectHash>();
    let size = 0;
    const visit = (hash: ObjectHash, directory: boolean, depth: number): void => {
      if (depth > 128) throw new Error("Directory depth limit exceeded");
      if (hashes.has(hash) && (!directory || directories.has(hash))) return;
      const bytes = load(hash);
      if (hashObject(bytes) !== hash) throw new Error("Object hash mismatch");
      if (!hashes.has(hash)) size += bytes.length;
      hashes.add(hash);
      if (hashes.size > 20_000 || size > 64 * 1024 * 1024) throw new Error("Experiment graph limit exceeded");
      if (!directory) return;
      directories.add(hash);
      for (const entry of decodeWireDirectory(bytes).entries) {
        if (entry.file) visit(entry.file, false, depth + 1);
        if (entry.directory) visit(entry.directory, true, depth + 1);
        // A nested TreeID is an opaque boundary, never an object root to traverse.
      }
    };
    for (const root of roots) visit(root, true, 0);
    return hashes;
  }

  private retained(tree?: string): Set<ObjectHash> {
    const rows = (tree === undefined
      ? this.db.query("SELECT * FROM experiment_updates").all()
      : this.db.query("SELECT * FROM experiment_updates WHERE tree = ?").all(tree)) as Row[];
    return this.graph(rows.flatMap((row) => [row.root, ...(JSON.parse(row.terms) as Term<ObjectHash>[]).map((term) => term.value)]), (hash) => this.load(hash));
  }

  private objects(): { objects: Objects; generated: Map<ObjectHash, Uint8Array> } {
    const generated = new Map<ObjectHash, Uint8Array>();
    return {
      generated,
      objects: {
        load: (hash) => generated.get(hash) ?? this.load(hash),
        put: (bytes) => {
          const hash = hashObject(bytes);
          generated.set(hash, bytes.slice());
          return hash;
        },
      },
    };
  }

  private candidate(snapshot: TreeSnapshot, allowed: Set<ObjectHash>, generated: Map<ObjectHash, Uint8Array>): void {
    const load = (hash: ObjectHash): Uint8Array => {
      const bytes = snapshot.objects.get(hash);
      if (bytes) return bytes;
      if (!allowed.has(hash)) throw new Error("Candidate references an unauthorized object");
      return this.load(hash);
    };
    const reachable = this.graph([snapshot.root], load);
    for (const hash of reachable) if (snapshot.objects.has(hash)) generated.set(hash, load(hash).slice());
  }

  private save(tree: string, expected: number, terms: Term<ObjectHash>[], objects: Objects, generated: Map<ObjectHash, Uint8Array>): Review {
    const projection = project(terms, objects);
    // A clean materialization is a checkpoint. Unresolved state never uses
    // projection equality as evidence that its alternatives were resolved.
    if (!projection.conflicts.length) terms = [{ sign: 1, value: projection.root }];
    if (terms.length > this.maxTerms) throw new Error("Unresolved term limit exceeded; resolve before continuing");
    const reachable = this.graph([projection.root, ...terms.map((term) => term.value)], objects.load);
    const update = expected + 1;
    const changed = this.db.run("UPDATE experiment_trees SET head = ? WHERE tree = ? AND head = ?", [update, tree, expected]);
    if (changed.changes !== 1) throw new Error("Accepted state changed");
    for (const hash of reachable) {
      const bytes = generated.get(hash);
      if (bytes) this.db.run("INSERT OR IGNORE INTO experiment_objects VALUES (?, ?)", [hash, bytes]);
    }
    this.db.run("INSERT INTO experiment_updates VALUES (?, ?, ?, ?)", [tree, update, projection.root, JSON.stringify(terms)]);
    return { tree, update, root: projection.root, terms, conflicts: projection.conflicts };
  }

  create(tree: string, subject: string, snapshot: TreeSnapshot): Review {
    if (!/^tr_[a-z0-9]+$/.test(tree) || !subject) throw new Error("TreeID and owner required");
    return this.db.transaction(() => {
      const { objects, generated } = this.objects();
      this.candidate(snapshot, new Set(), generated);
      this.db.run("INSERT INTO experiment_trees VALUES (?, ?, 0)", [tree, subject]);
      return this.save(tree, 0, [{ sign: 1, value: snapshot.root }], objects, generated);
    }).immediate();
  }

  private inspect(state: State): Review {
    const { objects } = this.objects();
    const projection = project(state.terms, objects);
    if (projection.root !== state.root) throw new Error("Stored projection does not match its terms");
    return { ...state, conflicts: projection.conflicts };
  }

  review(tree: string, subject: string): Review {
    return this.inspect(this.state(tree, this.authorize(tree, subject)));
  }

  private request(tree: string, requestID: string, intent: unknown, run: () => Review): Review {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(requestID)) throw new Error("A stable request identity is required");
    const digest = hashObject(new TextEncoder().encode(JSON.stringify(intent)));
    const prior = this.db.query("SELECT digest, update_id FROM experiment_requests WHERE tree = ? AND request_id = ?")
      .get(tree, requestID) as { digest: string; update_id: number } | null;
    if (prior) {
      if (prior.digest !== digest) throw new Error("Request identity reused with different intent");
      return this.inspect(this.state(tree, prior.update_id));
    }
    const count = this.db.query("SELECT COUNT(*) AS n FROM experiment_requests WHERE tree = ?").get(tree) as { n: number };
    if (count.n >= 10_000) throw new Error("Experiment request retention limit exceeded");
    const result = run();
    this.db.run("INSERT INTO experiment_requests VALUES (?, ?, ?, ?)", [tree, requestID, digest, result.update]);
    return result;
  }

  update(tree: string, subject: string, baseUpdate: number, snapshot: TreeSnapshot, requestID: string): Review {
    return this.db.transaction(() => {
      const current = this.state(tree, this.authorize(tree, subject));
      return this.request(tree, requestID, ["update", baseUpdate, snapshot.root], () => {
        const base = this.state(tree, baseUpdate);
        const { objects, generated } = this.objects();
        this.candidate(snapshot, this.retained(tree), generated);
        if (snapshot.root === base.root) return this.inspect(current);
        const terms = continueTerms(current.terms, base.root, snapshot.root, (hash) => hash);
        if (!preservesConflicts(project(current.terms, objects).conflicts, project(terms, objects).conflicts)) {
          throw new Error("Cannot preserve unresolved alternatives; explicit review required");
        }
        return this.save(tree, current.update, terms, objects, generated);
      });
    }).immediate();
  }

  resolve(tree: string, subject: string, expectedUpdate: number, choices: Resolution[], requestID: string): Review {
    return this.db.transaction(() => {
      const current = this.state(tree, this.authorize(tree, subject));
      const intent = ["resolve", expectedUpdate, choices.map((choice) => "bytes" in choice
        ? [choice.conflict, "bytes", Buffer.from(choice.bytes).toString("base64")] : [choice.conflict, "take", choice.take])];
      return this.request(tree, requestID, intent, () => {
        if (current.update !== expectedUpdate) throw new Error("Stale conflict review");
        const { objects, generated } = this.objects();
        const terms = resolveRegions(current.terms, project(current.terms, objects).conflicts, choices, objects);
        return this.save(tree, current.update, terms, objects, generated);
      });
    }).immediate();
  }

  readObject(tree: string, subject: string, hash: ObjectHash): Uint8Array {
    this.authorize(tree, subject);
    if (!this.retained(tree).has(hash)) throw new Error("Object is not retained by this tree");
    return this.load(hash).slice();
  }

  /** Explicit experiment retention policy. Live alternatives remain roots even
   * when their introducing accepted updates have expired. Never truncates terms. */
  prune(tree: string, subject: string, keep: number): { removedObjects: number } {
    if (!Number.isSafeInteger(keep) || keep < 1) throw new Error("Keep at least the accepted head");
    return this.db.transaction(() => {
      const head = this.authorize(tree, subject);
      this.db.run("DELETE FROM experiment_requests WHERE tree = ? AND update_id <= ?", [tree, head - keep]);
      this.db.run("DELETE FROM experiment_updates WHERE tree = ? AND update_id <= ?", [tree, head - keep]);
      const retained = this.retained();
      const hashes = this.db.query("SELECT hash FROM experiment_objects").all() as { hash: ObjectHash }[];
      let removedObjects = 0;
      for (const { hash } of hashes) if (!retained.has(hash)) {
        this.db.run("DELETE FROM experiment_objects WHERE hash = ?", [hash]);
        removedObjects++;
      }
      return { removedObjects };
    }).immediate();
  }
}
