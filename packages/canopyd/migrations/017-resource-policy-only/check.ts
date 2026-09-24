import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { ObjectStore } from "@overstory/object-store";
import {
  decodeWireDirectory,
  parseCanopyAccountConfiguration,
  parseResourceConfiguration,
  type ObjectHash,
} from "@overstory/protocol";

/** Read-only pre-deploy check for resource-only `trees.yaml`.
 *
 * The release that carries this directory reads `trees.yaml` only in the
 * resource-rule grammar (`who` / `allow`); the legacy `subject` / `access`
 * grammar is gone. An account whose current configuration root still holds
 * a legacy file would stop parsing after the deploy. This lists them. It
 * opens the database read-only and never writes an object. */
export interface PolicyCheckReport {
  checked: number;
  /** Account-configuration trees whose current `trees.yaml` does not parse. */
  failing: Array<{ tree: string; root: string; error: string }>;
}

export async function checkResourcePolicy(
  trees: ReadonlyArray<{ id: string; ref: string }>,
  read: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<PolicyCheckReport> {
  const failing: PolicyCheckReport["failing"] = [];
  const text = async (hash: string) => new TextDecoder("utf-8", { fatal: true }).decode(await read(hash));
  for (const tree of trees) {
    try {
      const entries = decodeWireDirectory(await read(tree.ref)).entries;
      const file = (name: string) => {
        const entry = entries.find(candidate => candidate.name === name);
        if (!entry?.file) throw new Error(`missing ${name}`);
        return entry.file;
      };
      const account = parseCanopyAccountConfiguration(await text(file("account.yaml")));
      parseResourceConfiguration(await text(file("trees.yaml")), account);
    } catch (error) {
      failing.push({ tree: tree.id, root: tree.ref, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { checked: trees.length, failing };
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("usage: check.ts <data root>");
  const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
  let trees: Array<{ id: string; ref: string }>;
  try {
    trees = db.query("SELECT id, ref FROM trees WHERE policy = 'account-config-v2' AND status = 'active' ORDER BY id").all() as typeof trees;
  } finally { db.close(); }
  const store = new ObjectStore(join(root, "objects"));
  const report = await checkResourcePolicy(trees, hash => store.read(hash));
  console.log(JSON.stringify(report, null, 2));
  if (report.failing.length) process.exit(1);
}
