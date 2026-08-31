import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { canonicalJSONString, generateArborID, isGeneratedArborID, sha256, type AccessRule, type TreeKind } from "@arbor/core";
import { decodeWireFileRollup, SchemaSandbox } from "@arbor/stores";
import {
  decodeWireObject,
  encodeWireObject,
  applyFilePatch,
  hashObject,
  compareWireNames,
  wireEntryObjectHashes,
  updateRequestDigest,
  type AcceptedTransition,
  type AcceptedTransitionPayload,
  type AcceptedUpdate,
  type ServerDevice,
  type BoundaryKind,
  type FilePatch,
  type MergeSummary,
  type ObjectHash,
  type PairingOffer,
  type PublicAccess,
  type TreeSnapshot,
  type TreeAccess,
  type UpdateConflictResult,
  type UpdateRequest,
  type UpdateResult,
  type WireDirectory,
  type WireDirectoryEntry,
} from "@arbor/wire";
import {
  authorizeAccountConfigTransition,
  mergeAccountConfigGraphs,
  readAccountConfigGraph,
  snapshotAccountConfig,
  type AccountConfigGraph,
} from "./account-policy.ts";
import { reconcileUpdate } from "./updates/reconcile.ts";
import { AcceptedUpdateStore, type AcceptedUpdateInput } from "./updates/store.ts";
import { buildAcceptedTransitionPayload } from "./updates/transition.ts";

export interface CanonicalBoundary {
  path: string;
  tree: string;
  parentTree: string | null;
  kind: BoundaryKind;
}

export interface CanopyTree {
  id: string;
  canonicalPath: string | null;
  parentTree: string | null;
  kind: BoundaryKind;
  ref: ObjectHash;
  publicAccess: PublicAccess;
  updatedAt: number;
  policy: "ordinary" | "account-config-v1";
  status: "active" | "awaiting-initialization" | "error";
  accountID: string | null;
}

export interface CanopyAccount {
  id: string;
  handle: string;
  profileTree: string | null;
  configTree: string | null;
  enabled: boolean;
}

export interface CanopyAuthentication {
  account: CanopyAccount;
  subject: string;
  device: string | null;
}

export interface CanopyAccessEntry {
  id: string;
  tree: string;
  subjectKind: "everyone" | "profile" | "link";
  subject: string;
  access: TreeAccess;
  claimedProfile?: string;
}

export interface StoredUpdateResponse {
  status: number;
  result: UpdateResult | UpdateConflictResult;
}

export interface CanopyBootstrapAccount {
  handle: string;
  token: string;
  name?: string;
  communityWriter?: boolean;
}

export interface CanopyBootstrap {
  handle: string;
  name: string;
  accounts: CanopyBootstrapAccount[];
  communityHost?: string;
  firstWriter?: {
    handle: string;
    name?: string;
  };
}

const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const TREE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

function opaqueID(prefix: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return `${prefix}_${result}`;
}

function normalizeBoundaryPath(input: string): string {
  const decoded = decodeURI(input);
  if (!decoded.startsWith("/")) throw new Error(`Canonical boundary must be absolute: ${input}`);
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new Error(`Invalid canonical boundary: ${input}`);
  }
  return segments.length ? `/${segments.join("/")}` : "/";
}

function pathSegments(path: string): string[] {
  return normalizeBoundaryPath(path).split("/").filter(Boolean);
}

function profileHandle(path: string): string | null {
  const segments = pathSegments(path);
  if (segments.length !== 1 || !segments[0]!.startsWith("~")) return null;
  const handle = segments[0]!.slice(1);
  return HANDLE.test(handle) ? handle : null;
}

function sameOrDescendant(path: string, parent: string): boolean {
  return path === parent || parent === "/" || path.startsWith(`${parent}/`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function directSnapshot(source: string): TreeSnapshot {
  const fileBytes = encodeWireObject({ type: "file", bytes: new TextEncoder().encode(source) });
  const fileHash = hashObject(fileBytes);
  const rootBytes = encodeWireObject({
    type: "directory",
    entries: [{ name: "_index.md", hash: fileHash }],
  });
  const rootHash = hashObject(rootBytes);
  return { root: rootHash, objects: new Map([[fileHash, fileBytes], [rootHash, rootBytes]]) };
}

function profileSource(kind: "person" | "group", name: string, members: string[] = []): string {
  return [
    "---",
    `type: ${kind}`,
    ...(kind === "group"
      ? ["members:", ...members.map((member) => `  - ${JSON.stringify(member)}`)]
      : []),
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}

const AUTHORITY_SCHEMA = {
  trees: ["id", "ref", "updated_at", "policy", "status", "account_id"],
  boundaries: ["path", "tree_id", "parent_tree", "kind"],
  reflog: ["tree_id", "ref", "previous_ref", "changed_at"],
  accepted_updates: [
    "id", "tree_id", "sequence", "root", "previous_root", "kind", "accepted_at", "subject",
    "base_root", "candidate_root", "remote_root", "merge_summary", "request_digest", "transition_json",
  ],
  accounts: ["id", "handle", "profile_tree", "config_tree", "token_digest", "enabled", "claim_digest"],
  devices: ["id", "account_id", "label", "token_digest", "created_at", "last_used_at", "revoked_at"],
  pairings: ["id", "account_id", "secret_digest", "confirmation_code", "created_at", "expires_at", "claimed_at", "claimed_device"],
  access: ["id", "tree_id", "subject_kind", "subject", "access", "claimed_profile"],
  tree_reservations: ["id", "account_id", "kind", "canonical_path", "status", "error"],
  observation_events: ["cursor", "tree_id", "kind", "change_json", "created_at"],
  meta: ["key", "value"],
} as const;

function createCanopySchema(db: Database): void {
  db.run(`
    CREATE TABLE trees (
      id TEXT PRIMARY KEY,
      ref TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      policy TEXT NOT NULL DEFAULT 'ordinary',
      status TEXT NOT NULL DEFAULT 'active',
      account_id TEXT
    )
  `);
  db.run(`
    CREATE TABLE boundaries (
      path TEXT PRIMARY KEY,
      tree_id TEXT NOT NULL UNIQUE REFERENCES trees(id),
      parent_tree TEXT,
      kind TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE reflog (
      tree_id TEXT NOT NULL,
      ref TEXT NOT NULL,
      previous_ref TEXT,
      changed_at INTEGER NOT NULL
    )
  `);
  AcceptedUpdateStore.createSchema(db);
  db.run(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      profile_tree TEXT,
      config_tree TEXT,
      token_digest TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      claim_digest TEXT
    )
  `);
  db.run(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      label TEXT NOT NULL,
      token_digest TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE pairings (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      secret_digest TEXT NOT NULL,
      confirmation_code TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      claimed_at INTEGER,
      claimed_device TEXT
    )
  `);
  db.run(`
    CREATE TABLE tree_reservations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      kind TEXT NOT NULL,
      canonical_path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      error TEXT
    )
  `);
  db.run(`
    CREATE TABLE access (
      id TEXT PRIMARY KEY,
      tree_id TEXT NOT NULL REFERENCES trees(id),
      subject_kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      access TEXT NOT NULL,
      claimed_profile TEXT,
      UNIQUE(tree_id, subject_kind, subject)
    )
  `);
  db.run(`
    CREATE TABLE observation_events (
      cursor TEXT PRIMARY KEY,
      tree_id TEXT NOT NULL REFERENCES trees(id),
      kind TEXT NOT NULL,
      change_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run("CREATE INDEX observation_events_tree_order ON observation_events(tree_id, created_at, cursor)");
  db.run(`
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

function migrateCanopySchema(db: Database): void {
  const columns = (table: string) => new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name));
  if (!columns("trees").has("policy")) db.run("ALTER TABLE trees ADD COLUMN policy TEXT NOT NULL DEFAULT 'ordinary'");
  if (!columns("trees").has("status")) db.run("ALTER TABLE trees ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  if (!columns("trees").has("account_id")) db.run("ALTER TABLE trees ADD COLUMN account_id TEXT");
  if (!columns("accounts").has("config_tree")) db.run("ALTER TABLE accounts ADD COLUMN config_tree TEXT");
  if (!columns("accounts").has("claim_digest")) db.run("ALTER TABLE accounts ADD COLUMN claim_digest TEXT");
  if (!columns("pairings").has("claimed_device")) db.run("ALTER TABLE pairings ADD COLUMN claimed_device TEXT");
  if (!columns("accepted_updates").has("sequence")) db.run("ALTER TABLE accepted_updates ADD COLUMN sequence INTEGER");
  if (!columns("accepted_updates").has("transition_json")) db.run("ALTER TABLE accepted_updates ADD COLUMN transition_json TEXT");
  db.run(`
    WITH ranked AS (
      SELECT rowid, ROW_NUMBER() OVER (PARTITION BY tree_id ORDER BY accepted_at, rowid) AS sequence
      FROM accepted_updates
    )
    UPDATE accepted_updates
    SET sequence = (SELECT ranked.sequence FROM ranked WHERE ranked.rowid = accepted_updates.rowid)
    WHERE sequence IS NULL
  `);
  db.run("DROP INDEX IF EXISTS accepted_updates_tree_order");
  db.run("CREATE UNIQUE INDEX accepted_updates_tree_order ON accepted_updates(tree_id, sequence)");
  db.run(`CREATE TABLE IF NOT EXISTS tree_reservations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    kind TEXT NOT NULL,
    canonical_path TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    error TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS observation_events (
    cursor TEXT PRIMARY KEY,
    tree_id TEXT NOT NULL REFERENCES trees(id),
    kind TEXT NOT NULL,
    change_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS observation_events_tree_order ON observation_events(tree_id, created_at, cursor)");
}

function assertCurrentCanopySchema(db: Database): void {
  const issues: string[] = [];
  for (const [table, expected] of Object.entries(AUTHORITY_SCHEMA)) {
    const actual = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
    // ALTER TABLE appends columns, so a migrated SQLite table can have the
    // exact current schema in a different physical order than a newly created
    // table. Queries name every column; reject missing or extra columns, not
    // harmless storage order.
    if (actual.length !== expected.length || expected.some((name) => !actual.includes(name))) {
      issues.push(`${table} columns`);
    }
  }
  for (const obsolete of ["legacy_trees", "update_replays"]) {
    if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(obsolete)) {
      issues.push(`obsolete ${obsolete} table`);
    }
  }
  for (const index of ["accepted_updates_tree_order", "accepted_updates_request", "observation_events_tree_order"]) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)) {
      issues.push(`missing ${index} index`);
    }
  }
  if (!issues.length) {
    const missingHistory = db.query(`
      SELECT COUNT(*) AS count FROM trees t
      WHERE NOT EXISTS (SELECT 1 FROM accepted_updates u WHERE u.tree_id = t.id)
    `).get() as { count: number };
    const missingDevices = db.query(`
      SELECT COUNT(*) AS count FROM accounts a
      WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.account_id = a.id)
    `).get() as { count: number };
    if (missingHistory.count) issues.push("trees without accepted history");
    if (missingDevices.count) issues.push("accounts without devices");
    if (db.query("PRAGMA foreign_key_check").all().length) issues.push("foreign-key violations");
  }
  if (issues.length) {
    throw new Error(`Canopy schema requires the one-time migration before startup: ${issues.join(", ")}`);
  }
}

export class RefConflictError extends Error {
  constructor(readonly current: ObjectHash | null) {
    super("Tree ref changed");
    this.name = "RefConflictError";
  }
}

export class UpdateProtocolError extends Error {
  constructor(readonly code: "base-not-retained" | "server-busy", message: string) {
    super(message);
    this.name = "UpdateProtocolError";
  }
}

export class AlreadyClaimedError extends Error {
  constructor(readonly handle: string) {
    super(`Profile is already claimed: ~${handle}`);
    this.name = "AlreadyClaimedError";
  }
}

export class ReservedBoundaryConflictError extends Error {
  constructor(readonly path: string, readonly tree: string) {
    super(`Canonical boundary must remain mounted at ${path}`);
    this.name = "ReservedBoundaryConflictError";
  }
}

export class TreeIDConflictError extends Error {
  constructor(readonly tree: string) {
    super(`TreeID is already active with different content: ${tree}`);
    this.name = "TreeIDConflictError";
  }
}

export class CanopyDaemon implements AsyncDisposable {
  private readonly wireSchemas = new SchemaSandbox();
  private db: Database;
  private acceptedStore: AcceptedUpdateStore;
  private listeners = new Map<string, Set<(tree: CanopyTree, update: AcceptedUpdate, requestDigest?: ObjectHash) => void>>();
  private observationListeners = new Map<string, Set<(event: { cursor: string; tree: string; kind: string; change: unknown }) => void>>();
  private updateLocks = new Map<string, Promise<void>>();

  private constructor(readonly dataRoot: string, db: Database) {
    this.db = db;
    this.acceptedStore = new AcceptedUpdateStore(db);
  }

  static async open(dataRoot: string, bootstrap?: CanopyBootstrap): Promise<CanopyDaemon> {
    await mkdir(join(dataRoot, "objects"), { recursive: true });
    const databasePath = join(dataRoot, "canopy.sqlite3");
    const databaseExists = await stat(databasePath).then(() => true).catch(() => false);
    const db = new Database(databasePath, { create: true });
    try {
      if (databaseExists) {
        db.transaction(() => migrateCanopySchema(db))();
        assertCurrentCanopySchema(db);
      }
      else db.transaction(() => createCanopySchema(db))();
    } catch (error) {
      db.close();
      throw error;
    }
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    const canopy = new CanopyDaemon(dataRoot, db);
    if (!canopy.boundary("/")) {
      if (!bootstrap) throw new Error("A new Arbor server requires community bootstrap configuration");
      await canopy.bootstrap(bootstrap);
    }
    return canopy;
  }

  private async bootstrap(config: CanopyBootstrap): Promise<void> {
    if (!HANDLE.test(config.handle)) throw new Error(`Invalid community handle: ${config.handle}`);
    if (config.firstWriter && !HANDLE.test(config.firstWriter.handle)) {
      throw new Error(`Invalid first-writer handle: ${config.firstWriter.handle}`);
    }
    const memberHandles = [
      ...config.accounts.map((account) => account.handle),
      ...(config.firstWriter ? [config.firstWriter.handle] : []),
    ];
    const memberHost = config.communityHost ?? "community.invalid";
    const members = [...new Set(memberHandles)].map((handle) => `arbor://${memberHost}/~${handle}`);
    const community = await this.insertTree(
      "/",
      "community-profile",
      directSnapshot(profileSource("group", config.name, members)),
      "read",
      null,
    );
    this.db.run("INSERT INTO meta (key, value) VALUES ('community_handle', ?)", [config.handle]);
    if (config.firstWriter) {
      this.db.run("INSERT INTO meta (key, value) VALUES ('first_writer_handle', ?)", [config.firstWriter.handle]);
    }
    for (const account of config.accounts) {
      if (!HANDLE.test(account.handle)) throw new Error(`Invalid account handle: ${account.handle}`);
      const profile = await this.insertTree(
        `/~${account.handle}`,
        "person-profile",
        directSnapshot(profileSource("person", account.name ?? account.handle)),
        "read",
        community.id,
      );
      const accountID = opaqueID("ac");
      this.db.run(
        "INSERT INTO accounts (id, handle, profile_tree, token_digest, enabled) VALUES (?, ?, ?, ?, 1)",
        [accountID, account.handle, profile.id, sha256(account.token)],
      );
      this.db.run(
        "INSERT INTO devices (id, account_id, label, token_digest, created_at) VALUES (?, ?, 'Initial device', ?, ?)",
        [opaqueID("dv"), accountID, sha256(account.token), Date.now()],
      );
      this.setAccessInternal(profile.id, "profile", profile.id, "write");
      if (account.communityWriter !== false) {
        this.setAccessInternal(community.id, "profile", profile.id, "write");
      }
    }
  }

  private treeRow(value: unknown): CanopyTree | null {
    if (!value) return null;
    const row = value as {
      id: string;
      ref: string;
      updated_at: number;
      path: string | null;
      parent_tree: string | null;
      kind: BoundaryKind | null;
      public_access: PublicAccess | null;
      policy: CanopyTree["policy"];
      status: CanopyTree["status"];
      account_id: string | null;
    };
    return {
      id: row.id,
      canonicalPath: row.path,
      parentTree: row.parent_tree,
      kind: row.kind ?? "account-configuration",
      ref: row.ref,
      publicAccess: row.public_access ?? "none",
      updatedAt: row.updated_at,
      policy: row.policy,
      status: row.status,
      accountID: row.account_id,
    };
  }

  private treeSelect(where: string, value?: string): CanopyTree | null {
    const sql = `
      SELECT t.*, b.path, b.parent_tree, b.kind,
        COALESCE((SELECT access FROM access
          WHERE tree_id = t.id AND subject_kind = 'everyone' AND subject = 'everyone'), 'none') AS public_access
      FROM trees t LEFT JOIN boundaries b ON b.tree_id = t.id
      ${where}
    `;
    return this.treeRow(value === undefined ? this.db.query(sql).get() : this.db.query(sql).get(value));
  }

  list(): CanopyTree[] {
    return this.db.query(`
      SELECT t.*, b.path, b.parent_tree, b.kind,
        COALESCE((SELECT access FROM access
          WHERE tree_id = t.id AND subject_kind = 'everyone' AND subject = 'everyone'), 'none') AS public_access
      FROM trees t LEFT JOIN boundaries b ON b.tree_id = t.id
      ORDER BY b.path IS NULL, b.path
    `).all().map((row) => this.treeRow(row)!);
  }

  get(id: string): CanopyTree | null {
    return this.treeSelect("WHERE t.id = ?", id);
  }

  currentUpdate(treeID: string): AcceptedUpdate | null {
    return this.acceptedStore.current(treeID);
  }

  observedThrough(treeID?: string): string {
    const update = (treeID
      ? this.db.query("SELECT id AS cursor, accepted_at AS changed_at, rowid AS ordinal FROM accepted_updates WHERE tree_id = ? ORDER BY accepted_at DESC, rowid DESC LIMIT 1").get(treeID)
      : this.db.query("SELECT id AS cursor, accepted_at AS changed_at, rowid AS ordinal FROM accepted_updates ORDER BY accepted_at DESC, rowid DESC LIMIT 1").get()) as { cursor: string; changed_at: number; ordinal: number } | null;
    const event = (treeID
      ? this.db.query("SELECT cursor, created_at AS changed_at, rowid AS ordinal FROM observation_events WHERE tree_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(treeID)
      : this.db.query("SELECT cursor, created_at AS changed_at, rowid AS ordinal FROM observation_events ORDER BY created_at DESC, rowid DESC LIMIT 1").get()) as { cursor: string; changed_at: number; ordinal: number } | null;
    if (!event) return update?.cursor ?? "0";
    if (!update || event.changed_at >= update.changed_at) return event.cursor;
    return update.cursor;
  }

  update(id: string): AcceptedUpdate | null {
    return this.acceptedStore.get(id);
  }

  /** Internal operational history; deliberately not exposed by the wire host. */
  acceptedUpdates(treeID: string): AcceptedUpdate[] {
    return this.acceptedStore.list(treeID);
  }

  matchingRequestDigest(updateID: string, credentialSubject?: string): ObjectHash | null {
    return credentialSubject ? this.acceptedStore.matchingRequestDigest(updateID, credentialSubject) : null;
  }

  acceptedTransition(updateID: string, credentialSubject?: string): AcceptedTransition | null {
    const update = this.update(updateID);
    let payload: AcceptedTransitionPayload | null;
    try { payload = this.acceptedStore.transition(updateID); }
    catch { return null; }
    if (!update || !payload) return null;
    const requestDigest = credentialSubject && update.subject === credentialSubject
      ? this.matchingRequestDigest(updateID, credentialSubject)
      : null;
    return { update, ...payload, ...(requestDigest ? { requestDigest } : {}) };
  }

  /** Complete graph for one retained update. Wire hosts expose it only as an
   * opt-in response to the exact update request, never as history browsing. */
  async snapshotForUpdate(treeID: string, updateID: string): Promise<TreeSnapshot> {
    const update = this.update(updateID);
    if (!update || update.tree !== treeID) throw new Error("Accepted update is not retained for this tree");
    return this.completeSnapshot(update.root);
  }

  boundary(path: string): CanopyTree | null {
    return this.treeSelect("WHERE b.path = ?", normalizeBoundaryPath(path));
  }

  resolve(path: string): { tree: CanopyTree; path: string } | null {
    const canonical = normalizeBoundaryPath(path);
    const candidates = this.list()
      .filter((tree) => tree.canonicalPath !== null && sameOrDescendant(canonical, tree.canonicalPath))
      .sort((a, b) => b.canonicalPath!.length - a.canonicalPath!.length);
    const tree = candidates[0];
    if (!tree) return null;
    const remainder = canonical === tree.canonicalPath
      ? "/"
      : canonical.slice(tree.canonicalPath === "/" ? 0 : tree.canonicalPath!.length);
    return { tree, path: remainder || "/" };
  }

  account(id: string): CanopyAccount | null {
    const row = this.db.query("SELECT * FROM accounts WHERE id = ?").get(id) as
      | { id: string; handle: string; profile_tree: string | null; config_tree: string | null; enabled: number }
      | null;
    return row
      ? { id: row.id, handle: row.handle, profileTree: row.profile_tree, configTree: row.config_tree, enabled: row.enabled === 1 }
      : null;
  }

  authenticateToken(token: string | undefined): CanopyAuthentication | null {
    if (!token) return null;
    const digest = sha256(token);
    const device = this.db.query(`
      SELECT d.id AS device_id, d.account_id
      FROM devices d JOIN accounts a ON a.id = d.account_id
      WHERE d.token_digest = ? AND d.revoked_at IS NULL AND a.enabled = 1
    `).get(digest) as { device_id: string; account_id: string } | null;
    if (device) {
      this.db.run("UPDATE devices SET last_used_at = ? WHERE id = ?", [Date.now(), device.device_id]);
      return { account: this.account(device.account_id)!, subject: `device:${device.device_id}`, device: device.device_id };
    }
    return null;
  }

  accountByToken(token: string | undefined): CanopyAccount | null {
    return this.authenticateToken(token)?.account ?? null;
  }

  private deviceRow(value: unknown): ServerDevice | null {
    if (!value) return null;
    const row = value as {
      id: string;
      account_id: string;
      label: string;
      created_at: number;
      last_used_at: number | null;
      revoked_at: number | null;
    };
    return {
      id: row.id,
      account: row.account_id,
      label: row.label,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    };
  }

  devices(account: CanopyAccount): ServerDevice[] {
    return this.db.query("SELECT * FROM devices WHERE account_id = ? ORDER BY created_at, id")
      .all(account.id).map((row) => this.deviceRow(row)!);
  }

  createPairing(account: CanopyAccount): PairingOffer {
    const id = opaqueID("pa");
    const secret = `arp_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const confirmationCode = String(Number.parseInt(sha256(secret).slice(0, 12), 16) % 1_000_000).padStart(6, "0");
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000;
    this.db.run(`
      INSERT INTO pairings (id, account_id, secret_digest, confirmation_code, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, account.id, sha256(secret), confirmationCode, now, expiresAt]);
    return { id, secret, confirmationCode, expiresAt };
  }

  async claimPairing(input: {
    id: string;
    secret: string;
    deviceID: string;
    credentialDigest: string;
    label: string;
    placements: Record<string, { server: string; path?: string }>;
  }): Promise<{ device: ServerDevice; confirmationCode: string }> {
    const { id, secret, label } = input;
    const safeLabel = label.trim();
    if (!safeLabel || safeLabel.length > 100) throw new Error("Device label is required and must be at most 100 characters");
    if (!isGeneratedArborID(input.deviceID, "dv")) throw new Error("Pairing requires a client-generated 128-bit DeviceID");
    if (!/^sha256:[a-f0-9]{64}$/.test(input.credentialDigest)) throw new Error("Device credential digest is invalid");
    if (this.db.query("SELECT 1 FROM devices WHERE id = ?").get(input.deviceID)) {
      throw new Error(`Retired DeviceID cannot be reused: ${input.deviceID}`);
    }
    const tokenDigest = input.credentialDigest.slice("sha256:".length);
    const pairing = this.db.query(`
      SELECT p.*, a.enabled AS account_enabled
      FROM pairings p JOIN accounts a ON a.id = p.account_id
      WHERE p.id = ?
    `).get(id) as {
      account_id: string;
      secret_digest: string;
      confirmation_code: string;
      expires_at: number;
      claimed_at: number | null;
      claimed_device: string | null;
      account_enabled: number;
    } | null;
    const presentedDigest = Buffer.from(sha256(secret));
    const expectedDigest = pairing ? Buffer.from(pairing.secret_digest) : Buffer.alloc(presentedDigest.length);
    const secretMatches = presentedDigest.length === expectedDigest.length && timingSafeEqual(presentedDigest, expectedDigest);
    if (pairing?.claimed_at && pairing.claimed_device === input.deviceID) {
      const replay = this.db.query("SELECT token_digest, label FROM devices WHERE id = ? AND account_id = ?").get(input.deviceID, pairing.account_id) as { token_digest: string; label: string } | null;
      if (replay?.token_digest === tokenDigest && replay.label === safeLabel && secretMatches) {
        return { device: this.deviceRow(this.db.query("SELECT * FROM devices WHERE id = ?").get(input.deviceID))!, confirmationCode: pairing.confirmation_code };
      }
    }
    if (!pairing || pairing.account_enabled !== 1 || pairing.claimed_at || pairing.expires_at <= Date.now() || !secretMatches) {
      throw new Error("Pairing is invalid, expired, or already used");
    }
    const account = this.account(pairing.account_id)!;
    const current = await this.accountConfigGraph(account);
    if (current.devices[input.deviceID]) throw new Error("DeviceID is already active");
    const next = {
      account: current.account,
      trees: current.trees,
      devices: {
        ...current.devices,
        [input.deviceID]: { version: 1 as const, id: input.deviceID, label: safeLabel, placements: input.placements },
      },
    };
    const nextSnapshot = snapshotAccountConfig(next);
    readAccountConfigGraph(nextSnapshot, account.configTree!);
    await this.storeObjects([...nextSnapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
    const configTree = this.get(account.configTree!)!;
    const transition = await this.acceptedTransitionPayload(configTree.ref, nextSnapshot.root);
    const now = Date.now();
    const accepted = this.acceptedStore.commit(generateArborID("up"), {
      tree: configTree.id,
      root: nextSnapshot.root,
      previousRoot: configTree.ref,
      expectedRoot: configTree.ref,
      kind: "accepted",
      acceptedAt: now,
      subject: `pairing:${id}`,
      baseRoot: configTree.ref,
      candidateRoot: nextSnapshot.root,
      remoteRoot: configTree.ref,
      transition,
    }, () => {
      const claimed = this.db.run("UPDATE pairings SET claimed_at = ?, claimed_device = ? WHERE id = ? AND claimed_at IS NULL AND expires_at > ?", [
        now,
        input.deviceID,
        id,
        now,
      ]);
      if (claimed.changes !== 1) throw new Error("Pairing is invalid, expired, or already used");
      this.db.run(
        "INSERT INTO devices (id, account_id, label, token_digest, created_at) VALUES (?, ?, ?, ?, ?)",
        [input.deviceID, pairing.account_id, safeLabel, tokenDigest, now],
      );
    });
    if (!accepted) throw new RefConflictError(this.get(configTree.id)?.ref ?? null);
    const updated = this.get(configTree.id)!;
    for (const listener of this.listeners.get(configTree.id) ?? []) listener(updated, accepted);
    return {
      device: this.deviceRow(this.db.query("SELECT * FROM devices WHERE id = ?").get(input.deviceID))!,
      confirmationCode: pairing.confirmation_code,
    };
  }

  revokeDevice(account: CanopyAccount, deviceID: string): ServerDevice {
    const active = this.devices(account).filter((device) => device.revokedAt === null);
    if (active.length <= 1 && active.some((device) => device.id === deviceID)) {
      throw new Error("The only active device cannot be revoked");
    }
    const result = this.db.run(
      "UPDATE devices SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
      [Date.now(), deviceID, account.id],
    );
    if (result.changes !== 1) throw new Error("Active device not found");
    return this.deviceRow(this.db.query("SELECT * FROM devices WHERE id = ?").get(deviceID))!;
  }

  accountByHandle(handle: string): CanopyAccount | null {
    const row = this.db.query("SELECT id FROM accounts WHERE handle = ?").get(handle) as { id: string } | null;
    return row ? this.account(row.id) : null;
  }

  resetAccountToken(handle: string, token: string): CanopyAccount {
    if (!/^arb_[a-f0-9]{64}$/.test(token)) {
      throw new Error("A replacement account token must be arb_ followed by 64 lowercase hexadecimal characters");
    }
    const account = this.accountByHandle(handle);
    if (!account) throw new Error(`Unknown account: ~${handle}`);
    const digest = sha256(token);
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run("UPDATE accounts SET token_digest = ? WHERE id = ?", [digest, account.id]);
      this.db.run("UPDATE devices SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL", [now, account.id]);
      this.db.run(
        "INSERT INTO devices (id, account_id, label, token_digest, created_at) VALUES (?, ?, 'Recovered device', ?, ?)",
        [opaqueID("dv"), account.id, digest, now],
      );
    })();
    return this.account(account.id)!;
  }

  community(): CanopyTree {
    const community = this.boundary("/");
    if (!community) throw new Error("Community profile is missing");
    return community;
  }

  communityHandle(): string {
    const row = this.db.query("SELECT value FROM meta WHERE key = 'community_handle'").get() as { value: string } | null;
    return row?.value ?? "community";
  }

  isReservedHandle(handle: string): boolean {
    return HANDLE.test(handle)
      && !this.boundary(`/~${handle}`)
      && !this.accountByHandle(handle)
      && this.communityMemberHandles().has(handle);
  }

  setCommunityHost(host: string, allowTestPortChange = false): void {
    const normalized = host.toLowerCase();
    const existing = this.db.query("SELECT value FROM meta WHERE key = 'community_host'")
      .get() as { value: string } | null;
    if (existing && existing.value !== normalized && !allowTestPortChange) {
      throw new Error(`Community canonical host is ${existing.value}, not ${normalized}`);
    }
    this.db.run(
      "INSERT INTO meta (key, value) VALUES ('community_host', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [normalized],
    );
  }

  writableProfiles(account: CanopyAccount): CanopyTree[] {
    return this.list().filter((tree) =>
      ["community-profile", "person-profile", "group-profile"].includes(tree.kind)
      && this.canWrite(account, tree.id)
    );
  }

  async ensureAccountConfigTrees(origin: string): Promise<void> {
    const accounts = this.db.query("SELECT id FROM accounts WHERE config_tree IS NULL ORDER BY id").all() as Array<{ id: string }>;
    for (const { id } of accounts) {
      const account = this.account(id)!;
      if (!account.profileTree) continue;
      const devices = Object.fromEntries(this.devices(account)
        .filter((device) => device.revokedAt === null)
        .map((device) => [device.id, { version: 1 as const, id: device.id, label: device.label, placements: {} }]));
      const active = Object.keys(devices);
      if (!active.length) throw new Error(`Account ${id} has no active device to administer its configuration`);
      const declarations = Object.fromEntries(this.list()
        .filter((tree) => tree.canonicalPath && tree.policy === "ordinary" && this.canAdminister(account, tree.id))
        .map((tree) => [tree.id, {
          kind: tree.kind as Exclude<TreeKind, "account-configuration">,
          canonicalPath: tree.canonicalPath!,
          access: this.accessEntries(tree.id).map((entry): AccessRule => ({
            subject: entry.subjectKind === "everyone"
              ? { kind: "everyone" }
              : entry.subjectKind === "profile"
                ? { kind: "profile", tree: entry.subject }
                : { kind: "link", digest: entry.subject as `sha256:${string}` },
            access: entry.access,
          })),
        }]));
      if (!declarations[account.profileTree]) {
        const profile = this.get(account.profileTree)!;
        declarations[profile.id] = {
          kind: "person-profile",
          canonicalPath: profile.canonicalPath!,
          access: this.accessEntries(profile.id).map((entry): AccessRule => ({
            subject: entry.subjectKind === "everyone" ? { kind: "everyone" }
              : entry.subjectKind === "profile" ? { kind: "profile", tree: entry.subject }
                : { kind: "link", digest: entry.subject as `sha256:${string}` },
            access: entry.access,
          })),
        };
      }
      const graph = {
        account: { version: 1 as const, community: new URL(origin).origin, profile: { tree: account.profileTree, handle: account.handle }, admins: active },
        trees: { version: 1 as const, trees: declarations },
        devices,
      };
      const snapshot = snapshotAccountConfig(graph);
      const configID = generateArborID("tr");
      await this.validateGraph(snapshot.root, snapshot.objects);
      await this.storeObjects([...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
      const now = Date.now();
      this.db.transaction(() => {
        this.db.run(
          "INSERT INTO trees (id, ref, updated_at, policy, status, account_id) VALUES (?, ?, ?, 'account-config-v1', 'active', ?)",
          [configID, snapshot.root, now, account.id],
        );
        this.db.run("INSERT INTO reflog (tree_id, ref, previous_ref, changed_at) VALUES (?, ?, NULL, ?)", [configID, snapshot.root, now]);
        this.insertAcceptedUpdate({ tree: configID, root: snapshot.root, previousRoot: null, kind: "initial", acceptedAt: now });
        this.db.run("UPDATE accounts SET config_tree = ? WHERE id = ? AND config_tree IS NULL", [configID, account.id]);
      })();
    }
  }

  private applyAccountConfigDerived(accountID: string, current: AccountConfigGraph, next: AccountConfigGraph): void {
    const now = Date.now();
    for (const id of Object.keys(current.devices)) {
      if (!next.devices[id]) this.db.run("UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND account_id = ?", [now, id, accountID]);
    }
    for (const id of Object.keys(next.devices)) {
      const row = this.db.query("SELECT revoked_at FROM devices WHERE id = ? AND account_id = ?").get(id, accountID) as { revoked_at: number | null } | null;
      if (!row) throw new Error(`Device ${id} has no credential binding`);
      if (row.revoked_at !== null) throw new Error(`Retired DeviceID cannot be reactivated: ${id}`);
    }
    for (const [id, before] of Object.entries(current.trees.trees)) {
      if (!next.trees.trees[id]) {
        const reservation = this.db.query("SELECT status FROM tree_reservations WHERE id = ? AND account_id = ?").get(id, accountID) as { status: string } | null;
        if (reservation?.status === "awaiting-initialization") this.db.run("DELETE FROM tree_reservations WHERE id = ?", [id]);
        else throw new Error(`Active remote tree declarations cannot be removed: ${id}`);
      }
      if (next.trees.trees[id] && before.kind !== next.trees.trees[id]!.kind) throw new Error(`Tree kind is immutable after activation: ${id}`);
    }
    for (const [id, declaration] of Object.entries(next.trees.trees)) {
      const active = this.get(id);
      if (!active) {
        this.db.run(`INSERT INTO tree_reservations (id, account_id, kind, canonical_path, status, error)
          VALUES (?, ?, ?, ?, 'awaiting-initialization', NULL)
          ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, canonical_path = excluded.canonical_path`,
        [id, accountID, declaration.kind, declaration.canonicalPath]);
        continue;
      }
      if (active.policy !== "ordinary") throw new Error(`Configuration may not declare governed tree ${id}`);
      const boundary = this.boundary(declaration.canonicalPath);
      if (boundary && boundary.id !== id) throw new Error(`Canonical boundary is occupied: ${declaration.canonicalPath}`);
      const parent = this.resolve(dirnameURL(declaration.canonicalPath))?.tree;
      this.db.run("UPDATE boundaries SET path = ?, parent_tree = ?, kind = ? WHERE tree_id = ?", [
        declaration.canonicalPath, parent?.id ?? null, declaration.kind, id,
      ]);
      this.db.run("DELETE FROM access WHERE tree_id = ?", [id]);
      for (const rule of declaration.access) {
        const subject = rule.subject.kind === "everyone" ? "everyone" : rule.subject.kind === "profile" ? rule.subject.tree : rule.subject.digest;
        this.setAccessInternal(id, rule.subject.kind, subject, rule.access);
      }
    }
  }

  private async accountConfigGraph(account: CanopyAccount): Promise<AccountConfigGraph> {
    if (!account.configTree) throw new Error("Account configuration tree is missing");
    const tree = this.get(account.configTree);
    if (!tree) throw new Error("Account configuration tree is missing");
    return readAccountConfigGraph(await this.completeSnapshot(tree.ref), tree.id);
  }

  async activateTree(
    authentication: CanopyAuthentication,
    treeID: string,
    snapshot: TreeSnapshot,
  ): Promise<CanopyTree> {
    if (!isGeneratedArborID(treeID, "tr")) throw new Error("New tree activation requires a 128-bit client-generated TreeID");
    const existing = this.get(treeID);
    if (existing) {
      if (existing.ref === snapshot.root) return existing;
      throw new TreeIDConflictError(treeID);
    }
    const reservation = this.db.query("SELECT * FROM tree_reservations WHERE id = ?").get(treeID) as {
      account_id: string; kind: Exclude<TreeKind, "account-configuration">; canonical_path: string; status: string;
    } | null;
    if (!reservation || reservation.account_id !== authentication.account.id || reservation.status !== "awaiting-initialization") {
      throw new Error(`TreeID is not reserved for activation: ${treeID}`);
    }
    if (!authentication.device) throw new Error("An administrator device is required for activation");
    const config = await this.accountConfigGraph(authentication.account);
    if (!config.account.admins.includes(authentication.device)) throw new Error("Only an administrator device may initialize a tree");
    if (!config.devices[authentication.device]?.placements[treeID]) throw new Error("The initializing administrator must place the tree");
    const declaration = config.trees.trees[treeID];
    if (!declaration) throw new Error("Tree declaration disappeared before activation");
    if (declaration.kind === "person-profile") await this.validateProfileSnapshot(snapshot, "person");
    if (declaration.kind === "group-profile" || declaration.kind === "community-profile") await this.validateProfileSnapshot(snapshot, "group");
    const parent = this.resolve(dirnameURL(declaration.canonicalPath))?.tree;
    if (!parent) throw new Error("Canonical parent is unavailable");
    let statusEvent: { cursor: string; tree: string; kind: string; change: unknown } | undefined;
    const activated = await this.insertTree(
      declaration.canonicalPath,
      declaration.kind,
      snapshot,
      "none",
      parent.id,
      (id) => {
        for (const rule of declaration.access) {
          const subject = rule.subject.kind === "everyone" ? "everyone" : rule.subject.kind === "profile" ? rule.subject.tree : rule.subject.digest;
          this.setAccessInternal(id, rule.subject.kind, subject, rule.access);
        }
        this.db.run("DELETE FROM tree_reservations WHERE id = ? AND account_id = ?", [id, authentication.account.id]);
        if (authentication.account.configTree) {
          statusEvent = this.recordObservation(authentication.account.configTree, "tree.activation", { tree: treeID, status: "active" });
        }
      },
      authentication.subject,
      treeID,
      authentication.account.id,
    );
    if (statusEvent) this.notifyObservation(statusEvent);
    return activated;
  }

  accessEntries(tree: string): CanopyAccessEntry[] {
    return this.db.query("SELECT * FROM access WHERE tree_id = ? ORDER BY subject_kind, subject")
      .all(tree)
      .map((row) => {
        const value = row as {
          id: string;
          tree_id: string;
          subject_kind: CanopyAccessEntry["subjectKind"];
          subject: string;
          access: TreeAccess;
          claimed_profile: string | null;
        };
        return {
          id: value.id,
          tree: value.tree_id,
          subjectKind: value.subject_kind,
          subject: value.subject,
          access: value.access,
          ...(value.claimed_profile ? { claimedProfile: value.claimed_profile } : {}),
        };
      });
  }

  setAccess(
    account: CanopyAccount,
    treeID: string,
    subjectKind: CanopyAccessEntry["subjectKind"],
    subject: string,
    access: TreeAccess | "none",
  ): CanopyTree {
    if (!this.canAdminister(account, treeID)) throw new Error("Access administration is not allowed");
    if (subjectKind === "everyone") {
      if (subject !== "everyone") throw new Error("Invalid everyone subject");
    } else if (subjectKind === "profile") {
      const profile = this.get(subject);
      if (!profile || !["person-profile", "group-profile"].includes(profile.kind)) {
        throw new Error("Access subject must be a profile tree");
      }
    } else if (subjectKind === "link" && !/^sha256:[a-f0-9]{64}$/.test(subject)) {
      throw new Error("Link subject must be a secret digest");
    }
    if (access === "none") {
      this.db.run(
        "DELETE FROM access WHERE tree_id = ? AND subject_kind = ? AND subject = ?",
        [treeID, subjectKind, subject],
      );
    } else {
      this.setAccessInternal(treeID, subjectKind, subject, access);
    }
    return this.get(treeID)!;
  }

  removeAccess(account: CanopyAccount, treeID: string, accessID: string): CanopyTree {
    if (!this.canAdminister(account, treeID)) throw new Error("Access administration is not allowed");
    const result = this.db.run("DELETE FROM access WHERE id = ? AND tree_id = ?", [accessID, treeID]);
    if (result.changes !== 1) throw new Error("Unknown access entry");
    return this.get(treeID)!;
  }

  clearAccess(account: CanopyAccount, treeID: string): CanopyTree {
    if (!this.canAdminister(account, treeID)) throw new Error("Access administration is not allowed");
    this.db.run(
      "DELETE FROM access WHERE tree_id = ? AND NOT (subject_kind = 'profile' AND subject = ?)",
      [treeID, account.profileTree],
    );
    return this.get(treeID)!;
  }

  private setAccessInternal(
    treeID: string,
    subjectKind: CanopyAccessEntry["subjectKind"],
    subject: string,
    access: TreeAccess,
  ): void {
    const existing = this.db.query(
      "SELECT id FROM access WHERE tree_id = ? AND subject_kind = ? AND subject = ?",
    ).get(treeID, subjectKind, subject) as { id: string } | null;
    if (existing) {
      this.db.run("UPDATE access SET access = ? WHERE id = ?", [access, existing.id]);
    } else {
      this.db.run(
        "INSERT INTO access (id, tree_id, subject_kind, subject, access) VALUES (?, ?, ?, ?, ?)",
        [opaqueID("ax"), treeID, subjectKind, subject, access],
      );
    }
  }

  canRead(account: CanopyAccount | null, treeID: string, linkDigest?: string): boolean {
    const tree = this.get(treeID);
    if (!tree) return false;
    if (tree.policy === "account-config-v1") return account?.id === tree.accountID;
    if (account && tree.accountID === account.id) return true;
    if (tree.publicAccess === "read" || tree.publicAccess === "write") return true;
    if (linkDigest && this.linkAccess(linkDigest, treeID) !== "none") return true;
    return account ? this.effectiveAccess(account, treeID) !== "none" : false;
  }

  canWrite(account: CanopyAccount | null, treeID: string, linkDigest?: string): boolean {
    const tree = this.get(treeID);
    if (!tree) return false;
    if (tree.policy === "account-config-v1") return account?.id === tree.accountID;
    if (account && tree.accountID === account.id) return true;
    if (linkDigest && this.linkAccess(linkDigest, treeID) === "write") return true;
    if (!account) return tree.publicAccess === "write";
    return this.effectiveAccess(account, treeID) === "write" || tree.publicAccess === "write";
  }

  private linkAccess(digest: string, treeID: string): TreeAccess | "none" {
    const row = this.db.query(
      "SELECT access FROM access WHERE tree_id = ? AND subject_kind = 'link' AND subject = ?",
    ).get(treeID, digest) as { access: TreeAccess } | null;
    return row?.access ?? "none";
  }

  canAdminister(account: CanopyAccount, treeID: string): boolean {
    const tree = this.get(treeID);
    if (!tree || !account.profileTree) return false;
    if (tree.policy === "account-config-v1") return tree.accountID === account.id;
    if (tree.accountID === account.id) return true;
    if (tree.kind === "person-profile" && tree.id === account.profileTree) return true;
    return this.directAccess(account.profileTree, treeID) === "write";
  }

  private directAccess(profileTree: string, treeID: string): TreeAccess | "none" {
    const row = this.db.query(
      "SELECT access FROM access WHERE tree_id = ? AND subject_kind = 'profile' AND subject = ?",
    ).get(treeID, profileTree) as { access: TreeAccess } | null;
    return row?.access ?? "none";
  }

  private effectiveAccess(account: CanopyAccount, treeID: string): TreeAccess | "none" {
    if (!account.profileTree) return "none";
    const direct = this.directAccess(account.profileTree, treeID);
    if (direct !== "none") return direct;
    let result: TreeAccess | "none" = "none";
    for (const entry of this.accessEntries(treeID)) {
      if (entry.subjectKind !== "profile") continue;
      const subject = this.get(entry.subject);
      if (subject?.kind !== "group-profile") continue;
      if (this.profileMemberHandles(subject.id).has(account.handle)) {
        if (entry.access === "write") return "write";
        result = "read";
      }
    }
    return result;
  }

  async create(
    account: CanopyAccount,
    canonicalPath: string,
    kind: Exclude<BoundaryKind, "community-profile">,
    snapshot: TreeSnapshot,
    publicAccess: PublicAccess = "none",
    profileAccess: Array<{ profile: string; access: TreeAccess }> = [],
    credentialSubject?: string,
  ): Promise<CanopyTree> {
    const path = normalizeBoundaryPath(canonicalPath);
    if (this.boundary(path)) throw new Error(`Canonical boundary already exists: ${path}`);
    if (this.list().some((boundary) => boundary.canonicalPath?.startsWith(`${path}/`))) {
      throw new Error(`Canonical boundary would shadow an existing tree: ${path}`);
    }
    const parent = this.resolve(dirnameURL(path))?.tree;
    if (!parent || !this.canAdminister(account, parent.id)) {
      throw new Error(`Cannot publish beneath ${parent?.canonicalPath ?? "/"}`);
    }
    if (kind === "person-profile") throw new Error("Person profiles are created only through claim");
    const initialProfiles = new Set<string>();
    for (const rule of profileAccess) {
      const profile = this.get(rule.profile);
      if (!profile || !["person-profile", "group-profile"].includes(profile.kind)) {
        throw new Error("Access subject must be a profile tree");
      }
      if (initialProfiles.has(rule.profile)) throw new Error("Duplicate profile access rule");
      initialProfiles.add(rule.profile);
    }
    if (kind === "group-profile") {
      if (parent.kind !== "community-profile" || profileHandle(path) === null) {
        throw new Error("Group profiles must use an available /~handle path");
      }
      await this.validateProfileSnapshot(snapshot, "group");
    } else {
      let ancestor: CanopyTree | null = parent;
      while (ancestor && ancestor.kind === "shared-subtree") {
        ancestor = ancestor.parentTree ? this.get(ancestor.parentTree) : null;
      }
      if (
        !ancestor
        || !["person-profile", "group-profile"].includes(ancestor.kind)
        || !ancestor.canonicalPath
        || !sameOrDescendant(path, ancestor.canonicalPath)
      ) {
        throw new Error("Shared subtree must be mounted beneath an administered profile");
      }
    }
    return this.insertTree(
      path,
      kind,
      snapshot,
      publicAccess,
      parent.id,
      (treeID) => {
        if (account.profileTree) this.setAccessInternal(treeID, "profile", account.profileTree, "write");
        for (const rule of profileAccess) this.setAccessInternal(treeID, "profile", rule.profile, rule.access);
      },
      credentialSubject,
      undefined,
      account.id,
    );
  }

  async claim(handle: string, snapshot: TreeSnapshot): Promise<{ account: CanopyAccount; token: string; tree: CanopyTree }> {
    if (!HANDLE.test(handle)) throw new Error(`Invalid profile handle: ${handle}`);
    if (this.accountByHandle(handle) || this.boundary(`/~${handle}`)) throw new AlreadyClaimedError(handle);
    if (!this.communityMemberHandles().has(handle)) throw new Error(`Profile is not reserved by the community: ~${handle}`);
    await this.validateProfileSnapshot(snapshot, "person");
    const token = `arb_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const accountID = opaqueID("ac");
    const deviceID = opaqueID("dv");
    const parent = this.community();
    let tree: CanopyTree;
    try {
      tree = await this.insertTree(
        `/~${handle}`,
        "person-profile",
        snapshot,
        "read",
        parent.id,
        (treeID) => {
          this.db.run(
            "INSERT INTO accounts (id, handle, profile_tree, token_digest, enabled) VALUES (?, ?, ?, ?, 1)",
            [accountID, handle, treeID, sha256(token)],
          );
          this.db.run(
            "INSERT INTO devices (id, account_id, label, token_digest, created_at) VALUES (?, ?, 'Initial device', ?, ?)",
            [deviceID, accountID, sha256(token), Date.now()],
          );
          this.setAccessInternal(treeID, "profile", treeID, "write");
          const firstWriter = this.db.query("SELECT value FROM meta WHERE key = 'first_writer_handle'")
            .get() as { value: string } | null;
          if (firstWriter?.value === handle) {
            this.setAccessInternal(parent.id, "profile", treeID, "write");
            this.db.run("DELETE FROM meta WHERE key = 'first_writer_handle'");
          }
        },
        `device:${deviceID}`,
      );
    } catch (error) {
      if (this.accountByHandle(handle) || this.boundary(`/~${handle}`)) throw new AlreadyClaimedError(handle);
      throw error;
    }
    return { account: this.account(accountID)!, token, tree };
  }

  async claimWithConfiguration(input: {
    handle: string;
    origin: string;
    profileTree: string;
    configurationTree: string;
    deviceID: string;
    deviceLabel: string;
    credentialDigest: string;
    profileSnapshot: TreeSnapshot;
    configurationSnapshot: TreeSnapshot;
  }): Promise<{ account: CanopyAccount; tree: CanopyTree; configuration: CanopyTree }> {
    const { handle } = input;
    const claimDigest = sha256(canonicalJSONString({
      handle,
      profileTree: input.profileTree,
      configurationTree: input.configurationTree,
      deviceID: input.deviceID,
      deviceLabel: input.deviceLabel,
      credentialDigest: input.credentialDigest,
      profileRoot: input.profileSnapshot.root,
      configurationRoot: input.configurationSnapshot.root,
    }));
    if (!HANDLE.test(handle)) throw new Error(`Invalid profile handle: ${handle}`);
    if (!isGeneratedArborID(input.profileTree, "tr") || !isGeneratedArborID(input.configurationTree, "tr")) {
      throw new Error("Claim requires client-generated 128-bit profile and configuration TreeIDs");
    }
    if (!isGeneratedArborID(input.deviceID, "dv")) throw new Error("Claim requires a client-generated 128-bit DeviceID");
    if (!/^sha256:[a-f0-9]{64}$/.test(input.credentialDigest)) throw new Error("Device credential digest is invalid");
    const tokenDigest = input.credentialDigest.slice("sha256:".length);
    const prior = this.accountByHandle(handle);
    if (prior) {
      const row = this.db.query("SELECT claim_digest FROM accounts WHERE id = ?").get(prior.id) as { claim_digest: string | null };
      if (row.claim_digest === claimDigest) {
        return { account: prior, tree: this.get(input.profileTree)!, configuration: this.get(input.configurationTree)! };
      }
      throw new AlreadyClaimedError(handle);
    }
    if (this.boundary(`/~${handle}`)) throw new AlreadyClaimedError(handle);
    if (!this.communityMemberHandles().has(handle)) throw new Error(`Profile is not reserved by the community: ~${handle}`);
    await this.validateProfileSnapshot(input.profileSnapshot, "person");
    await this.validateGraph(input.configurationSnapshot.root, input.configurationSnapshot.objects);
    const config = readAccountConfigGraph(input.configurationSnapshot, input.configurationTree);
    if (config.account.community !== new URL(input.origin).origin) throw new Error("account.yaml community does not match the claim server");
    if (config.account.profile.tree !== input.profileTree || config.account.profile.handle !== handle) throw new Error("account.yaml profile does not match the claim");
    if (Object.keys(config.devices).length !== 1 || !config.devices[input.deviceID] || config.devices[input.deviceID]!.label !== input.deviceLabel) {
      throw new Error("Initial configuration must contain exactly the claiming device and matching label");
    }
    if (config.account.admins.length !== 1 || config.account.admins[0] !== input.deviceID) {
      throw new Error("The claiming device must be the first administrator");
    }
    await this.storeObjects([...input.configurationSnapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
    const accountID = generateArborID("ac");
    const parent = this.community();
    const tree = await this.insertTree(
      `/~${handle}`,
      "person-profile",
      input.profileSnapshot,
      "none",
      parent.id,
      (profileID) => {
        const now = Date.now();
        this.db.run(
          "INSERT INTO accounts (id, handle, profile_tree, config_tree, token_digest, claim_digest, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)",
          [accountID, handle, profileID, input.configurationTree, tokenDigest, claimDigest],
        );
        this.db.run(
          "INSERT INTO devices (id, account_id, label, token_digest, created_at) VALUES (?, ?, ?, ?, ?)",
          [input.deviceID, accountID, input.deviceLabel, tokenDigest, now],
        );
        this.db.run(
          "INSERT INTO trees (id, ref, updated_at, policy, status, account_id) VALUES (?, ?, ?, 'account-config-v1', 'active', ?)",
          [input.configurationTree, input.configurationSnapshot.root, now, accountID],
        );
        this.db.run("INSERT INTO reflog (tree_id, ref, previous_ref, changed_at) VALUES (?, ?, NULL, ?)", [
          input.configurationTree, input.configurationSnapshot.root, now,
        ]);
        this.insertAcceptedUpdate({
          tree: input.configurationTree,
          root: input.configurationSnapshot.root,
          previousRoot: null,
          kind: "initial",
          acceptedAt: now,
          subject: `device:${input.deviceID}`,
        });
        const declaration = config.trees.trees[profileID]!;
        for (const rule of declaration.access) {
          const subject = rule.subject.kind === "everyone" ? "everyone" : rule.subject.kind === "profile" ? rule.subject.tree : rule.subject.digest;
          this.setAccessInternal(profileID, rule.subject.kind, subject, rule.access);
        }
        for (const [id, pending] of Object.entries(config.trees.trees)) {
          if (id === profileID) continue;
          this.db.run(
            "INSERT INTO tree_reservations (id, account_id, kind, canonical_path, status) VALUES (?, ?, ?, ?, 'awaiting-initialization')",
            [id, accountID, pending.kind, pending.canonicalPath],
          );
        }
        const firstWriter = this.db.query("SELECT value FROM meta WHERE key = 'first_writer_handle'").get() as { value: string } | null;
        if (firstWriter?.value === handle) {
          this.setAccessInternal(parent.id, "profile", profileID, "write");
          this.db.run("DELETE FROM meta WHERE key = 'first_writer_handle'");
        }
      },
      `device:${input.deviceID}`,
      input.profileTree,
      accountID,
    );
    return { account: this.account(accountID)!, tree, configuration: this.get(input.configurationTree)! };
  }

  private insertAcceptedUpdate(input: AcceptedUpdateInput): AcceptedUpdate {
    return this.acceptedStore.insert(opaqueID("up"), input);
  }

  private acceptedTransitionPayload(previousRoot: ObjectHash, root: ObjectHash): Promise<AcceptedTransitionPayload> {
    return buildAcceptedTransitionPayload(previousRoot, root, (hash) => this.object(hash));
  }

  private acceptedRequest(tree: string, subject: string, digest: string): StoredUpdateResponse | null {
    return this.acceptedStore.acceptedRequest(tree, subject, digest);
  }

  async submitUpdate(
    treeID: string,
    request: UpdateRequest,
    account: CanopyAccount | null = null,
    linkDigest?: string,
    credentialSubject?: string,
  ): Promise<StoredUpdateResponse> {
    const previous = this.updateLocks.get(treeID) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => turn);
    this.updateLocks.set(treeID, queued);
    await previous;
    try {
      return await this.submitUpdateLocked(
        treeID,
        request,
        account,
        linkDigest,
        credentialSubject,
      );
    } finally {
      release();
      if (this.updateLocks.get(treeID) === queued) this.updateLocks.delete(treeID);
    }
  }

  private async submitUpdateLocked(
    treeID: string,
    request: UpdateRequest,
    account: CanopyAccount | null = null,
    linkDigest?: string,
    credentialSubject?: string,
  ): Promise<StoredUpdateResponse> {
    const tree = this.get(treeID);
    if (!tree) throw new Error(`Unknown tree: ${treeID}`);
    if (!this.canWrite(account, treeID, linkDigest)) throw new Error("Write access is not allowed");
    if (tree.policy === "account-config-v1") {
      return this.submitAccountConfigUpdateLocked(tree, request, account, credentialSubject);
    }
    const subject = credentialSubject ?? (account ? `account:${account.id}` : linkDigest ? `link:${linkDigest}` : "public");
    const requestDigest = updateRequestDigest(treeID, request);
    const replay = this.acceptedRequest(treeID, subject, requestDigest);
    if (replay) return replay;
    const baseUpdate = this.update(request.base.update);
    if (!baseUpdate || baseUpdate.tree !== treeID || baseUpdate.root !== request.base.root) {
      throw new UpdateProtocolError("base-not-retained", "Base update is not retained for this tree and root");
    }
    const proposed = new Map(request.objects.map(({ hash, bytes }) => [hash, bytes]));
    const reconstructed = await this.reconstructFilePatches(request.base.root, request.filePatches ?? [], proposed);
    for (const object of reconstructed) {
      if (!await this.graphContainsProposed(request.candidate, object.hash, proposed)) {
        throw new Error(`File patch result is not reachable from candidate: ${object.hash}`);
      }
    }
    await this.validateGraph(request.candidate, proposed);
    await this.validateReservedBoundaries(tree, request.candidate, proposed);
    if (tree.kind === "person-profile") await this.validateProfileRoot(request.candidate, proposed, "person");
    if (tree.kind === "group-profile" || tree.kind === "community-profile") await this.validateProfileRoot(request.candidate, proposed, "group");
    for (let race = 0; race < 3; race++) {
      const remoteTree = this.get(treeID)!;
      const remoteUpdate = this.currentUpdate(treeID);
      if (!remoteUpdate || remoteUpdate.root !== remoteTree.ref) {
        throw new UpdateProtocolError("base-not-retained", "Current tree has not been migrated to accepted updates");
      }
      const reconciled = await reconcileUpdate(
        request.base.root,
        request.candidate,
        remoteTree.ref,
        (hash) => this.loadObject(hash, proposed),
      );
      if (reconciled.outcome === "current") {
        return { status: 200, result: { outcome: "current", current: remoteUpdate, requestDigest, observedThrough: remoteUpdate.id } };
      }

      const nextRoot = reconciled.root;
      const kind: AcceptedUpdate["kind"] = reconciled.outcome;
      const merge = reconciled.outcome === "merged" ? reconciled.merge : undefined;
      const generated = reconciled.generated;
      if (reconciled.outcome === "merged") {
        if (reconciled.conflicts.length) {
          const draft = await this.completeSnapshot(reconciled.root, new Map([...proposed, ...reconciled.generated]));
          const response: StoredUpdateResponse = {
            status: 409,
            result: {
              error: "conflict",
              message: "The candidate could not be merged safely",
              retryable: false,
              tree: treeID,
              details: {
                kind: "server-update",
                current: remoteUpdate,
                base: request.base.root,
                candidate: request.candidate,
                draft: { root: draft.root, objects: [...draft.objects].map(([hash, bytes]) => ({ hash, bytes })) },
                conflicts: reconciled.conflicts,
              },
            },
          };
          return response;
        }
        const mergedObjects = new Map([...proposed, ...generated]);
        await this.validateGraph(nextRoot, mergedObjects);
        await this.validateReservedBoundaries(remoteTree, nextRoot, mergedObjects);
      }
      await this.storeObjects(request.objects);
      await this.storeObjects(reconstructed);
      await this.storeObjects([...generated].map(([hash, bytes]) => ({ hash, bytes })));
      const transition = await this.acceptedTransitionPayload(remoteTree.ref, nextRoot);
      const now = Date.now();
      const accepted = this.acceptedStore.commit(opaqueID("up"), {
        tree: treeID,
        root: nextRoot,
        previousRoot: remoteTree.ref,
        expectedRoot: remoteTree.ref,
        kind,
        acceptedAt: now,
        subject,
        baseRoot: request.base.root,
        candidateRoot: request.candidate,
        remoteRoot: remoteTree.ref,
        ...(merge ? { merge } : {}),
        requestDigest,
        transition,
      });
      if (!accepted) continue;
      if (remoteTree.kind === "community-profile") this.reconcileCommunityAccounts();
      const updatedTree = this.get(treeID)!;
      for (const listener of this.listeners.get(treeID) ?? []) listener(updatedTree, accepted, requestDigest);
      return kind === "merged"
        ? { status: 201, result: { outcome: "merged", update: accepted, merge: merge!, requestDigest, observedThrough: accepted.id } }
        : { status: 201, result: { outcome: "accepted", update: accepted, requestDigest, observedThrough: accepted.id } };
    }
    throw new UpdateProtocolError("server-busy", "Server update changed repeatedly during merge");
  }

  private async submitAccountConfigUpdateLocked(
    tree: CanopyTree,
    request: UpdateRequest,
    account: CanopyAccount | null,
    credentialSubject?: string,
  ): Promise<StoredUpdateResponse> {
    if (!account || tree.accountID !== account.id || credentialSubject?.startsWith("device:") !== true) {
      throw new Error("An active account device is required for configuration updates");
    }
    const deviceID = credentialSubject.slice("device:".length);
    const subject = credentialSubject;
    const requestDigest = updateRequestDigest(tree.id, request);
    const replay = this.acceptedRequest(tree.id, subject, requestDigest);
    if (replay) return replay;
    const baseUpdate = this.update(request.base.update);
    if (!baseUpdate || baseUpdate.tree !== tree.id || baseUpdate.root !== request.base.root) {
      throw new UpdateProtocolError("base-not-retained", "Base update is not retained for this account configuration");
    }
    const proposed = new Map(request.objects.map(({ hash, bytes }) => [hash, bytes]));
    const reconstructed = await this.reconstructFilePatches(request.base.root, request.filePatches ?? [], proposed);
    await this.validateGraph(request.candidate, proposed);
    const candidateSnapshot = await this.completeSnapshot(request.candidate, proposed);
    const baseSnapshot = await this.completeSnapshot(request.base.root);
    const currentUpdate = this.currentUpdate(tree.id);
    if (!currentUpdate) throw new Error("Account configuration has no accepted update");
    const currentSnapshot = await this.completeSnapshot(currentUpdate.root);
    const baseGraph = readAccountConfigGraph(baseSnapshot, tree.id);
    const candidateGraph = readAccountConfigGraph(candidateSnapshot, tree.id);
    const currentGraph = readAccountConfigGraph(currentSnapshot, tree.id);
    authorizeAccountConfigTransition(currentGraph, candidateGraph, deviceID, baseGraph);

    let nextSnapshot = candidateSnapshot;
    let nextGraph = candidateGraph;
    let kind: AcceptedUpdate["kind"] = "accepted";
    let merge: MergeSummary | undefined;
    if (currentUpdate.root !== request.base.root) {
      const merged = mergeAccountConfigGraphs(baseGraph, candidateGraph, currentGraph);
      nextSnapshot = snapshotAccountConfig(merged.graph);
      nextGraph = readAccountConfigGraph(nextSnapshot, tree.id);
      if (merged.conflicts.length) {
        return {
          status: 409,
          result: {
            error: "conflict",
            message: "The account configuration contains incompatible same-field edits",
            retryable: false,
            tree: tree.id,
            details: {
              kind: "account-configuration",
              current: currentUpdate,
              base: request.base.root,
              candidate: request.candidate,
              draft: { root: nextSnapshot.root, objects: [...nextSnapshot.objects].map(([hash, bytes]) => ({ hash, bytes })) },
              conflicts: merged.conflicts.map((path) => ({ path, reason: "account-configuration" as const })),
            },
          },
        };
      }
      kind = "merged";
      merge = { version: "account-config-v1", mergedFields: 1 };
    }
    authorizeAccountConfigTransition(currentGraph, nextGraph, deviceID, currentGraph);
    if (nextSnapshot.root === currentUpdate.root) {
      return { status: 200, result: { outcome: "current", current: currentUpdate, requestDigest, observedThrough: currentUpdate.id } };
    }
    const boundaryRewrites = await this.prepareAccountBoundaryRewrites(currentGraph, nextGraph);
    await this.storeObjects(request.objects);
    await this.storeObjects(reconstructed);
    await this.storeObjects([...nextSnapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
    for (const rewrite of boundaryRewrites) {
      await this.cacheMembers(rewrite.nextRoot, rewrite.generated);
      await this.storeObjects([...rewrite.generated].map(([hash, bytes]) => ({ hash, bytes })));
    }
    const transition = await this.acceptedTransitionPayload(currentUpdate.root, nextSnapshot.root);
    const boundaryTransitions = new Map<string, AcceptedTransitionPayload>();
    for (const rewrite of boundaryRewrites) {
      boundaryTransitions.set(rewrite.parent.id, await this.acceptedTransitionPayload(rewrite.parent.ref, rewrite.nextRoot));
    }
    const now = Date.now();
    const boundaryUpdates: AcceptedUpdate[] = [];
    const accepted = this.acceptedStore.commit(generateArborID("up"), {
      tree: tree.id,
      root: nextSnapshot.root,
      previousRoot: currentUpdate.root,
      expectedRoot: currentUpdate.root,
      kind,
      acceptedAt: now,
      subject,
      baseRoot: request.base.root,
      candidateRoot: request.candidate,
      remoteRoot: currentUpdate.root,
      ...(merge ? { merge } : {}),
      requestDigest,
      transition,
    }, () => {
      this.applyAccountConfigDerived(account.id, currentGraph, nextGraph);
      for (const rewrite of boundaryRewrites) {
        const result = this.db.run("UPDATE trees SET ref = ?, updated_at = ? WHERE id = ? AND ref = ?", [
          rewrite.nextRoot, now, rewrite.parent.id, rewrite.parent.ref,
        ]);
        if (result.changes !== 1) throw new RefConflictError(this.get(rewrite.parent.id)?.ref ?? null);
        this.db.run("INSERT INTO reflog (tree_id, ref, previous_ref, changed_at) VALUES (?, ?, ?, ?)", [
          rewrite.parent.id, rewrite.nextRoot, rewrite.parent.ref, now,
        ]);
        boundaryUpdates.push(this.insertAcceptedUpdate({
          tree: rewrite.parent.id,
          root: rewrite.nextRoot,
          previousRoot: rewrite.parent.ref,
          kind: "accepted",
          acceptedAt: now,
          subject,
          transition: boundaryTransitions.get(rewrite.parent.id),
        }));
      }
    });
    if (!accepted) throw new RefConflictError(this.get(tree.id)?.ref ?? null);
    const updated = this.get(tree.id)!;
    for (const listener of this.listeners.get(tree.id) ?? []) listener(updated, accepted, requestDigest);
    for (const update of boundaryUpdates) {
      const parent = this.get(update.tree)!;
      for (const listener of this.listeners.get(update.tree) ?? []) listener(parent, update);
    }
    return kind === "merged"
      ? { status: 201, result: { outcome: "merged", update: accepted, merge: merge!, requestDigest, observedThrough: accepted.id } }
      : { status: 201, result: { outcome: "accepted", update: accepted, requestDigest, observedThrough: accepted.id } };
  }

  subscribe(id: string, listener: (tree: CanopyTree, update: AcceptedUpdate, requestDigest?: ObjectHash) => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => listeners.delete(listener);
  }

  observationEvents(tree: string): Array<{ cursor: string; tree: string; kind: string; change: unknown; createdAt: number }> {
    return (this.db.query("SELECT * FROM observation_events WHERE tree_id = ? ORDER BY created_at, rowid").all(tree) as Array<{
      cursor: string; tree_id: string; kind: string; change_json: string; created_at: number;
    }>).map((row) => ({
      cursor: row.cursor,
      tree: row.tree_id,
      kind: row.kind,
      change: JSON.parse(row.change_json),
      createdAt: row.created_at,
    }));
  }

  subscribeObservations(tree: string, listener: (event: { cursor: string; tree: string; kind: string; change: unknown }) => void): () => void {
    const listeners = this.observationListeners.get(tree) ?? new Set();
    listeners.add(listener);
    this.observationListeners.set(tree, listeners);
    return () => listeners.delete(listener);
  }

  private recordObservation(tree: string, kind: string, change: unknown) {
    const cursor = generateArborID("up");
    const event = { cursor, tree, kind, change };
    this.db.run("INSERT INTO observation_events (cursor, tree_id, kind, change_json, created_at) VALUES (?, ?, ?, ?, ?)", [
      cursor, tree, kind, JSON.stringify(change), Date.now(),
    ]);
    return event;
  }

  private notifyObservation(event: { cursor: string; tree: string; kind: string; change: unknown }): void {
    for (const listener of this.observationListeners.get(event.tree) ?? []) listener(event);
  }

  private emitObservation(tree: string, kind: string, change: unknown): string {
    const event = this.recordObservation(tree, kind, change);
    this.notifyObservation(event);
    return event.cursor;
  }

  async object(hash: ObjectHash): Promise<Uint8Array> {
    const bytes = new Uint8Array(await readFile(this.objectPath(hash)));
    if (hashObject(bytes) !== hash) throw new Error(`Stored object hash mismatch: ${hash}`);
    return bytes;
  }

  private async completeSnapshot(
    root: ObjectHash,
    proposed: ReadonlyMap<ObjectHash, Uint8Array> = new Map(),
  ): Promise<TreeSnapshot> {
    const objects = new Map<ObjectHash, Uint8Array>();
    const pending = [root];
    while (pending.length) {
      const hash = pending.pop()!;
      if (objects.has(hash)) continue;
      const bytes = await this.loadObject(hash, proposed);
      objects.set(hash, bytes);
      const object = decodeWireObject(bytes);
      if (object.type === "directory") {
        for (const entry of object.entries) pending.push(...wireEntryObjectHashes(entry));
      }
    }
    return { root, objects };
  }

  /** Verify SQLite plus every object reachable from retained accepted history. */
  async verifyIntegrity(): Promise<void> {
    const rows = this.db.query("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
      throw new Error("Canopy SQLite integrity check failed");
    }
    const pending = (this.db.query("SELECT DISTINCT root FROM accepted_updates").all() as Array<{ root: ObjectHash }>)
      .map(({ root }) => root);
    const seen = new Set<ObjectHash>();
    while (pending.length) {
      const hash = pending.pop()!;
      if (seen.has(hash)) continue;
      seen.add(hash);
      // Canopy releases before the portable wire foundation retained some
      // accepted historical directory objects in host-locale order. Current
      // graphs and every public decoder remain strict UTF-8, but those private
      // immutable history objects must stay traversable for integrity checks.
      const object = decodeWireObject(await this.object(hash), { allowLegacyDirectoryOrder: true });
      if (object.type === "directory") {
        for (const entry of object.entries) pending.push(...wireEntryObjectHashes(entry));
      }
    }
  }

  async isReadableObject(treeID: string, hash: ObjectHash, account: CanopyAccount | null, linkDigest?: string): Promise<boolean> {
    const tree = this.get(treeID);
    return Boolean(tree && this.canRead(account, treeID, linkDigest) && await this.graphContains(tree.ref, hash));
  }

  private async insertTree(
    canonicalPath: string,
    kind: BoundaryKind,
    snapshot: TreeSnapshot,
    publicAccess: PublicAccess,
    parentTree: string | null,
    withinTransaction?: (treeID: string) => void,
    credentialSubject?: string,
    requestedTreeID?: string,
    accountID?: string,
  ): Promise<CanopyTree> {
    const path = normalizeBoundaryPath(canonicalPath);
    await this.validateGraph(snapshot.root, snapshot.objects);
    await this.storeObjects([...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
    const id = requestedTreeID ?? generateArborID("tr");
    if (this.db.query("SELECT 1 FROM trees WHERE id = ?").get(id)) throw new Error(`TreeID already exists: ${id}`);
    const attachment = parentTree ? await this.prepareBoundaryAttachment(parentTree, path, id) : null;
    if (attachment) {
      await this.cacheMembers(attachment.nextRoot, attachment.generated);
      await this.storeObjects([...attachment.generated].map(([hash, bytes]) => ({ hash, bytes })));
    }
    const attachmentTransition = attachment
      ? await this.acceptedTransitionPayload(attachment.parent.ref, attachment.nextRoot)
      : null;
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run("INSERT INTO trees (id, ref, updated_at, account_id) VALUES (?, ?, ?, ?)", [id, snapshot.root, now, accountID ?? null]);
      this.db.run(
        "INSERT INTO boundaries (path, tree_id, parent_tree, kind) VALUES (?, ?, ?, ?)",
        [path, id, parentTree, kind],
      );
      this.db.run(
        "INSERT INTO reflog (tree_id, ref, previous_ref, changed_at) VALUES (?, ?, NULL, ?)",
        [id, snapshot.root, now],
      );
      this.insertAcceptedUpdate({
        tree: id,
        root: snapshot.root,
        previousRoot: null,
        kind: "initial",
        acceptedAt: now,
        subject: credentialSubject ?? null,
      });
      if (publicAccess !== "none") this.setAccessInternal(id, "everyone", "everyone", publicAccess);
      withinTransaction?.(id);
      if (attachment) {
        const result = this.db.run("UPDATE trees SET ref = ?, updated_at = ? WHERE id = ? AND ref = ?", [
          attachment.nextRoot,
          now,
          attachment.parent.id,
          attachment.parent.ref,
        ]);
        if (result.changes !== 1) throw new RefConflictError(this.get(attachment.parent.id)?.ref ?? null);
        this.db.run(
          "INSERT INTO reflog (tree_id, ref, previous_ref, changed_at) VALUES (?, ?, ?, ?)",
          [attachment.parent.id, attachment.nextRoot, attachment.parent.ref, now],
        );
        this.insertAcceptedUpdate({
          tree: attachment.parent.id,
          root: attachment.nextRoot,
          previousRoot: attachment.parent.ref,
          kind: "accepted",
          acceptedAt: now,
          subject: credentialSubject ?? null,
          ...(attachmentTransition ? { transition: attachmentTransition } : {}),
        });
      }
    })();
    if (attachment) {
      const updated = this.get(attachment.parent.id)!;
      const update = this.currentUpdate(attachment.parent.id)!;
      for (const listener of this.listeners.get(attachment.parent.id) ?? []) listener(updated, update);
    }
    return this.get(id)!;
  }

  private async prepareBoundaryAttachment(
    parentTreeID: string,
    childPath: string,
    childTreeID: string,
  ): Promise<{ parent: CanopyTree; nextRoot: ObjectHash; generated: Map<ObjectHash, Uint8Array> }> {
    const parent = this.get(parentTreeID);
    if (!parent?.canonicalPath) throw new Error(`Unknown or noncanonical parent tree: ${parentTreeID}`);
    const parentSegments = pathSegments(parent.canonicalPath);
    const childSegments = pathSegments(childPath);
    const relativeSegments = childSegments.slice(parentSegments.length);
    if (!relativeSegments.length) throw new Error("Nested boundary must be below its parent");
    const generated = new Map<ObjectHash, Uint8Array>();
    const replace = async (hash: ObjectHash, segments: string[]): Promise<ObjectHash> => {
      const object = decodeWireObject(await this.loadObject(hash, generated));
      if (object.type !== "directory") throw new Error("Canonical boundary crosses a file");
      const [name, ...rest] = segments;
      const entries = [...object.entries];
      const index = entries.findIndex((entry) => entry.name === name);
      if (!rest.length) {
        if (index >= 0 && entries[index]!.tree && entries[index]!.tree !== childTreeID) {
          throw new Error(`Canonical boundary is already occupied: ${childPath}`);
        }
        const next: WireDirectoryEntry = { name: name!, tree: childTreeID };
        if (index >= 0) entries[index] = next;
        else entries.push(next);
      } else {
        let childHash: ObjectHash;
        if (index < 0) {
          const empty = encodeWireObject({ type: "directory", entries: [] });
          childHash = hashObject(empty);
          generated.set(childHash, empty);
          entries.push({ name: name!, hash: childHash });
        } else {
          const entry = entries[index]!;
          if (entry.tree || !entry.hash) throw new Error(`Canonical boundary crosses another tree: ${childPath}`);
          childHash = entry.hash;
        }
        const updatedChild = await replace(childHash, rest);
        const updated: WireDirectoryEntry = { name: name!, hash: updatedChild };
        const updatedIndex = entries.findIndex((entry) => entry.name === name);
        entries[updatedIndex] = updated;
      }
      entries.sort((a, b) => compareWireNames(a.name, b.name));
      const bytes = encodeWireObject({ type: "directory", entries } satisfies WireDirectory);
      const nextHash = hashObject(bytes);
      generated.set(nextHash, bytes);
      return nextHash;
    };
    const nextRoot = await replace(parent.ref, relativeSegments);
    return { parent, nextRoot, generated };
  }

  private async prepareBoundaryRewrite(
    parentTreeID: string,
    removals: Array<{ path: string; tree: string }>,
    additions: Array<{ path: string; tree: string }>,
  ): Promise<{ parent: CanopyTree; nextRoot: ObjectHash; generated: Map<ObjectHash, Uint8Array> }> {
    const parent = this.get(parentTreeID);
    if (!parent?.canonicalPath) throw new Error(`Unknown or noncanonical parent tree: ${parentTreeID}`);
    const prefix = pathSegments(parent.canonicalPath);
    const generated = new Map<ObjectHash, Uint8Array>();
    type Edit = { segments: string[]; tree: string; remove: boolean };
    const edits: Edit[] = [
      ...removals.map((item) => ({ segments: pathSegments(item.path).slice(prefix.length), tree: item.tree, remove: true })),
      ...additions.map((item) => ({ segments: pathSegments(item.path).slice(prefix.length), tree: item.tree, remove: false })),
    ];
    if (edits.some((edit) => edit.segments.length === 0)) throw new Error("A boundary cannot replace its parent root");

    const rewrite = async (hash: ObjectHash, pending: Edit[]): Promise<ObjectHash> => {
      const object = decodeWireObject(await this.loadObject(hash, generated));
      if (object.type !== "directory") throw new Error("Canonical boundary crosses a file");
      const entries = [...object.entries];
      const grouped = new Map<string, Edit[]>();
      for (const edit of pending) {
        const [name, ...rest] = edit.segments;
        const values = grouped.get(name!) ?? [];
        values.push({ ...edit, segments: rest });
        grouped.set(name!, values);
      }
      for (const [name, group] of grouped) {
        let index = entries.findIndex((entry) => entry.name === name);
        const leaf = group.filter((edit) => edit.segments.length === 0);
        const deeper = group.filter((edit) => edit.segments.length > 0);
        for (const edit of leaf) {
          if (edit.remove) {
            if (index < 0 || entries[index]!.tree !== edit.tree) throw new Error(`Canonical boundary moved concurrently: ${edit.tree}`);
            entries.splice(index, 1);
            index = -1;
          } else {
            if (index >= 0 && entries[index]!.tree !== edit.tree) throw new Error(`Canonical boundary is occupied: ${name}`);
            const next: WireDirectoryEntry = { name, tree: edit.tree };
            if (index >= 0) entries[index] = next;
            else { entries.push(next); index = entries.length - 1; }
          }
        }
        if (deeper.length) {
          if (index >= 0 && entries[index]!.tree) throw new Error(`Canonical boundary crosses another tree: ${name}`);
          let childHash = index >= 0 ? entries[index]!.hash : undefined;
          if (!childHash) {
            const empty = encodeWireObject({ type: "directory", entries: [] });
            childHash = hashObject(empty);
            generated.set(childHash, empty);
          }
          const updated = await rewrite(childHash, deeper);
          const next: WireDirectoryEntry = { name, hash: updated };
          if (index >= 0) entries[index] = next;
          else entries.push(next);
        }
      }
      entries.sort((a, b) => compareWireNames(a.name, b.name));
      const bytes = encodeWireObject({ type: "directory", entries } satisfies WireDirectory);
      const nextHash = hashObject(bytes);
      generated.set(nextHash, bytes);
      return nextHash;
    };
    const nextRoot = await rewrite(parent.ref, edits);
    return { parent, nextRoot, generated };
  }

  private async prepareAccountBoundaryRewrites(current: AccountConfigGraph, next: AccountConfigGraph) {
    const grouped = new Map<string, { removals: Array<{ path: string; tree: string }>; additions: Array<{ path: string; tree: string }> }>();
    const group = (parent: string) => {
      const value = grouped.get(parent) ?? { removals: [], additions: [] };
      grouped.set(parent, value);
      return value;
    };
    for (const [id, declaration] of Object.entries(next.trees.trees)) {
      const before = current.trees.trees[id];
      const active = this.get(id);
      if (!before || !active || before.canonicalPath === declaration.canonicalPath) continue;
      if (!active.parentTree) throw new Error(`Canonical tree ${id} has no movable parent boundary`);
      const nextParent = this.resolve(dirnameURL(declaration.canonicalPath))?.tree;
      if (!nextParent || nextParent.id === id) throw new Error(`Canonical parent is unavailable for ${declaration.canonicalPath}`);
      group(active.parentTree).removals.push({ path: before.canonicalPath, tree: id });
      group(nextParent.id).additions.push({ path: declaration.canonicalPath, tree: id });
    }
    const rewrites = [];
    for (const [parent, edits] of grouped) {
      const rewrite = await this.prepareBoundaryRewrite(parent, edits.removals, edits.additions);
      if (rewrite.nextRoot !== rewrite.parent.ref) rewrites.push(rewrite);
    }
    return rewrites;
  }

  private async validateReservedBoundaries(
    parent: CanopyTree,
    root: ObjectHash,
    proposed: ReadonlyMap<ObjectHash, Uint8Array>,
  ): Promise<void> {
    const children = this.db.query(
      "SELECT path, tree_id FROM boundaries WHERE parent_tree = ? ORDER BY length(path)",
    ).all(parent.id) as Array<{ path: string; tree_id: string }>;
    for (const child of children) {
      if (!parent.canonicalPath) throw new Error("A noncanonical tree cannot own canonical boundaries");
      const segments = pathSegments(child.path).slice(pathSegments(parent.canonicalPath).length);
      let hash = root;
      let valid = true;
      for (const [index, segment] of segments.entries()) {
        const object = decodeWireObject(await this.loadObject(hash, proposed));
        if (object.type !== "directory") {
          valid = false;
          break;
        }
        const entry = object.entries.find((candidate) => candidate.name === segment);
        if (!entry) {
          valid = false;
          break;
        }
        if (index === segments.length - 1) {
          valid = entry.tree === child.tree_id;
        } else if (entry.hash) {
          hash = entry.hash;
        } else {
          valid = false;
          break;
        }
      }
      if (!valid) throw new ReservedBoundaryConflictError(child.path, child.tree_id);
    }
  }

  private async validateProfileSnapshot(snapshot: TreeSnapshot, kind: "person" | "group"): Promise<void> {
    await this.validateProfileRoot(snapshot.root, snapshot.objects, kind);
  }

  private async validateProfileRoot(
    root: ObjectHash,
    proposed: ReadonlyMap<ObjectHash, Uint8Array>,
    kind: "person" | "group",
  ): Promise<void> {
    const directory = decodeWireObject(await this.loadObject(root, proposed));
    if (directory.type !== "directory") throw new Error("Profile root must be a directory");
    const index = directory.entries.find((entry) => entry.name === "_index.md");
    if (!index?.hash) throw new Error("Profile tree requires _index.md");
    const file = decodeWireObject(await this.loadObject(index.hash, proposed));
    if (file.type !== "file") throw new Error("Profile _index.md must be a file");
    const source = new TextDecoder().decode(file.bytes);
    if (!new RegExp(`^type:\\s*${kind}\\s*$`, "m").test(source)) {
      throw new Error(`Profile root must declare type: ${kind}`);
    }
  }

  private profileMemberHandles(treeID: string): Set<string> {
    const tree = this.get(treeID);
    return tree ? this.memberHandlesFromRoot(tree.ref) : new Set();
  }

  private communityMemberHandles(): Set<string> {
    return this.memberHandlesFromRoot(this.community().ref);
  }

  private memberHandlesFromRoot(root: ObjectHash): Set<string> {
    // Profile validation caches the authored member locators by immutable root
    // hash, so synchronous authorization never reparses mutable filesystem
    // state or treats display names as identity.
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(`members:${root}`) as { value: string } | null;
    const host = (this.db.query("SELECT value FROM meta WHERE key = 'community_host'").get() as { value: string } | null)?.value;
    const values = row ? JSON.parse(row.value) as string[] : [];
    return new Set(values.flatMap((value) => {
      if (!value.includes("/~")) return [value];
      const match = /^([^/]+)\/~([a-z0-9][a-z0-9-]{0,62})$/.exec(value);
      return match && (!host || match[1]!.toLowerCase() === host) ? [match[2]!] : [];
    }));
  }

  private async cacheMembers(root: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array>): Promise<void> {
    const directory = decodeWireObject(await this.loadObject(root, proposed));
    if (directory.type !== "directory") return;
    const index = directory.entries.find((entry) => entry.name === "_index.md");
    if (!index?.hash) return;
    const file = decodeWireObject(await this.loadObject(index.hash, proposed));
    if (file.type !== "file") return;
    const source = new TextDecoder().decode(file.bytes);
    const handles = [...source.matchAll(/arbor:\/\/([^/\s"']+)\/~([a-z0-9][a-z0-9-]{0,62})/g)]
      .map((match) => `${match[1]!.toLowerCase()}/~${match[2]!}`);
    this.db.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [`members:${root}`, JSON.stringify([...new Set(handles)])],
    );
  }

  private reconcileCommunityAccounts(): void {
    const members = this.communityMemberHandles();
    for (const account of this.db.query("SELECT handle FROM accounts").all() as Array<{ handle: string }>) {
      this.db.run("UPDATE accounts SET enabled = ? WHERE handle = ?", [members.has(account.handle) ? 1 : 0, account.handle]);
    }
  }

  private objectPath(hash: ObjectHash): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid object hash: ${hash}`);
    return join(this.dataRoot, "objects", hash.slice(7, 9), hash.slice(9));
  }

  private async hasObject(hash: ObjectHash): Promise<boolean> {
    try {
      await readFile(this.objectPath(hash));
      return true;
    } catch {
      return false;
    }
  }

  private async loadObject(hash: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array>): Promise<Uint8Array> {
    return proposed.get(hash) ?? await this.object(hash);
  }

  private async graphContains(root: ObjectHash, target: ObjectHash): Promise<boolean> {
    const pending = [root];
    const seen = new Set<ObjectHash>();
    while (pending.length) {
      const hash = pending.pop()!;
      if (hash === target) return true;
      if (seen.has(hash)) continue;
      seen.add(hash);
      const object = decodeWireObject(await this.object(hash));
      if (object.type === "directory") {
        for (const entry of object.entries) pending.push(...wireEntryObjectHashes(entry));
      }
    }
    return false;
  }

  private async graphContainsProposed(
    root: ObjectHash,
    target: ObjectHash,
    proposed: ReadonlyMap<ObjectHash, Uint8Array>,
  ): Promise<boolean> {
    const pending = [root];
    const seen = new Set<ObjectHash>();
    while (pending.length) {
      const hash = pending.pop()!;
      if (hash === target) return true;
      if (seen.has(hash)) continue;
      seen.add(hash);
      const bytes = proposed.get(hash) ?? (await this.hasObject(hash) ? await this.object(hash) : null);
      if (!bytes) return false;
      const object = decodeWireObject(bytes);
      if (object.type === "directory") {
        for (const entry of object.entries) pending.push(...wireEntryObjectHashes(entry));
      }
    }
    return false;
  }

  private async reconstructFilePatches(
    baseRoot: ObjectHash,
    patches: FilePatch[],
    proposed: Map<ObjectHash, Uint8Array>,
  ): Promise<Array<{ hash: ObjectHash; bytes: Uint8Array }>> {
    const reconstructed: Array<{ hash: ObjectHash; bytes: Uint8Array }> = [];
    const results = new Set<ObjectHash>();
    for (const patch of patches) {
      if (!/^sha256:[a-f0-9]{64}$/.test(patch.base) || !/^sha256:[a-f0-9]{64}$/.test(patch.result)) {
        throw new Error("Invalid file patch hash");
      }
      if (results.has(patch.result) || proposed.has(patch.result)) {
        throw new Error(`Duplicate file patch result: ${patch.result}`);
      }
      results.add(patch.result);
      if (!patch.edits.length) throw new Error("File patch edits must not be empty");
      if (!await this.graphContains(baseRoot, patch.base)) {
        throw new Error(`File patch base is not reachable from retained base: ${patch.base}`);
      }
      const baseObject = decodeWireObject(await this.object(patch.base));
      if (baseObject.type !== "file") throw new Error("File patch base is not a file object");

      const payload = applyFilePatch(baseObject.bytes, patch);
      const bytes = encodeWireObject({ type: "file", bytes: payload });
      if (hashObject(bytes) !== patch.result) throw new Error(`File patch result hash mismatch: ${patch.result}`);
      proposed.set(patch.result, bytes);
      reconstructed.push({ hash: patch.result, bytes });
    }
    return reconstructed;
  }

  private async validateGraph(root: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array>): Promise<void> {
    const pending = [root];
    const seen = new Set<ObjectHash>();
    let totalBytes = 0;
    while (pending.length) {
      const hash = pending.pop()!;
      if (seen.has(hash)) continue;
      seen.add(hash);
      if (seen.size > 100_000) throw new Error("Tree exceeds the object quota");
      const bytes = proposed.get(hash) ?? (await this.hasObject(hash) ? await this.object(hash) : null);
      if (!bytes) throw new Error(`Missing referenced object: ${hash}`);
      if (hashObject(bytes) !== hash) throw new Error(`Object hash mismatch: ${hash}`);
      totalBytes += bytes.byteLength;
      if (totalBytes > 1_000_000_000) throw new Error("Tree exceeds the storage quota");
      const object = decodeWireObject(bytes);
      if (object.type !== "directory") continue;
      const names = new Set<string>();
      for (const entry of object.entries) {
        if (
          !entry.name
          || entry.name === "."
          || entry.name === ".."
          || entry.name.includes("/")
          || entry.name.includes("\\")
          || names.has(entry.name)
        ) throw new Error(`Invalid or duplicate directory entry: ${entry.name}`);
        names.add(entry.name);
        pending.push(...wireEntryObjectHashes(entry));
        if (entry.rollup) {
          const loadFile = async (target: ObjectHash): Promise<Uint8Array> => {
            const targetBytes = proposed.get(target) ?? (await this.hasObject(target) ? await this.object(target) : null);
            if (!targetBytes || hashObject(targetBytes) !== target) throw new Error(`Missing rollup object: ${target}`);
            const targetObject = decodeWireObject(targetBytes);
            if (targetObject.type !== "file") throw new Error(`Rollup target is not a file: ${target}`);
            return targetObject.bytes;
          };
          await decodeWireFileRollup(
            entry.rollup,
            await loadFile(entry.rollup.source),
            await loadFile(entry.rollup.schemaSource),
            this.wireSchemas,
          );
        }
      }
    }
    await this.cacheMembers(root, proposed);
  }

  private async storeObjects(objects: Array<{ hash: ObjectHash; bytes: Uint8Array }>): Promise<void> {
    for (const object of objects) {
      if (hashObject(object.bytes) !== object.hash) throw new Error(`Object hash mismatch: ${object.hash}`);
      const path = this.objectPath(object.hash);
      const directory = dirname(path);
      await mkdir(directory, { recursive: true });
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(object.bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          // A hard link publishes the fully flushed inode without ever replacing
          // an immutable object that another writer may have published first.
          await link(temporary, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const existing = new Uint8Array(await readFile(path));
          if (hashObject(existing) !== object.hash) {
            throw new Error(`Stored object hash mismatch: ${object.hash}`);
          }
        }
        await unlink(temporary);
        await syncDirectory(directory);
        // The two-hex-character shard may itself have been created for this
        // object, so flush its entry in the stable objects directory too.
        await syncDirectory(dirname(directory));
      } finally {
        await unlink(temporary).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.wireSchemas[Symbol.asyncDispose]();
    this.db.close();
    this.listeners.clear();
  }
}

function dirnameURL(path: string): string {
  const segments = pathSegments(path);
  if (segments.length <= 1) return "/";
  return `/${segments.slice(0, -1).join("/")}`;
}
