// Migration 003: convert schema-4 account-configuration trees and a singleton
// local Arbor home to the Interface 005 plural-account layout.
//
//   bun run migrations/003-multi-canopy-accounts/run.ts canopy-root <data-root>
//   bun run migrations/003-multi-canopy-accounts/run.ts local-home <data-home> --backup <backup-path>
//
// Modes are explicit. The runner never guesses from directory contents and
// reports only safe IDs, roots, paths, counts, and aggregate checksums.
import { Database } from "bun:sqlite";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { sha256, type Hash } from "@arbor/core";
import {
  parseAccountConfiguration,
  parseAccountDevicesConfiguration,
  parseCanopyAccountConfiguration,
  parseDeviceConfiguration,
  parseHostedTreesConfiguration,
  parseLocalPlacements,
  parseTreesConfiguration,
} from "@arbor/stores";
import { stringify, parseDocument } from "yaml";
import { readAccountConfigGraph } from "../../packages/canopy/src/account-policy.ts";
import {
  readAccountConfigGraphV2,
  snapshotAccountConfigV2,
  type AccountConfigGraphV2,
} from "../../packages/canopy/src/account-policy-v2.ts";
import { CanopyDaemon } from "../../packages/canopy/src/canopy.ts";
import { ObjectStore } from "../../packages/canopy/src/objects.ts";
import { AUTHORITY_SCHEMA, CANOPY_SCHEMA_VERSION, assertCurrentCanopySchema } from "../../packages/canopy/src/schema.ts";
import { AcceptedUpdateStore } from "../../packages/canopy/src/updates/store.ts";

const FROM_CANOPY_STAMP = "4";
const TARGET_CANOPY_STAMP = "5";
const FROM_LOCAL_STAMP = "3";
const TARGET_LOCAL_STAMP = "4";
const SERVICE = "org.arbor.community-account";
const TREE_ID = /^tr_[a-z2-7]+$/;
const HASH = /^sha256:[a-f0-9]{64}$/;

export interface SecretStore {
  get(location: { service: string; name: string }): Promise<string | null>;
  set(location: { service: string; name: string; value: string }): Promise<void>;
}

const systemSecrets: SecretStore = {
  get: (location) => Bun.secrets.get(location).catch(() => null),
  set: (location) => Bun.secrets.set(location),
};

export interface CanopyMigrationReport {
  mode: "canopy-root";
  fromSchema: string;
  toSchema: string;
  alreadyMigrated: boolean;
  trees: Array<{ id: string; root: Hash; previousRoot: Hash; rewritten: boolean }>;
  accounts: Array<{
    id: string;
    configurationTree: string;
    profileTree: string;
    previousRoot: Hash;
    root: Hash;
    devices: number;
    trees: number;
  }>;
}

export interface LocalMigrationReport {
  mode: "local-home";
  fromLayout: "singleton-v1" | "accounts-v2";
  toLayout: "accounts-v2";
  alreadyMigrated: boolean;
  configurationTree: string;
  profileTree: string;
  currentDevice: string;
  placements: number;
  backup?: string;
  backupChecksum?: Hash;
  backupFiles?: number;
}

function exactColumns(db: Database): void {
  const issues: string[] = [];
  for (const [table, expected] of Object.entries(AUTHORITY_SCHEMA)) {
    const actual = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
    if (actual.length !== expected.length || expected.some((name) => !actual.includes(name))) issues.push(table);
  }
  if (issues.length) throw new Error(`Canopy schema 4 has unexpected columns: ${issues.join(", ")}`);
  if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Canopy data root has foreign-key violations");
}

function safeOrigin(value: string, label: string): string {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.origin !== value || url.username || url.password) {
    throw new Error(`${label} must be a normalized HTTPS origin`);
  }
  return value;
}

function v2GraphFromV1(graph: ReturnType<typeof readAccountConfigGraph>): Omit<AccountConfigGraphV2, "sources"> {
  const canopy = safeOrigin(graph.account.community, "account.yaml community");
  return {
    account: { canopy, profile: graph.account.profile.tree },
    trees: Object.fromEntries(Object.entries(graph.trees.trees).map(([id, tree]) => [id, {
      canonical: `${canopy}${tree.canonicalPath === "/" ? "/" : tree.canonicalPath}`,
      access: tree.access,
    }])),
    devices: Object.fromEntries(Object.entries(graph.devices).map(([id, device]) => [id, {
      id,
      label: device.label,
      administrator: graph.account.admins.includes(id),
    }])),
  };
}

function activeDeviceRows(db: Database, accountID: string): Array<{ id: string; label: string }> {
  return db.query("SELECT id, label FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY id")
    .all(accountID) as Array<{ id: string; label: string }>;
}

function validateCanopyAccount(
  db: Database,
  row: { id: string; handle: string; profile_tree: string; config_tree: string; ref: Hash; policy: string },
  graph: ReturnType<typeof readAccountConfigGraph>,
): void {
  if (row.policy !== "account-config-v1") throw new Error(`Configuration tree ${row.config_tree} is not v1`);
  if (graph.account.profile.tree !== row.profile_tree || graph.account.profile.handle !== row.handle) {
    throw new Error(`Account ${row.id} identity does not match its configuration tree`);
  }
  const configured = Object.values(graph.devices).sort((a, b) => a.id.localeCompare(b.id));
  const active = activeDeviceRows(db, row.id);
  if (configured.length !== active.length || configured.some((device, index) => device.id !== active[index]?.id || device.label !== active[index]?.label)) {
    throw new Error(`Account ${row.id} active devices do not match its configuration tree`);
  }
  if (!graph.account.admins.length || graph.account.admins.some((id) => !graph.devices[id])) {
    throw new Error(`Account ${row.id} has an invalid administrator set`);
  }
  for (const [treeID, declaration] of Object.entries(graph.trees.trees)) {
    const boundary = db.query("SELECT path FROM boundaries WHERE tree_id = ?").get(treeID) as { path: string } | null;
    const reservation = db.query("SELECT canonical_path AS path FROM tree_reservations WHERE id = ? AND account_id = ?")
      .get(treeID, row.id) as { path: string } | null;
    if ((boundary?.path ?? reservation?.path) !== declaration.canonicalPath) {
      throw new Error(`Account ${row.id} declaration ${treeID} does not match Canopy policy`);
    }
    if (boundary) {
      const actual = (db.query("SELECT subject_kind, subject, access FROM access WHERE tree_id = ? ORDER BY subject_kind, subject")
        .all(treeID) as Array<{ subject_kind: string; subject: string; access: string }>);
      const expected = declaration.access.map((rule) => ({
        subject_kind: rule.subject.kind,
        subject: rule.subject.kind === "everyone" ? "everyone" : rule.subject.kind === "profile" ? rule.subject.tree : rule.subject.digest,
        access: rule.access,
      })).sort((left, right) => `${left.subject_kind}\0${left.subject}`.localeCompare(`${right.subject_kind}\0${right.subject}`));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Account ${row.id} access policy ${treeID} does not match its configuration tree`);
      }
    }
  }
}

async function alreadyMigratedCanopy(db: Database, objects: ObjectStore): Promise<CanopyMigrationReport> {
  assertCurrentCanopySchema(db);
  const accounts = db.query(`
    SELECT a.id, a.profile_tree, a.config_tree, t.ref, t.policy
    FROM accounts a JOIN trees t ON t.id = a.config_tree ORDER BY a.id
  `).all() as Array<{ id: string; profile_tree: string; config_tree: string; ref: Hash; policy: string }>;
  const report: CanopyMigrationReport["accounts"] = [];
  for (const row of accounts) {
    if (row.policy !== "account-config-v2") throw new Error(`Schema 5 contains legacy configuration tree ${row.config_tree}`);
    const graph = readAccountConfigGraphV2(await objects.completeSnapshot(row.ref), row.config_tree);
    report.push({
      id: row.id,
      configurationTree: row.config_tree,
      profileTree: row.profile_tree,
      previousRoot: row.ref,
      root: row.ref,
      devices: Object.keys(graph.devices).length,
      trees: Object.keys(graph.trees).length,
    });
  }
  return {
    mode: "canopy-root",
    fromSchema: TARGET_CANOPY_STAMP,
    toSchema: TARGET_CANOPY_STAMP,
    alreadyMigrated: true,
    trees: report.map((account) => ({ id: account.configurationTree, root: account.root, previousRoot: account.root, rewritten: false })),
    accounts: report,
  };
}

export async function migrateCanopyRoot(input: string): Promise<CanopyMigrationReport> {
  if (CANOPY_SCHEMA_VERSION !== TARGET_CANOPY_STAMP) {
    throw new Error(`Migration target ${TARGET_CANOPY_STAMP} does not match this build's schema ${CANOPY_SCHEMA_VERSION}`);
  }
  const dataRoot = await realpath(resolve(input));
  const database = join(dataRoot, "canopy.sqlite3");
  const objects = new ObjectStore(join(dataRoot, "objects"));
  const db = new Database(database);
  let completed: CanopyMigrationReport | undefined;
  try {
    const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null)?.value ?? null;
    if (stamp === TARGET_CANOPY_STAMP) return alreadyMigratedCanopy(db, objects);
    if (stamp !== FROM_CANOPY_STAMP) {
      throw new Error(`Canopy data root is at schema version ${stamp ?? "1 (unstamped)"}; migration 003 requires ${FROM_CANOPY_STAMP}`);
    }
    exactColumns(db);
    const host = (db.query("SELECT value FROM meta WHERE key = 'community_host'").get() as { value: string } | null)?.value;
    if (!host) throw new Error("Canopy data root has no configured public host");
    const rows = db.query(`
      SELECT a.id, a.handle, a.profile_tree, a.config_tree, t.ref, t.policy
      FROM accounts a LEFT JOIN trees t ON t.id = a.config_tree ORDER BY a.id
    `).all() as Array<{ id: string; handle: string; profile_tree: string | null; config_tree: string | null; ref: Hash | null; policy: string | null }>;
    if (!rows.length) throw new Error("Canopy data root has no accounts to migrate");
    if (rows.some((row) => !row.profile_tree || !row.config_tree || !row.ref || !row.policy)) {
      throw new Error("Every Canopy account must have profile and configuration trees before migration");
    }
    const orphaned = db.query(`
      SELECT COUNT(*) AS count FROM trees t
      WHERE t.policy = 'account-config-v1'
        AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.config_tree = t.id AND a.id = t.account_id)
    `).get() as { count: number };
    if (orphaned.count) throw new Error("Canopy contains an ungoverned v1 account-configuration tree");
    const converted: Array<{
      row: { id: string; handle: string; profile_tree: string; config_tree: string; ref: Hash; policy: string };
      graph: Omit<AccountConfigGraphV2, "sources">;
      root: Hash;
      objects: Map<any, Uint8Array>;
    }> = [];
    for (const candidate of rows) {
      const row = candidate as typeof converted[number]["row"];
      const snapshot = await objects.completeSnapshot(row.ref);
      const graph = readAccountConfigGraph(snapshot, row.config_tree);
      if (new URL(graph.account.community).host !== host) throw new Error(`Account ${row.id} origin does not match the configured Canopy host`);
      validateCanopyAccount(db, row, graph);
      const nextGraph = v2GraphFromV1(graph);
      const next = snapshotAccountConfigV2(nextGraph);
      readAccountConfigGraphV2(next, row.config_tree);
      converted.push({ row, graph: nextGraph, root: next.root as Hash, objects: next.objects });
    }
    await objects.store(converted.flatMap((entry) => [...entry.objects].map(([hash, bytes]) => ({ hash, bytes }))));
    const now = Date.now();
    db.transaction(() => {
      const updates = new AcceptedUpdateStore(db);
      for (const entry of converted) {
        const changed = db.run("UPDATE trees SET ref = ?, updated_at = ?, policy = 'account-config-v2' WHERE id = ? AND ref = ? AND policy = 'account-config-v1'", [
          entry.root, now, entry.row.config_tree, entry.row.ref,
        ]);
        if (changed.changes !== 1) throw new Error(`Configuration tree ${entry.row.config_tree} changed during migration`);
        db.run("DELETE FROM observations WHERE tree_id = ?", [entry.row.config_tree]);
        db.run("DELETE FROM accepted_updates WHERE tree_id = ?", [entry.row.config_tree]);
        db.run("DELETE FROM reflog WHERE tree_id = ?", [entry.row.config_tree]);
        updates.insert({ tree: entry.row.config_tree, root: entry.root, previousRoot: null, kind: "restored", acceptedAt: now });
        db.run("INSERT INTO reflog (tree_id, ref, previous_ref, changed_at) VALUES (?, ?, NULL, ?)", [entry.row.config_tree, entry.root, now]);
      }
      db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [TARGET_CANOPY_STAMP]);
    })();
    assertCurrentCanopySchema(db);
    completed = {
      mode: "canopy-root",
      fromSchema: FROM_CANOPY_STAMP,
      toSchema: TARGET_CANOPY_STAMP,
      alreadyMigrated: false,
      trees: converted.map((entry) => ({
        id: entry.row.config_tree,
        root: entry.root,
        previousRoot: entry.row.ref,
        rewritten: entry.root !== entry.row.ref,
      })),
      accounts: converted.map((entry) => ({
        id: entry.row.id,
        configurationTree: entry.row.config_tree,
        profileTree: entry.row.profile_tree,
        previousRoot: entry.row.ref,
        root: entry.root,
        devices: Object.keys(entry.graph.devices).length,
        trees: Object.keys(entry.graph.trees).length,
      })),
    };
  } finally {
    db.close();
  }
  const reopened = await CanopyDaemon.open(dataRoot);
  try {
    for (const account of completed!.accounts) {
      const stored = reopened.account(account.id);
      if (!stored || stored.profileTree !== account.profileTree || stored.configTree !== account.configurationTree) {
        throw new Error(`Migrated account ${account.id} failed production reopen`);
      }
      const graph = await readMigratedGraph(objects, account.configurationTree, account.root);
      for (const [tree, declaration] of Object.entries(graph.trees)) {
        const active = reopened.get(tree);
        if (active && reopened.resolve(new URL(declaration.canonical).pathname)?.tree.id !== tree) {
          throw new Error(`Migrated canonical resolution failed for ${tree}`);
        }
      }
    }
  } finally {
    await reopened[Symbol.asyncDispose]();
  }
  return completed!;
}

// Kept separate so production-reopen verification always decodes from disk.
async function readMigratedGraph(objects: ObjectStore, tree: string, root: Hash): Promise<AccountConfigGraphV2> {
  return readAccountConfigGraphV2(await objects.completeSnapshot(root), tree);
}

interface LegacyCommunityRecord {
  origin: string;
  id: string;
  handle: string;
  profileTree: string;
  configurationTree: string;
  communityTree: string;
  communityURL: string;
  credential: string;
  tokenDigest: string;
  configurationRef?: string;
  configurationUpdate?: string;
}

function parseCommunityRecord(source: string): LegacyCommunityRecord {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source);
  if (!match) throw new Error("Legacy community record has no YAML frontmatter");
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors[0]!.message);
  const value = document.toJS() as Record<string, unknown>;
  const required = ["origin", "id", "handle", "profileTree", "configurationTree", "communityTree", "communityURL", "credential", "tokenDigest"];
  if (required.some((key) => typeof value[key] !== "string")) throw new Error("Legacy community record is incomplete");
  const record = value as unknown as LegacyCommunityRecord;
  safeOrigin(record.origin, "Legacy community origin");
  if (!TREE_ID.test(record.profileTree) || !TREE_ID.test(record.configurationTree) || !TREE_ID.test(record.communityTree)) {
    throw new Error("Legacy community record has invalid TreeIDs");
  }
  if (!/^[a-f0-9]{64}$/.test(record.tokenDigest)) throw new Error("Legacy community record token digest is invalid");
  return record;
}

function credentialLocation(reference: string): { service: string; name: string } {
  const at = reference.lastIndexOf("/");
  if (at < 1 || at === reference.length - 1) throw new Error("Legacy credential reference is invalid");
  return { service: reference.slice(0, at), name: reference.slice(at + 1) };
}

function nextCredentialLocation(dataHome: string, configurationTree: string): { service: string; name: string } {
  return { service: SERVICE, name: `account-${sha256(`${dataHome}\0${configurationTree}`).slice(0, 24)}` };
}

function yaml(value: unknown): string {
  return stringify(value, { aliasDuplicateObjects: false, lineWidth: 0, sortMapEntries: true });
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const candidate = join(path, name);
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error(`Migration refuses symlink in data home: ${relative(root, candidate)}`);
      if (info.isDirectory()) await visit(candidate);
      else if (info.isFile()) result.push(candidate);
      else throw new Error(`Migration refuses special file in data home: ${relative(root, candidate)}`);
    }
  }
  await visit(root);
  return result;
}

async function treeChecksum(root: string): Promise<{ checksum: Hash; files: number }> {
  const rows: string[] = [];
  for (const path of await sourceFiles(root)) {
    const name = relative(root, path).split(sep).join("/");
    rows.push(`${name}\0${sha256(new Uint8Array(await readFile(path)))}`);
  }
  return { checksum: `sha256:${sha256(rows.join("\n"))}` as Hash, files: rows.length };
}

async function defaultDaemonIsRunning(dataHome: string): Promise<boolean> {
  if (resolve(dataHome) !== resolve(homedir(), ".arbor")) return false;
  try {
    const response = await fetch("http://127.0.0.1:4317/v1/status", { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch { return false; }
}

async function validateMigratedHome(dataHome: string, secrets: SecretStore): Promise<LocalMigrationReport> {
  const legacy = ["account.yaml", "trees.yaml", "devices"];
  if ((await Promise.all(legacy.map((name) => exists(join(dataHome, name))))).some(Boolean)) {
    throw new Error("Plural data home still contains singleton account files");
  }
  const accountNames = (await readdir(join(dataHome, "accounts"))).filter((name) => TREE_ID.test(name)).sort();
  if (accountNames.length !== 1) throw new Error("Migration 003 expects exactly one migrated account checkout");
  const configurationTree = accountNames[0]!;
  const checkout = join(dataHome, "accounts", configurationTree);
  const accountSource = await readFile(join(checkout, "account.yaml"), "utf8");
  const account = parseCanopyAccountConfiguration(accountSource);
  const trees = parseHostedTreesConfiguration(await readFile(join(checkout, "trees.yaml"), "utf8"), account);
  const devices = parseAccountDevicesConfiguration(await readFile(join(checkout, "devices.yaml"), "utf8"));
  const deviceIDs = Object.keys(devices);
  const current = JSON.parse(await readFile(join(dataHome, ".state", "accounts", configurationTree, "device.json"), "utf8")) as { id?: unknown };
  if (typeof current.id !== "string" || !deviceIDs.includes(current.id)) throw new Error("Current device is absent from migrated devices.yaml");
  const placementsSource = await readFile(join(dataHome, "placements.yaml"), "utf8");
  const placements = parseLocalPlacements(placementsSource);
  if (placements.some((placement) => placement.configurationTree !== configurationTree || !trees[placement.tree])) {
    throw new Error("placements.yaml refers outside the migrated account");
  }
  const connection = JSON.parse(await readFile(join(dataHome, ".state", "accounts", configurationTree, "connection.json"), "utf8")) as Record<string, unknown>;
  if (connection.configurationTree !== configurationTree || connection.profileTree !== account.profile || connection.origin !== account.canopy) {
    throw new Error("Migrated private account metadata does not match account.yaml");
  }
  const location = credentialLocation(String(connection.credential));
  const token = await secrets.get(location);
  if (!token || sha256(token) !== connection.tokenDigest) throw new Error("Migrated account credential is unavailable");
  const stamp = (await readFile(join(dataHome, ".state", "version"), "utf8")).trim();
  if (stamp !== TARGET_LOCAL_STAMP) throw new Error(`Migrated local state has stamp ${stamp || "missing"}, expected ${TARGET_LOCAL_STAMP}`);
  return {
    mode: "local-home",
    fromLayout: "accounts-v2",
    toLayout: "accounts-v2",
    alreadyMigrated: true,
    configurationTree,
    profileTree: account.profile,
    currentDevice: current.id,
    placements: placements.length,
  };
}

export async function migrateLocalHome(
  input: string,
  backupInput: string,
  secrets: SecretStore = systemSecrets,
): Promise<LocalMigrationReport> {
  const dataHome = resolve(input);
  const backup = resolve(backupInput);
  await assertDirectory(dataHome, "Local Arbor data home");
  const hasLegacy = await Promise.all(["account.yaml", "trees.yaml", "devices"].map((name) => exists(join(dataHome, name))));
  const hasPlural = await Promise.all(["accounts", "placements.yaml"].map((name) => exists(join(dataHome, name))));
  if (hasPlural.every(Boolean) && hasLegacy.every((value) => !value)) return validateMigratedHome(dataHome, secrets);
  if (!hasLegacy.every(Boolean) || hasPlural.some(Boolean)) throw new Error("Local data home is mixed, partial, or not the exact singleton v1 layout");
  if (backup === dataHome || backup.startsWith(`${dataHome}${sep}`) || dataHome.startsWith(`${backup}${sep}`)) {
    throw new Error("Backup must be a separate path outside the Arbor data home");
  }
  if (await exists(backup)) throw new Error(`Backup destination already exists: ${backup}`);
  if (await defaultDaemonIsRunning(dataHome)) throw new Error("Arbor Sync is still running; stop the daemon before migration");
  const lockPath = join(dataHome, ".state", "migration.lock");
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const lock = await open(lockPath, "wx", 0o600).catch(() => null);
  if (!lock) throw new Error("Another process holds the Arbor migration lock");
  await lock.writeFile(`${process.pid}\n`);
  await lock.close();
  let stage: string | undefined;
  let retired: string | undefined;
  try {
    const sourceStamp = (await readFile(join(dataHome, ".state", "version"), "utf8").catch(() => "")).trim();
    if (sourceStamp !== FROM_LOCAL_STAMP) throw new Error(`Local state is at version ${sourceStamp || "unstamped"}; migration 003 requires ${FROM_LOCAL_STAMP}`);
    const account = parseAccountConfiguration(await readFile(join(dataHome, "account.yaml"), "utf8"), "account.yaml");
    const trees = parseTreesConfiguration(await readFile(join(dataHome, "trees.yaml"), "utf8"), "trees.yaml");
    const deviceNames = (await readdir(join(dataHome, "devices"))).sort();
    if (!deviceNames.length || deviceNames.some((name) => !/^dv_[a-z2-7]+\.yaml$/.test(name))) {
      throw new Error("Legacy devices directory has unsupported entries");
    }
    const devices = Object.fromEntries(await Promise.all(deviceNames.map(async (name) => {
      const id = name.slice(0, -".yaml".length);
      return [id, parseDeviceConfiguration(await readFile(join(dataHome, "devices", name), "utf8"), id, `devices/${name}`)] as const;
    })));
    if (account.admins.some((id) => !devices[id])) throw new Error("Legacy administrator is not an active device");
    const current = JSON.parse(await readFile(join(dataHome, ".state", "device.json"), "utf8")) as { id?: unknown };
    if (typeof current.id !== "string" || !devices[current.id]) throw new Error("Legacy current DeviceID is missing or inactive");
    const community = parseCommunityRecord(await readFile(join(dataHome, ".state", "system", "community.md"), "utf8"));
    if (
      community.origin !== account.community
      || community.handle !== account.profile.handle
      || community.profileTree !== account.profile.tree
      || !TREE_ID.test(community.configurationTree)
    ) throw new Error("Legacy account metadata does not match the synchronized account graph");
    const oldLocation = credentialLocation(community.credential);
    const token = await secrets.get(oldLocation);
    if (!token || sha256(token) !== community.tokenDigest) throw new Error("Legacy account credential is unavailable");
    const currentDevice = devices[current.id];
    if (!currentDevice) throw new Error("Legacy current DeviceID is missing or inactive");
    const currentPlacements = currentDevice.placements;
    const paths = new Set<string>();
    for (const [tree, placement] of Object.entries(currentPlacements)) {
      if (!trees.trees[tree]) throw new Error(`Current device places undeclared tree ${tree}`);
      if (!placement.path || !isAbsolute(placement.path) || normalize(placement.path) !== placement.path) {
        throw new Error(`Current device placement ${tree} has an invalid path`);
      }
      if (placement.server !== account.community) throw new Error(`Current device placement ${tree} uses another Canopy`);
      if (paths.has(placement.path)) throw new Error(`Duplicated placement path: ${placement.path}`);
      paths.add(placement.path);
    }
    const nextGraph = v2GraphFromV1({ account, trees, devices, sources: {} });
    const snapshot = snapshotAccountConfigV2(nextGraph);
    readAccountConfigGraphV2(snapshot, community.configurationTree);
    await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
    await cp(dataHome, backup, { recursive: true, preserveTimestamps: true, errorOnExist: true });
    await rm(join(backup, ".state", "migration.lock"), { force: true });
    const backupProof = await treeChecksum(backup);
    stage = await mkdtemp(join(dirname(dataHome), `.${basename(dataHome)}.migration-003-stage-`));
    await rm(stage, { recursive: true, force: true });
    await cp(dataHome, stage, { recursive: true, preserveTimestamps: true });
    const checkout = join(stage, "accounts", community.configurationTree);
    await mkdir(checkout, { recursive: true, mode: 0o700 });
    await writeFile(join(checkout, "account.yaml"), yaml(nextGraph.account), { mode: 0o600 });
    await writeFile(join(checkout, "trees.yaml"), yaml(nextGraph.trees), { mode: 0o600 });
    await writeFile(join(checkout, "devices.yaml"), yaml(Object.fromEntries(Object.entries(nextGraph.devices).map(([id, device]) => [id, {
      label: device.label,
      ...(device.administrator ? { administrator: true } : {}),
    }]))), { mode: 0o600 });
    const placements = { [community.configurationTree]: Object.fromEntries(Object.entries(currentPlacements).map(([tree, placement]) => [placement.path!, tree])) };
    await writeFile(join(stage, "placements.yaml"), yaml(placements), { mode: 0o600 });
    const nextLocation = nextCredentialLocation(dataHome, community.configurationTree);
    const connection = {
      configurationTree: community.configurationTree,
      origin: community.origin,
      account: `${community.origin}/~${community.handle}`,
      accountID: community.id,
      handle: community.handle,
      profileTree: community.profileTree,
      deviceID: current.id,
      credential: `${nextLocation.service}/${nextLocation.name}`,
      tokenDigest: community.tokenDigest,
      configurationRef: snapshot.root,
      connected: true,
    };
    const privateAccount = join(stage, ".state", "accounts", community.configurationTree);
    await mkdir(privateAccount, { recursive: true, mode: 0o700 });
    await writeFile(join(privateAccount, "connection.json"), `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(privateAccount, "device.json"), `${JSON.stringify({ id: current.id })}\n`, { mode: 0o600 });
    await writeFile(join(stage, ".state", "version"), `${TARGET_LOCAL_STAMP}\n`, { mode: 0o600 });
    await rm(join(stage, "account.yaml"), { force: true });
    await rm(join(stage, "trees.yaml"), { force: true });
    await rm(join(stage, "devices"), { recursive: true, force: true });
    await rm(join(stage, ".state", "device.json"), { force: true });
    await rm(join(stage, ".state", "system", "community.md"), { force: true });
    await rm(join(stage, ".state", "migration.lock"), { force: true });
    await secrets.set({ ...nextLocation, value: token });
    await validateMigratedHome(stage, secrets);
    retired = join(dirname(dataHome), `.${basename(dataHome)}.migration-003-source-${crypto.randomUUID()}`);
    await rename(dataHome, retired);
    try { await rename(stage, dataHome); stage = undefined; }
    catch (error) { await rename(retired, dataHome); retired = undefined; throw error; }
    await rm(retired, { recursive: true, force: true });
    retired = undefined;
    const verified = await validateMigratedHome(dataHome, secrets);
    return {
      ...verified,
      fromLayout: "singleton-v1",
      alreadyMigrated: false,
      backup,
      backupChecksum: backupProof.checksum,
      backupFiles: backupProof.files,
    };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
    if (retired && !await exists(dataHome)) await rename(retired, dataHome).catch(() => {});
    await rm(join(dataHome, ".state", "migration.lock"), { force: true }).catch(() => {});
  }
}

function usage(): never {
  console.error("usage: run.ts canopy-root <data-root> | local-home <data-home> --backup <backup-path>");
  process.exit(2);
}

if (import.meta.main) {
  const [mode, target, flag, backup] = process.argv.slice(2);
  if (!target) usage();
  const report = mode === "canopy-root"
    ? await migrateCanopyRoot(target)
    : mode === "local-home" && flag === "--backup" && backup
      ? await migrateLocalHome(target, backup)
      : usage();
  console.log(JSON.stringify(report, null, 2));
}
