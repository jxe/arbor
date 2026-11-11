#!/usr/bin/env bun
// What the Protocol 003 flag day must decide or convert, read from a data root
// without writing to it. Run it on a copy of /data before the migration is
// written to its final shape:
//   bun run packages/overstoryd/migrations/next/inventory.ts <data-root> [--json]
//
// It lists:
// - TreeIDs and DeviceIDs shorter than the 26-character form the spec now
//   requires (devices with one are re-paired; a tree with one is Joe's call),
//   with every place a short TreeID is named (accounts, boundaries, tree entries);
// - trees whose head still holds Markdown as file entries (the migration
//   converts them to pages);
// - `.mdx` entries (no longer pages, Apps 011);
// - per tree, the head's size and retained history, which the migration drops.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ObjectStore } from "@ovst/object-store";
import { decodeProtocolDirectory, type ObjectHash } from "@ovst/protocol";

/** A TreeID or DeviceID in the form the spec requires: a prefix and at least 26 base32 characters (derived TreeIDs are longer). */
const LONG_ID = /^[a-z]+_[a-z2-7]{26,}$/;

export interface TreeInventory {
  id: string;
  short: boolean;
  root: ObjectHash;
  updates: number;
  firstAcceptedAt: number | null;
  directories: number;
  files: number;
  pages: number;
  markdownFiles: string[];
  mdx: string[];
  treeEntries: Array<{ path: string; tree: string }>;
  missingObjects: number;
}

export interface Inventory {
  dataRoot: string;
  trees: TreeInventory[];
  shortTrees: Array<{ id: string; namedBy: string[] }>;
  shortDevices: Array<{ id: string; account: string; label: string; revoked: boolean; lastUsedAt: number | null }>;
  entryTimesIndex: boolean;
}

export async function inventory(dataRoot: string): Promise<Inventory> {
  const root = resolve(dataRoot);
  const db = new Database(join(root, "overstoryd.sqlite3"), { readonly: true });
  const store = new ObjectStore(join(root, "objects"));
  const trees: TreeInventory[] = [];
  const counts = new Map<string, { updates: number; first: number | null }>();
  for (const row of db.query("SELECT tree_id, COUNT(*) AS n, MIN(accepted_at) AS first FROM accepted_updates GROUP BY tree_id").all() as Array<{ tree_id: string; n: number; first: number | null }>) {
    counts.set(row.tree_id, { updates: row.n, first: row.first });
  }
  for (const { id, ref } of db.query("SELECT id, ref FROM trees ORDER BY id").all() as Array<{ id: string; ref: ObjectHash }>) {
    const tree: TreeInventory = {
      id, short: !LONG_ID.test(id), root: ref,
      updates: counts.get(id)?.updates ?? 0, firstAcceptedAt: counts.get(id)?.first ?? null,
      directories: 0, files: 0, pages: 0, markdownFiles: [], mdx: [], treeEntries: [], missingObjects: 0,
    };
    const walk = async (hash: ObjectHash, path: string): Promise<void> => {
      let bytes: Uint8Array;
      try { bytes = await store.read(hash); } catch { tree.missingObjects++; return; }
      tree.directories++;
      for (const entry of decodeProtocolDirectory(bytes).entries) {
        const at = path ? `${path}/${entry.name}` : entry.name;
        if (entry.directory) await walk(entry.directory, at);
        else if (entry.tree) tree.treeEntries.push({ path: at, tree: entry.tree });
        else if (entry.page) tree.pages++;
        else tree.files++;
        if (entry.file && /\.md$/i.test(entry.name)) tree.markdownFiles.push(at);
        if (/\.mdx$/i.test(entry.name)) tree.mdx.push(at);
      }
    };
    await walk(ref, "");
    trees.push(tree);
  }

  const shortIds = new Set(trees.filter((tree) => tree.short).map((tree) => tree.id));
  const namedBy = new Map<string, string[]>([...shortIds].map((id) => [id, []]));
  const note = (id: string | null | undefined, where: string) => { if (id && shortIds.has(id)) namedBy.get(id)!.push(where); };
  for (const tree of trees) for (const entry of tree.treeEntries) note(entry.tree, `tree entry ${tree.id}:${entry.path}`);
  for (const row of db.query("SELECT path, tree_id, parent_tree FROM boundaries").all() as Array<{ path: string; tree_id: string; parent_tree: string | null }>) {
    note(row.tree_id, `boundary ${row.path}`);
    note(row.parent_tree, `boundary parent of ${row.path}`);
  }
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  // Any text column of a small table may name a tree: accounts, mounts, policy rows.
  for (const table of ["accounts", "mounts", "tree_policy", "tree_admins", "app_policy", "profile_locator_pins"]) {
    if (!tables.has(table)) continue;
    for (const row of db.query(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>) {
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== "string") continue;
        for (const id of shortIds) if (value === id || value.includes(`"${id}"`)) note(id, `${table}.${column}`);
      }
    }
  }

  const shortDevices = (db.query("SELECT id, account_id, label, revoked_at, last_used_at FROM devices ORDER BY id").all() as Array<{ id: string; account_id: string; label: string; revoked_at: number | null; last_used_at: number | null }>)
    .filter((device) => !LONG_ID.test(device.id))
    .map((device) => ({ id: device.id, account: device.account_id, label: device.label, revoked: device.revoked_at !== null, lastUsedAt: device.last_used_at }));
  db.close();
  return {
    dataRoot: root, trees,
    shortTrees: [...namedBy].map(([id, where]) => ({ id, namedBy: where })),
    shortDevices,
    entryTimesIndex: existsSync(join(root, "entry-times.sqlite3")),
  };
}

function summary(report: Inventory): string {
  const date = (ms: number | null) => (ms === null ? "-" : new Date(ms).toISOString().slice(0, 10));
  const lines = [`Data root ${report.dataRoot}: ${report.trees.length} trees, entry-times index ${report.entryTimesIndex ? "present" : "ABSENT (modified/created need it)"}`, ""];
  lines.push("Short TreeIDs (Joe's call each):");
  for (const tree of report.shortTrees) lines.push(`  ${tree.id}  named by: ${tree.namedBy.join("; ") || "nothing"}`);
  if (!report.shortTrees.length) lines.push("  none");
  lines.push("", "Short DeviceIDs (re-pair the live ones):");
  for (const device of report.shortDevices) lines.push(`  ${device.id}  ${device.label} (${device.account})${device.revoked ? " revoked" : `, last used ${date(device.lastUsedAt)}`}`);
  if (!report.shortDevices.length) lines.push("  none");
  lines.push("", "Trees holding Markdown as files (converted to pages by the migration):");
  const markdown = report.trees.filter((tree) => tree.markdownFiles.length);
  for (const tree of markdown) lines.push(`  ${tree.id}: ${tree.markdownFiles.length} (${tree.markdownFiles.slice(0, 3).join(", ")}${tree.markdownFiles.length > 3 ? ", …" : ""})`);
  if (!markdown.length) lines.push("  none");
  lines.push("", ".mdx entries (no longer pages):");
  const mdx = report.trees.filter((tree) => tree.mdx.length);
  for (const tree of mdx) lines.push(`  ${tree.id}: ${tree.mdx.join(", ")}`);
  if (!mdx.length) lines.push("  none");
  lines.push("", "tree                                  updates  since       dirs  files  pages  missing");
  for (const tree of report.trees) {
    lines.push(`  ${tree.id.padEnd(34)} ${String(tree.updates).padStart(7)}  ${date(tree.firstAcceptedAt)}  ${String(tree.directories).padStart(5)} ${String(tree.files).padStart(6)} ${String(tree.pages).padStart(6)} ${String(tree.missingObjects).padStart(8)}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const dataRoot = process.argv[2];
  if (!dataRoot) throw new Error("usage: inventory.ts <data-root> [--json]");
  const report = await inventory(dataRoot);
  console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : summary(report));
}
