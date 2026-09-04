import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic, TreeID } from "@arbor/core";
import { configurationTreeID } from "./account-config-v2.ts";
import { arborPrivateRoot } from "./private-state.ts";

export interface RehomeTransaction {
  version: 1;
  tree: TreeID;
  sourceConfigurationTree: TreeID;
  destinationConfigurationTree: TreeID;
  sourceCanonical: string;
  destinationCanonical: string;
}

function directory(): string {
  return join(arborPrivateRoot(), "rehome");
}

function pathFor(tree: string): string {
  return join(directory(), `${configurationTreeID(tree, "rehome tree")}.json`);
}

function parse(value: unknown, path: string): RehomeTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("rehome transaction must be an object");
  const record = value as Record<string, unknown>;
  const expected = ["version", "tree", "sourceConfigurationTree", "destinationConfigurationTree", "sourceCanonical", "destinationCanonical"];
  const unknown = Object.keys(record).filter((key) => !expected.includes(key));
  if (unknown.length) throw new Error(`rehome transaction has unknown fields: ${unknown.join(", ")}`);
  if (record.version !== 1) throw new Error("rehome transaction version must be 1");
  const tree = configurationTreeID(record.tree, "rehome tree");
  const sourceConfigurationTree = configurationTreeID(record.sourceConfigurationTree, "rehome source account");
  const destinationConfigurationTree = configurationTreeID(record.destinationConfigurationTree, "rehome destination account");
  if (sourceConfigurationTree === destinationConfigurationTree) throw new Error("rehome accounts must differ");
  if (typeof record.sourceCanonical !== "string" || typeof record.destinationCanonical !== "string") {
    throw new Error("rehome canonical URLs must be strings");
  }
  for (const canonical of [record.sourceCanonical, record.destinationCanonical]) {
    const url = new URL(canonical);
    if (!url.pathname.startsWith("/") || url.search || url.hash || url.username || url.password) {
      throw new Error(`rehome canonical URL is invalid: ${canonical}`);
    }
  }
  if (!path.endsWith(`${tree}.json`)) throw new Error("rehome filename does not match its TreeID");
  return {
    version: 1,
    tree,
    sourceConfigurationTree,
    destinationConfigurationTree,
    sourceCanonical: record.sourceCanonical,
    destinationCanonical: record.destinationCanonical,
  };
}

export async function loadRehomeTransactions(): Promise<{
  transactions: Map<TreeID, RehomeTransaction>;
  diagnostics: Diagnostic[];
}> {
  const transactions = new Map<TreeID, RehomeTransaction>();
  const diagnostics: Diagnostic[] = [];
  let names: string[];
  try { names = await readdir(directory()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { transactions, diagnostics };
    throw error;
  }
  for (const name of names.sort()) {
    const path = join(directory(), name);
    try {
      if (!name.endsWith(".json")) throw new Error("rehome transaction filename must end in .json");
      const transaction = parse(JSON.parse(await readFile(path, "utf8")), path);
      transactions.set(transaction.tree, transaction);
    } catch (error) {
      diagnostics.push({
        code: "invalid-rehome-transaction",
        message: error instanceof Error ? error.message : String(error),
        path,
        severity: "error",
      });
    }
  }
  return { transactions, diagnostics };
}

export async function saveRehomeTransaction(transaction: RehomeTransaction): Promise<void> {
  const validated = parse(transaction, pathFor(transaction.tree));
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  const destination = pathFor(validated.tree);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(validated)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function clearRehomeTransaction(tree: string): Promise<void> {
  await rm(pathFor(tree), { force: true });
}
