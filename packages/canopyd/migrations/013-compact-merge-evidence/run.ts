import { Database } from "bun:sqlite";
import { readdir, rm, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ObjectStore } from "@overstory/object-store";
import { decodeWireDirectory, hashObject, type ObjectHash, stableJSONString } from "@overstory/protocol";
import { assertCurrentCanopySchema } from "../../../../packages/canopyd/src/schema.ts";
import { retentionAudit } from "../../../../packages/canopyd-merge/src/retention.ts";
import {
  loadIntentState,
  storeIntentState,
  storeSharedIntentState,
} from "../../../../packages/canopyd-merge/src/state-storage.ts";
import { loadStateMap, updateStateMap } from "../../../../packages/canopyd-merge/src/state-map.ts";
import type { IntentState } from "../../../../packages/canopyd-merge/src/intent-model.ts";

/** Schema 14 → 15: merge evidence and old merge states become compact.
 *
 * Every `accepted_merge_states` row keeps its three evaluated tree roots
 * instead of the evaluator's whole read set, and the oldest rows' flattened
 * retention closure becomes the two-root `retention` form after the closure is
 * checked one last time. Merge states stored in the pre-chunked full-copy
 * format are rewritten into the indexed v3 format. That changes their content
 * hashes, so every reference moves with them: the row's `state` and
 * `authored`, decision `context` and alternative `state` values inside states,
 * and change envelopes whose `base.state` names a rewritten state. A rewritten
 * envelope changes hash too, so the states holding it are rewritten in turn,
 * oldest first, through a rewrite map. Tree roots, accepted updates, file and
 * directory objects, receipts and conflicts are untouched.
 *
 * Order: audit → write new objects → one SQLite transaction (rows + stamp) →
 * audit the new roots → delete superseded objects → VACUUM. A crash before the
 * transaction leaves unreferenced new objects and a schema-14 root; a rerun
 * completes it. A crash after it leaves superseded objects behind, and a rerun
 * reports the completed stamp. */
export interface MigrationReport {
  migrated: boolean;
  /** Every tree's current root; unchanged by this migration, listed for `verify.ts`. */
  trees: Array<{ id: string; root: string }>;
  rows: { total: number; legacy: number; compact: number };
  states: { rewritten: number; kept: number };
  changes: { rewritten: number; kept: number };
  objects: { written: number; deleted: number; bytesBefore: number; bytesAfter: number };
  sqlite: { bytesBefore: number; bytesAfter: number };
  audit: { before: AuditSummary; after: AuditSummary };
  jobs: string[];
  ms: Record<string, number>;
}
export interface AuditSummary {
  treeRoots: number;
  treeObjects: number;
  retained: number;
  legacyRows: number;
  compactRows: number;
}
type Log = (event: Record<string, unknown>) => void;
type Record_ = {
  state: string;
  authored: string;
  decisions: unknown[];
  dependencies?: string[];
  retention?: { version: 1; roots: string[] };
  evidence: { inputs: unknown; [k: string]: unknown } | null;
  request: unknown;
};
type Row = { rowid: number; accepted_id: string; record: Record_; base_root: string | null; previous_root: string | null; candidate_root: string | null };

const encoder = new TextEncoder();
const encode = (value: unknown) => encoder.encode(stableJSONString(value));
const HASH = /^sha256:[a-f0-9]{64}$/;

export async function migrateCompactMergeEvidence(root: string, log: Log = () => {}): Promise<MigrationReport> {
  const started = performance.now();
  const ms: Record<string, number> = {};
  const phase = (name: string, since: number) => { ms[name] = Math.round(performance.now() - since); };
  const databasePath = join(root, "canopy.sqlite3");
  const objects = new ObjectStore(join(root, "objects"));
  const db = new Database(databasePath, { readwrite: true, strict: true });
  try {
    const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    const trees = (db.query("SELECT id, ref AS root FROM trees ORDER BY id").all() as Array<{ id: string; root: string }>);
    if (stamp === "15") { assertCurrentCanopySchema(db); return { ...empty(false), trees }; }
    if (stamp !== "14") throw new Error(`Expected schema 14, found ${stamp}`);
    if ((db.query("PRAGMA quick_check").get() as { quick_check: string }).quick_check !== "ok")
      throw new Error("SQLite integrity check failed");
    const sqliteBefore = (await stat(databasePath)).size;
    const objectsBefore = await directoryBytes(join(root, "objects"));

    const rows = loadRows(db);
    for (const row of rows) {
      const inputs = row.record.evidence?.inputs;
      if (row.record.evidence && !Array.isArray(inputs)) throw new Error(`Row ${row.accepted_id} already carries compact evidence`);
      for (const [name, hash] of [["base_root", row.base_root], ["previous_root", row.previous_root], ["candidate_root", row.candidate_root]] as const) {
        if (!row.record.evidence) continue;
        if (!hash || !HASH.test(hash)) throw new Error(`Row ${row.accepted_id} has no ${name}`);
        if (!(inputs as string[]).includes(hash)) throw new Error(`Row ${row.accepted_id} evidence does not list its ${name}`);
      }
    }
    const legacy = rows.filter(r => r.record.dependencies).length;
    log({ event: "rows", total: rows.length, legacy, compact: rows.length - legacy });

    let since = performance.now();
    const before = await audit(db, objects, rows, "before", log);
    phase("audit-before", since);

    // Rewrite states oldest first. Reads are recorded so the superseded set can
    // be computed as "read here, no longer retained" after the new roots pass.
    since = performance.now();
    const read = new Set<string>();
    const written = new Map<string, Uint8Array>();
    const load = async (hash: string) => { read.add(hash); return objects.read(hash as ObjectHash); };
    const readOrPending = async (hash: string) => written.get(hash) ?? load(hash);
    const pending = new Map<string, Uint8Array>();
    const put = (bytes: Uint8Array) => {
      const hash = hashObject(bytes);
      if (!written.has(hash)) pending.set(hash, bytes);
      return hash;
    };
    const flush = async () => {
      if (!pending.size) return;
      await objects.store([...pending].map(([hash, bytes]) => ({ hash: hash as ObjectHash, bytes })));
      for (const [hash, bytes] of pending) written.set(hash, bytes);
      pending.clear();
    };
    const states = new Map<string, string>(), changes = new Map<string, string>();
    const active = new Set<string>();
    let statesRewritten = 0, changesRewritten = 0;

    const rewriteChange = async (hash: string): Promise<string> => {
      const known = changes.get(hash);
      if (known) return known;
      const record = JSON.parse(new TextDecoder().decode(await readOrPending(hash)));
      const base = record?.base?.state;
      if (typeof base !== "string") { changes.set(hash, hash); return hash; }
      const moved = await rewriteState(base);
      if (moved === base) { changes.set(hash, hash); return hash; }
      const next = put(encode({ ...record, base: { ...record.base, state: moved } }));
      changes.set(hash, next); changesRewritten++;
      return next;
    };
    const rewriteDecisions = async (decisions: IntentState["decisions"]) => {
      let changed = false;
      const out = [] as IntentState["decisions"];
      for (const decision of decisions) {
        const next = { ...decision, alternatives: [] as typeof decision.alternatives };
        if (decision.context) {
          next.context = await rewriteState(decision.context);
          changed ||= next.context !== decision.context;
        }
        for (const alternative of decision.alternatives) {
          const state = await rewriteState(alternative.state);
          changed ||= state !== alternative.state;
          next.alternatives.push({ ...alternative, state });
        }
        out.push(next);
      }
      return { decisions: out, changed };
    };
    const rewriteChanges = async (values: Record<string, string>) => {
      const updates: Record<string, string> = {};
      for (const [key, hash] of Object.entries(values)) {
        const next = await rewriteChange(hash);
        if (next !== hash) updates[key] = next;
      }
      return updates;
    };
    const rewriteState = async (hash: string): Promise<string> => {
      const known = states.get(hash);
      if (known) return known;
      if (active.has(hash)) throw new Error(`Merge state ${hash} references itself`);
      active.add(hash);
      const raw = JSON.parse(new TextDecoder().decode(await readOrPending(hash)));
      let next: string;
      if (raw?.format === "arbor-merge-intent-state-v3") {
        // Path-copy: only the active part and the touched change buckets move.
        if (typeof raw.active !== "string" || !raw.maps || typeof raw.maps.changes !== "string")
          throw new Error(`Invalid indexed state root ${hash}`);
        const activeState = await loadIntentState(raw.active, readOrPending);
        const { decisions, changed } = await rewriteDecisions(activeState.decisions);
        const updates = await rewriteChanges(await loadStateMap(raw.maps.changes, readOrPending) as Record<string, string>);
        if (!changed && !Object.keys(updates).length) next = hash;
        else {
          const maps = { ...raw.maps };
          if (Object.keys(updates).length) maps.changes = await updateStateMap(raw.maps.changes, updates, readOrPending, put);
          next = put(encode({
            ...raw,
            active: changed ? storeSharedIntentState({ ...activeState, decisions }, put) : raw.active,
            maps,
          }));
        }
      } else {
        // Full-copy formats are always rewritten. Load once to find references,
        // release, rewrite those first, then load again to build the new state.
        const probe = await loadIntentState(hash, readOrPending);
        const referenced = new Set<string>();
        for (const decision of probe.decisions) {
          if (decision.context) referenced.add(decision.context);
          for (const alternative of decision.alternatives) referenced.add(alternative.state);
        }
        const envelopes = Object.values(probe.changes);
        for (const state of referenced) await rewriteState(state);
        for (const envelope of envelopes) await rewriteChange(envelope);
        const value = await loadIntentState(hash, readOrPending);
        const { decisions } = await rewriteDecisions(value.decisions);
        const updates = await rewriteChanges(value.changes);
        next = storeIntentState({ ...value, decisions, changes: { ...value.changes, ...updates } }, put, false);
      }
      await flush();
      if (next !== hash) statesRewritten++;
      states.set(hash, next);
      active.delete(hash);
      log({ event: "state", from: hash.slice(7, 15), to: next.slice(7, 15), moved: next !== hash });
      return next;
    };
    for (const row of rows) {
      await rewriteState(row.record.authored);
      await rewriteState(row.record.state);
    }
    phase("rewrite", since);
    log({ event: "rewritten", states: statesRewritten, kept: states.size - statesRewritten, changes: changesRewritten, objects: written.size });

    // New rows, audited before anything is committed or removed.
    since = performance.now();
    const updated: Row[] = rows.map(row => {
      const state = states.get(row.record.state)!, authored = states.get(row.record.authored)!;
      const { dependencies: _dependencies, ...rest } = row.record;
      const evidence = row.record.evidence
        ? { ...row.record.evidence, inputs: { base: row.base_root!, current: row.previous_root!, incoming: row.candidate_root! } }
        : null;
      return { ...row, record: { ...rest, state, authored, retention: { version: 1, roots: [...new Set([state, authored])] }, evidence } };
    });
    const after = await audit(db, objects, updated, "after", log, hash => written.get(hash));
    phase("audit-after", since);

    since = performance.now();
    db.transaction(() => {
      const update = db.prepare("UPDATE accepted_merge_states SET record_json = ? WHERE accepted_id = ?");
      for (const row of updated) update.run(JSON.stringify(row.record), row.accepted_id);
      db.run("UPDATE meta SET value = '15' WHERE key = 'schema_version'");
      assertCurrentCanopySchema(db);
    })();
    phase("commit", since);

    since = performance.now();
    const superseded = [...read].filter(hash => !after.retainedSet.has(hash) && !after.treeSet.has(hash) && !written.has(hash));
    for (const hash of superseded) await unlink(objects.path(hash as ObjectHash));
    phase("delete", since);
    log({ event: "deleted", objects: superseded.length });

    const jobs: string[] = [];
    for (const name of ["merge-jobs", "merge-workers"]) {
      const path = join(root, name);
      if (await stat(path).then(() => true, () => false)) { await rm(path, { recursive: true, force: true }); jobs.push(name); }
    }

    since = performance.now();
    db.run("VACUUM");
    phase("vacuum", since);
    ms.total = Math.round(performance.now() - started);
    return {
      migrated: true,
      trees,
      rows: { total: rows.length, legacy, compact: rows.length - legacy },
      states: { rewritten: statesRewritten, kept: states.size - statesRewritten },
      changes: { rewritten: changesRewritten, kept: changes.size - changesRewritten },
      objects: { written: written.size, deleted: superseded.length, bytesBefore: objectsBefore, bytesAfter: await directoryBytes(join(root, "objects")) },
      sqlite: { bytesBefore: sqliteBefore, bytesAfter: (await stat(databasePath)).size },
      audit: { before: before.summary, after: after.summary },
      jobs,
      ms,
    };
  } finally { db.close(); }
}

function empty(migrated: boolean): MigrationReport {
  const summary = { treeRoots: 0, treeObjects: 0, retained: 0, legacyRows: 0, compactRows: 0 };
  return { migrated, trees: [], rows: { total: 0, legacy: 0, compact: 0 }, states: { rewritten: 0, kept: 0 }, changes: { rewritten: 0, kept: 0 },
    objects: { written: 0, deleted: 0, bytesBefore: 0, bytesAfter: 0 }, sqlite: { bytesBefore: 0, bytesAfter: 0 },
    audit: { before: summary, after: summary }, jobs: [], ms: {} };
}

function loadRows(db: Database): Row[] {
  return (db.query(`SELECT m.rowid, m.accepted_id, m.record_json, u.base_root, u.previous_root, u.candidate_root
    FROM accepted_merge_states m JOIN accepted_updates u ON u.id = m.accepted_id ORDER BY m.rowid`).all() as Array<{
    rowid: number; accepted_id: string; record_json: string; base_root: string | null; previous_root: string | null; candidate_root: string | null;
  }>).map(({ record_json, ...row }) => ({ ...row, record: JSON.parse(record_json) }));
}

/** The integrity audit `CanopyDaemon.verifyIntegrity` runs, without a daemon:
 * tree roots reachable, conflict material present, and every merge row's
 * retention closure verified from its roots. Legacy rows are checked against
 * their stored closure; compact rows are walked together as one union. */
async function audit(
  db: Database, objects: ObjectStore, rows: Row[], label: string, log: Log,
  proposed: (hash: string) => Uint8Array | undefined = () => undefined,
): Promise<{ summary: AuditSummary; retainedSet: Set<string>; treeSet: Set<string> }> {
  const load = async (hash: string) => proposed(hash) ?? objects.read(hash as ObjectHash);
  const roots = new Set<string>();
  for (const { root } of db.query("SELECT DISTINCT root FROM accepted_updates").all() as Array<{ root: string }>) roots.add(root);
  for (const { root } of db.query("SELECT basis_root AS root FROM authored_changes UNION SELECT candidate_root AS root FROM authored_changes").all() as Array<{ root: string }>) roots.add(root);
  const treeSet = new Set<string>();
  const walk = async (hash: string) => {
    if (treeSet.has(hash)) return;
    treeSet.add(hash);
    for (const entry of decodeWireDirectory(await load(hash)).entries) {
      if (entry.directory) await walk(entry.directory);
      else if (entry.file) { await load(entry.file); treeSet.add(entry.file); }
    }
  };
  for (const root of roots) await walk(root);
  for (const { state_json } of db.query("SELECT state_json FROM accepted_conflicts").all() as Array<{ state_json: string }>)
    for (const decision of JSON.parse(state_json).decisions) for (const { value } of decision.alternatives) {
      if ("file" in value) { await load(value.file); treeSet.add(value.file); }
      if ("directory" in value) await walk(value.directory);
    }
  log({ event: "audit", label, phase: "trees", roots: roots.size, objects: treeSet.size });
  const auditRetention = retentionAudit(load);
  const retainedSet = new Set<string>();
  const compact: string[] = [];
  let legacyRows = 0, compactRows = 0;
  for (const { accepted_id, record } of rows) {
    if (record.dependencies) {
      const closure = await auditRetention([record.state, record.authored]);
      if (stableJSONString([...closure].sort()) !== stableJSONString([...record.dependencies].sort()))
        throw new Error(`Invalid merge retention closure on ${accepted_id}`);
      for (const hash of closure) retainedSet.add(hash);
      legacyRows++;
    } else if (record.retention?.version !== 1 ||
      stableJSONString([...record.retention.roots].sort()) !== stableJSONString([...new Set([record.state, record.authored])].sort())) {
      throw new Error(`Invalid merge retention roots on ${accepted_id}`);
    } else { compact.push(record.state, record.authored); compactRows++; }
  }
  for (const hash of await auditRetention([...new Set(compact)], true)) retainedSet.add(hash);
  log({ event: "audit", label, phase: "retention", legacy: legacyRows, compact: compactRows, retained: retainedSet.size });
  return { summary: { treeRoots: roots.size, treeObjects: treeSet.size, retained: retainedSet.size, legacyRows, compactRows }, retainedSet, treeSet };
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
  return total;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length !== 1) throw new Error("Usage: bun packages/canopyd/migrations/013-compact-merge-evidence/run.ts <data-root>");
  const report = await migrateCompactMergeEvidence(resolve(args[0]!), event => console.error(JSON.stringify(event)));
  console.log(JSON.stringify(report));
}
