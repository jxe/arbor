#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { ObjectStore } from "@ovst/object-store";
import { decodeProtocolDirectory, decodeProtocolTable, type ObjectHash } from "@ovst/protocol";

/**
 * Rename 002 step 1: count the old spellings that readers still accept, in
 * every tree's current root and in the host's own tables. Read-only; it may
 * run beside a live overstoryd. Reports counts, tree IDs and paths, never
 * content. Delete it with the aliases.
 *
 *   bun run packages/overstoryd/src/rename-002-count.ts /data
 */

const SPELLINGS: Record<string, RegExp> = {
  "arbor://": /arbor:\/\//g,
  ";arbor-key=": /;arbor-key=/g,
  ";arbor-rev=": /;arbor-rev=/g,
  ";arbor-config": /;arbor-config/g,
  "#arbor-key=": /#arbor-key=/g,
  "#arbor-access=": /#arbor-access=/g,
  "<!-- arbor:children -->": /<!--\s*arbor:children\s*-->/g,
};

type Counts = Record<string, number>;

function count(text: string, into: Counts): number {
  let found = 0;
  for (const [name, pattern] of Object.entries(SPELLINGS)) {
    const n = text.match(pattern)?.length ?? 0;
    if (n) { into[name] = (into[name] ?? 0) + n; found += n; }
  }
  return found;
}

export interface Rename002Report {
  trees: number;
  totals: Counts;
  /** Each tree, file or table holding an old spelling, with its counts. */
  places: Array<{ tree?: string; config?: boolean; path?: string; table?: string; column?: string; counts: Counts }>;
}

export async function countOldSpellings(dataRoot: string): Promise<Rename002Report> {
  const root = resolve(dataRoot);
  const db = new Database(join(root, "overstoryd.sqlite3"), { readonly: true });
  const store = new ObjectStore(join(root, "objects"));
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const report: Rename002Report = { trees: 0, totals: {}, places: [] };
  try {
    const heads = db.query(`
      SELECT u.tree_id AS tree, u.root AS root, t.governs AS governs
      FROM accepted_updates u JOIN trees t ON t.id = u.tree_id
      WHERE u.ordinal IN (SELECT max(ordinal) FROM accepted_updates GROUP BY tree_id)
    `).all() as Array<{ tree: string; root: ObjectHash; governs: string | null }>;
    for (const head of heads) {
      report.trees++;
      const config = head.governs !== null;
      const walk = async (hash: ObjectHash, path: string): Promise<void> => {
        const directory = decodeProtocolDirectory(await store.read(hash));
        for (const entry of directory.entries) {
          const child = path ? `${path}/${entry.name}` : entry.name;
          if (entry.name === ".arborignore") {
            report.totals[".arborignore"] = (report.totals[".arborignore"] ?? 0) + 1;
            report.places.push({ tree: head.tree, config, path: child, counts: { ".arborignore": 1 } });
          }
          if (entry.directory) await walk(entry.directory, child);
          else if (entry.file) {
            const counts: Counts = {};
            if (count(decoder.decode(await store.read(entry.file)), counts)) {
              for (const [name, n] of Object.entries(counts)) report.totals[name] = (report.totals[name] ?? 0) + n;
              report.places.push({ tree: head.tree, config, path: child, counts });
            }
          }
        }
        for (const { table } of directory.collection?.tables ?? []) {
          for (const { chunk } of decodeProtocolTable(await store.read(table)).chunks) {
            const counts: Counts = {};
            if (count(decoder.decode(await store.read(chunk)), counts)) {
              for (const [name, n] of Object.entries(counts)) report.totals[name] = (report.totals[name] ?? 0) + n;
              report.places.push({ tree: head.tree, config, path: `${path} (collection rows)`, counts });
            }
          }
        }
      };
      await walk(head.root, "");
    }

    // The host's own tables: member facts, profile locators, pins and the like.
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    for (const { name: table } of tables) {
      const columns = (db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string }>)
        .filter((column) => /TEXT|^$/i.test(column.type));
      for (const { name: column } of columns) {
        const counts: Counts = {};
        for (const row of db.query(`SELECT "${column}" AS value FROM "${table}" WHERE "${column}" LIKE '%arbor%'`).iterate() as Iterable<{ value: unknown }>) {
          if (typeof row.value === "string") count(row.value, counts);
        }
        if (Object.keys(counts).length) {
          for (const [name, n] of Object.entries(counts)) report.totals[name] = (report.totals[name] ?? 0) + n;
          report.places.push({ table, column, counts });
        }
      }
    }
  } finally {
    db.close();
  }
  return report;
}

if (import.meta.main) {
  const dataRoot = process.argv[2];
  if (!dataRoot) {
    console.error("usage: rename-002-count.ts <data root>");
    process.exit(2);
  }
  console.log(JSON.stringify(await countOldSpellings(dataRoot), null, 2));
}
