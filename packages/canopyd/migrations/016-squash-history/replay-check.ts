import { Database } from "bun:sqlite";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CandidateUpdate, ObjectHash, SourceTraceFrame } from "@overstory/protocol";
import { CanopyDaemon } from "../../../../packages/canopyd/src/canopy.ts";
import { migrateSquashHistory } from "./run.ts";

/** Rehearsal check for the one merge-state model (canopyd 015, stage 1; the plan is in git history).
 *
 * Takes a restored pre-migration copy (schema 17, written by the deployed
 * build) and never writes to it. On a scratch copy it cuts each ordinary
 * tree back to the update before its last `--last` client updates, runs
 * migration 016 there, then submits those updates again through this build's
 * acceptance path, in their accepted order, and compares each accepted root
 * and conflict flag with the recorded one.
 *
 * What is replayed: updates with a subject that names a device or an
 * account, a change identity and a recorded candidate, on trees of ordinary
 * policy. Account-configuration trees (their derived device and policy rows
 * would not rewind) and host-made updates (tree creation, boundary rewrites)
 * are not; a tree's window starts after its newest host-made update, and at
 * an unconflicted update, since the migration refuses to squash onto an open
 * decision. An update whose recorded basis lies before the window, or that
 * resolved decisions, is reported as skipped.
 *
 * A mismatch is a real difference between the recorded acceptance and this
 * build's: a different root, a different conflict flag, or an error. The
 * replay starts from a squashed head, as live will after the migration, so
 * a difference can also come from the history the squash drops.
 *
 *   bun run packages/canopyd/migrations/016-squash-history/replay-check.ts <restored-copy> [--last 20] [--tree <id>] [--keep]
 */
export interface ReplayReport {
  ok: boolean;
  trees: Array<{
    id: string;
    path: string | null;
    /** The recorded update the scratch copy was cut back to. */
    from: string;
    replayed: number;
    /** Of those replayed, how many carried a trace (the rest were snapshots). */
    traced: number;
    matched: number;
    mismatches: Array<{ update: string; expected: { root: string; conflicted: boolean }; actual: { root: string; conflicted: boolean } | { error: string } }>;
    skipped: Array<{ update: string; reason: string }>;
  }>;
  scratch?: string;
}

interface Recorded {
  ordinal: number;
  id: string;
  tree: string;
  root: ObjectHash;
  conflicted: number;
  subject: string | null;
  base: ObjectHash | null;
  candidate: ObjectHash | null;
  change: string | null;
  record: string | null;
  trace: string | null;
}

export async function replayCheck(source: string, options: { last?: number; tree?: string; keep?: boolean } = {}): Promise<ReplayReport> {
  const last = options.last ?? 20;
  const scratch = await mkdtemp(join(tmpdir(), "arbor-016-replay-"));
  const report: ReplayReport = { ok: true, trees: [] };
  try {
    await cp(join(source, "canopy.sqlite3"), join(scratch, "canopy.sqlite3"));
    for (const suffix of ["-wal", "-shm"]) await cp(join(source, `canopy.sqlite3${suffix}`), join(scratch, `canopy.sqlite3${suffix}`)).catch(() => {});
    await cp(join(source, "objects"), join(scratch, "objects"), { recursive: true });

    // Plan each tree's window on the untouched scratch copy, then cut it back.
    const plans: Array<{ tree: string; path: string | null; cut: Recorded; window: Recorded[]; accounts: Map<string, string> }> = [];
    const db = new Database(join(scratch, "canopy.sqlite3"), { strict: true });
    try {
      const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
      if (stamp !== "17") throw new Error(`The replay check reads a pre-migration (schema 17) copy, found ${stamp}`);
      const trees = db.query(`SELECT t.id, b.path FROM trees t LEFT JOIN boundaries b ON b.tree_id = t.id
        WHERE t.policy = 'ordinary' AND t.status = 'active' ${options.tree ? "AND t.id = ?" : ""} ORDER BY t.id`)
        .all(...(options.tree ? [options.tree] : [])) as Array<{ id: string; path: string | null }>;
      const deviceAccount = (id: string) => (db.query("SELECT account_id FROM devices WHERE id = ?").get(id) as { account_id: string } | null)?.account_id;
      for (const { id, path } of trees) {
        const rows = db.query(`
          SELECT u.ordinal, u.id, u.tree_id AS tree, u.root, u.conflicted, u.subject, u.base_root AS base, u.candidate_root AS candidate,
            u.change_id AS change, m.record_json AS record, a.trace_json AS trace
          FROM accepted_updates u
          LEFT JOIN accepted_merge_states m ON m.accepted_id = u.id
          LEFT JOIN authored_changes a ON a.accepted_id = u.id
          WHERE u.tree_id = ? ORDER BY u.ordinal
        `).all(id) as Recorded[];
        const accounts = new Map<string, string>();
        const client = (row: Recorded) => {
          if (!row.subject || !row.change || !row.candidate) return false;
          if (row.subject.startsWith("device:")) {
            const account = deviceAccount(row.subject.slice("device:".length));
            if (account) accounts.set(row.subject, account);
            return !!account;
          }
          if (row.subject.startsWith("account:")) { accounts.set(row.subject, row.subject.slice("account:".length)); return true; }
          return false;
        };
        let start = rows.length;
        while (start > 1 && rows.length - start < last && client(rows[start - 1]!)) start--;
        while (start < rows.length && rows[start - 1]!.conflicted) start++;
        if (start >= rows.length) continue;
        plans.push({ tree: id, path, cut: rows[start - 1]!, window: rows.slice(start), accounts });
      }
      db.run("PRAGMA foreign_keys = OFF");
      db.transaction(() => {
        for (const plan of plans) {
          const ids = plan.window.map((row) => row.id);
          const marks = ids.map(() => "?").join(", ");
          for (const table of ["accepted_merge_states", "accepted_conflicts", "authored_changes"])
            db.run(`DELETE FROM ${table} WHERE accepted_id IN (${marks})`, ids);
          db.run(`DELETE FROM document_versions WHERE update_id IN (${marks})`, ids);
          db.run(`DELETE FROM accepted_updates WHERE id IN (${marks})`, ids);
          db.run("UPDATE trees SET ref = ? WHERE id = ?", [plan.cut.root, plan.tree]);
        }
      })();
    } finally { db.close(); }

    await migrateSquashHistory(scratch);
    const previous = process.env.ARBOR_CANOPY_NO_WARMUP;
    process.env.ARBOR_CANOPY_NO_WARMUP = "1";
    const canopy = await CanopyDaemon.open(scratch).finally(() => {
      if (previous === undefined) delete process.env.ARBOR_CANOPY_NO_WARMUP; else process.env.ARBOR_CANOPY_NO_WARMUP = previous;
    });
    try {
      for (const plan of plans) {
        const result: ReplayReport["trees"][number] = { id: plan.tree, path: plan.path, from: plan.cut.id, replayed: 0, traced: 0, matched: 0, mismatches: [], skipped: [] };
        report.trees.push(result);
        // Each recorded root, with the accepted update that holds it in the scratch copy.
        const replayedAt = new Map<ObjectHash, string>([[plan.cut.root, String(plan.cut.ordinal)]]);
        for (const row of plan.window) {
          const record = row.record ? JSON.parse(row.record) as { request?: { trace?: SourceTraceFrame[] | null; resolves?: unknown[] } } : null;
          const base = row.base ? replayedAt.get(row.base) : undefined;
          if (!base) { result.skipped.push({ update: row.id, reason: "its basis was not replayed" }); continue; }
          if (record?.request?.resolves?.length) { result.skipped.push({ update: row.id, reason: "resolves decisions" }); continue; }
          const trace = record?.request?.trace ?? (row.trace ? JSON.parse(row.trace) as SourceTraceFrame[] : null);
          const update: CandidateUpdate = { change: row.change!, candidate: row.candidate!, trace, resolves: [], objects: [], deltas: [] };
          const account = canopy.account(plan.accounts.get(row.subject!)!);
          result.replayed++;
          if (trace) result.traced++;
          const expected = { root: row.root, conflicted: Boolean(row.conflicted) };
          try {
            const response = await canopy.submitUpdate(plan.tree, { base, updates: [update] }, account,
              undefined, row.subject!.startsWith("device:") ? row.subject! : undefined);
            if ("error" in response.result) throw new Error(`${response.result.error}: ${response.result.message}`);
            const accepted = response.result.results[0]!;
            const actual = { root: accepted.update.root, conflicted: accepted.update.conflicted };
            if (accepted.outcome !== "accepted") throw new Error(`outcome ${accepted.outcome}`);
            replayedAt.set(row.root, accepted.update.id);
            if (actual.root === expected.root && actual.conflicted === expected.conflicted) result.matched++;
            else result.mismatches.push({ update: row.id, expected, actual });
          } catch (error) {
            result.mismatches.push({ update: row.id, expected, actual: { error: error instanceof Error ? error.message : String(error) } });
          }
        }
        if (result.mismatches.length) report.ok = false;
      }
    } finally {
      await canopy[Symbol.asyncDispose]();
    }
    if (options.keep) report.scratch = scratch;
    return report;
  } finally {
    if (!options.keep) await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const source = args[0];
  if (!source || source.startsWith("--")) {
    console.error("usage: replay-check.ts <restored-pre-migration-copy> [--last 20] [--tree <id>] [--keep]");
    process.exit(2);
  }
  const report = await replayCheck(resolve(source), {
    last: flag("--last") ? Number(flag("--last")) : undefined,
    tree: flag("--tree"),
    keep: args.includes("--keep"),
  });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
