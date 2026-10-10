// Schema 21 as migration 022 reads it: the account configuration's three
// files and the tables this migration drops. It goes when this directory is
// deleted.
import type { Database } from "bun:sqlite";
import { parseDocument, isAlias, visit } from "yaml";
import { decodeProtocolDirectory, type ObjectHash, type TreeSnapshot } from "@overstory/protocol";

/** A schema-21 resource rule: `via` where schema 22 says `app`, and `me` for the account's profile. */
export interface LegacyRule {
  who: "everyone" | "me" | { profile: string } | { link: string };
  via?: string;
  allow: string[];
  within?: string;
}

export interface LegacyAccountConfig {
  account: { canopy: string; profile: string };
  trees: Record<string, { canonical?: string; access: LegacyRule[] }>;
  devices: Record<string, { label: string; administrator?: boolean }>;
  sources: Record<"account.yaml" | "trees.yaml" | "devices.yaml", string>;
}

function strict(source: string, label: string): unknown {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`${label}: ${document.errors[0]!.message}`);
  visit(document, (_key, node) => { if (isAlias(node)) throw new Error(`${label}: YAML aliases are not allowed`); });
  return document.toJS({ maxAliasCount: 0 }) ?? {};
}

/** Read an accepted `account-config-v2` root. */
export function readLegacyAccountConfig(snapshot: TreeSnapshot): LegacyAccountConfig {
  const root = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
  const text = (name: string) => {
    const entry = root.entries.find((candidate) => candidate.name === name);
    if (!entry?.file) throw new Error(`Account configuration requires ${name}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(snapshot.objects.get(entry.file as ObjectHash)!);
  };
  const sources = { "account.yaml": text("account.yaml"), "trees.yaml": text("trees.yaml"), "devices.yaml": text("devices.yaml") };
  const account = strict(sources["account.yaml"], "account.yaml") as LegacyAccountConfig["account"];
  const trees = strict(sources["trees.yaml"], "trees.yaml") as Record<string, { canonical?: string; access?: LegacyRule[] }>;
  const devices = strict(sources["devices.yaml"], "devices.yaml") as LegacyAccountConfig["devices"];
  if (typeof account.canopy !== "string" || typeof account.profile !== "string") throw new Error("account.yaml is invalid");
  return {
    account,
    trees: Object.fromEntries(Object.entries(trees).map(([id, entry]) => [id, { ...(entry.canonical ? { canonical: entry.canonical } : {}), access: entry.access ?? [] }])),
    devices,
    sources,
  };
}

/** The schema-21 tables, for the migration's test fixture. */
export function createSchema21(db: Database, createShared: (db: Database) => void): void {
  db.run(`CREATE TABLE resource_policy (account_id TEXT NOT NULL, tree_id TEXT NOT NULL, rules_json TEXT NOT NULL, PRIMARY KEY(account_id, tree_id))`);
  db.run(`CREATE TABLE trees (id TEXT PRIMARY KEY, ref TEXT NOT NULL, policy TEXT NOT NULL DEFAULT 'ordinary', status TEXT NOT NULL DEFAULT 'active', account_id TEXT)`);
  db.run(`CREATE TABLE boundaries (path TEXT PRIMARY KEY, tree_id TEXT NOT NULL UNIQUE REFERENCES trees(id), parent_tree TEXT)`);
  createShared(db);
  db.run(`CREATE TABLE accounts (id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, profile_tree TEXT, config_tree TEXT, enabled INTEGER NOT NULL DEFAULT 1, claim_digest TEXT)`);
  db.run(`CREATE TABLE devices (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), label TEXT NOT NULL, token_digest TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER)`);
  db.run(`CREATE TABLE pairings (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), secret_digest TEXT NOT NULL, confirmation_code TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, claimed_at INTEGER, claimed_device TEXT)`);
  db.run(`CREATE TABLE account_challenges (id TEXT PRIMARY KEY, challenge_json TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER)`);
  db.run(`CREATE TABLE tree_reservations (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), canonical_path TEXT NOT NULL UNIQUE)`);
  db.run(`CREATE TABLE access (id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id), subject_kind TEXT NOT NULL, subject TEXT NOT NULL, access TEXT NOT NULL, UNIQUE(tree_id, subject_kind, subject))`);
  db.run(`CREATE TABLE profile_facts (tree_id TEXT PRIMARY KEY REFERENCES trees(id), index_hash TEXT NOT NULL, avatar_path TEXT, facts TEXT NOT NULL) WITHOUT ROWID`);
  db.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.run("INSERT INTO meta (key, value) VALUES ('schema_version', '21')");
}
