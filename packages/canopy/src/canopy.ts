import { link, mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { canonicalJSONString, generateArborID, isGeneratedArborID, sha256, type AccessLevel, type AccessRule, type ReadWriteAccess, type TreeKind } from "@arbor/core";
import { decodeWireFileRollup, SchemaSandbox } from "@arbor/stores";
import {
  decodeWireObject,
  encodeWireObject,
  hashObject,
  wireEntryObjectHashes,
  updateRequestDigest,
  type AcceptedTransition,
  type AcceptedTransitionPayload,
  type AcceptedUpdate,
  type ServerDevice,
  type ObjectHash,
  type PairingOffer,
  type TreeSnapshot,
  type UpdateConflictResult,
  type UpdateRequest,
  type UpdateResult,
} from "@arbor/wire";
import {
  authorizeAccountConfigTransition,
  mergeAccountConfigGraphs,
  readAccountConfigGraph,
  snapshotAccountConfig,
  type AccountConfigGraph,
} from "./account-policy.ts";
import { reconcileUpdate, type MergeStrategy } from "./updates/reconcile.ts";
import { AcceptedUpdateStore, type AcceptedUpdateInput } from "./updates/store.ts";
import { ObservationLog, type ObservationRecord } from "./updates/observations.ts";
import { buildAcceptedTransitionPayload } from "./updates/transition.ts";
import { ObjectStore } from "./objects.ts";
import { AccessControl } from "./access.ts";
import { AccountDirectory } from "./accounts.ts";
import type { CanonicalBoundary, CanopyAccessEntry, CanopyAccount, CanopyAuthentication, CanopyTree } from "./model.ts";
import { normalizeBoundaryPath, pathSegments, rewriteBoundaries, type BoundaryEdit, type BoundaryRewriteOptions } from "./boundaries.ts";

export type { CanonicalBoundary, CanopyAccessEntry, CanopyAccount, CanopyAuthentication, CanopyTree } from "./model.ts";

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

function profileHandle(path: string): string | null {
  const segments = pathSegments(path);
  if (segments.length !== 1 || !segments[0]!.startsWith("~")) return null;
  const handle = segments[0]!.slice(1);
  return HANDLE.test(handle) ? handle : null;
}

function sameOrDescendant(path: string, parent: string): boolean {
  return path === parent || parent === "/" || path.startsWith(`${parent}/`);
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
  observations: ["ordinal", "cursor", "tree_id", "kind", "update_id", "change_json", "created_at"],
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
  // Transitions recorded before the single object-delta rule are not
  // replayable; a watch that needs one receives resync-required instead.
  db.run(`
    UPDATE accepted_updates SET transition_json = NULL
    WHERE transition_json LIKE '%"filePatches"%' OR transition_json LIKE '%"fileDeltas"%'
  `);
  db.run(`CREATE TABLE IF NOT EXISTS tree_reservations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    kind TEXT NOT NULL,
    canonical_path TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    error TEXT
  )`);
  migrateObservationLog(db);
}

/**
 * Fold the former accepted-updates and observation-events timelines into the
 * single ordered observation log. Their relative order was previously derived
 * from timestamps at read time; this replays that rule exactly once so retained
 * cursors keep their meaning, after which ordinals alone define order.
 */
function migrateObservationLog(db: Database): void {
  const tableExists = (name: string) => Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  if (tableExists("observations")) return;
  ObservationLog.createSchema(db);
  const legacyEvents = tableExists("observation_events");
  db.run(`
    INSERT INTO observations (cursor, tree_id, kind, update_id, change_json, created_at)
    SELECT cursor, tree_id, kind, update_id, change_json, created_at FROM (
      SELECT id AS cursor, tree_id, 'tree.ref' AS kind, id AS update_id, NULL AS change_json,
        accepted_at AS created_at, 0 AS tie, sequence AS ordering, '' AS tiebreak
      FROM accepted_updates
      ${legacyEvents ? `UNION ALL
      SELECT cursor, tree_id, kind, NULL, change_json, created_at, 1, 0, cursor
      FROM observation_events` : ""}
    ) ORDER BY created_at, tie, ordering, tiebreak
  `);
  if (legacyEvents) db.run("DROP TABLE observation_events");
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
  for (const obsolete of ["legacy_trees", "update_replays", "observation_events"]) {
    if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(obsolete)) {
      issues.push(`obsolete ${obsolete} table`);
    }
  }
  for (const index of ["accepted_updates_tree_order", "accepted_updates_request", "observations_tree_order"]) {
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

/**
 * What differs between tree policies inside the one update pipeline: who the
 * subject is, how a candidate and an accepted root are validated, which merge
 * runs when both sides changed, and what commits alongside the accepted row.
 */
interface UpdatePolicy {
  subject: string;
  conflict: { kind: "server-update" | "account-configuration"; message: string };
  merge?: MergeStrategy;
  /** Validate the complete candidate graph once, before reconciliation. */
  validateCandidate(root: ObjectHash, objects: ReadonlyMap<ObjectHash, Uint8Array>): Promise<void>;
  /** Validate the root about to be accepted against the tree as it is now. */
  validateAccepted(remoteTree: CanopyTree, root: ObjectHash, objects: ReadonlyMap<ObjectHash, Uint8Array>): Promise<void>;
  /** Durable side effects for the accepted update; runs after every candidate object is stored. */
  prepareCommit(remoteTree: CanopyTree, root: ObjectHash, at: number): Promise<{
    withinTransaction?: () => void;
    afterCommit?: (accepted: AcceptedUpdate) => void;
  }>;
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
  private readonly observations: ObservationLog;
  private readonly objects: ObjectStore;
  private readonly access: AccessControl;
  private readonly accounts: AccountDirectory;
  private observationListeners = new Map<string, Set<(record: ObservationRecord) => void>>();
  private updateLocks = new Map<string, Promise<void>>();

  private constructor(readonly dataRoot: string, db: Database) {
    this.db = db;
    this.acceptedStore = new AcceptedUpdateStore(db);
    this.observations = new ObservationLog(db);
    this.objects = new ObjectStore(join(dataRoot, "objects"));
    this.accounts = new AccountDirectory(db);
    this.access = new AccessControl(db, {
      tree: (id) => this.get(id),
      profileMemberHandles: (id) => this.profileMemberHandles(id),
    });
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
      const accountID = generateArborID("ac");
      this.db.run(
        "INSERT INTO accounts (id, handle, profile_tree, token_digest, enabled) VALUES (?, ?, ?, ?, 1)",
        [accountID, account.handle, profile.id, sha256(account.token)],
      );
      this.db.run(
        "INSERT INTO devices (id, account_id, label, token_digest, created_at) VALUES (?, ?, 'Initial device', ?, ?)",
        [generateArborID("dv"), accountID, sha256(account.token), Date.now()],
      );
      this.access.set(profile.id, "profile", profile.id, "write");
      if (account.communityWriter !== false) {
        this.access.set(community.id, "profile", profile.id, "write");
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
      kind: TreeKind | null;
      public_access: AccessLevel | null;
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

  /** Latest retained observation cursor for one tree, or for the whole server. */
  observedThrough(treeID?: string): string {
    return this.observations.latestCursor(treeID) ?? "0";
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
    return this.objects.completeSnapshot(update.root);
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
    return this.accounts.account(id);
  }

  authenticateToken(token: string | undefined): CanopyAuthentication | null {
    return this.accounts.authenticateToken(token);
  }

  accountByToken(token: string | undefined): CanopyAccount | null {
    return this.authenticateToken(token)?.account ?? null;
  }

  devices(account: CanopyAccount): ServerDevice[] {
    return this.accounts.devices(account);
  }

  createPairing(account: CanopyAccount): PairingOffer {
    return this.accounts.createPairing(account);
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
    if (this.accounts.deviceExists(input.deviceID)) {
      throw new Error(`Retired DeviceID cannot be reused: ${input.deviceID}`);
    }
    const tokenDigest = input.credentialDigest.slice("sha256:".length);
    const pairing = this.accounts.pairing(id);
    const secretMatches = pairing?.secretMatches(secret) ?? false;
    if (pairing?.claimedAt && pairing.claimedDevice === input.deviceID) {
      const replay = this.accounts.deviceBinding(input.deviceID, pairing.accountID);
      if (replay?.tokenDigest === tokenDigest && replay.label === safeLabel && secretMatches) {
        return { device: this.accounts.device(input.deviceID)!, confirmationCode: pairing.confirmationCode };
      }
    }
    if (!pairing || !pairing.accountEnabled || pairing.claimedAt || pairing.expiresAt <= Date.now() || !secretMatches) {
      throw new Error("Pairing is invalid, expired, or already used");
    }
    const account = this.account(pairing.accountID)!;
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
    await this.objects.store([...nextSnapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
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
      if (!this.accounts.claimPairing(id, input.deviceID, now)) throw new Error("Pairing is invalid, expired, or already used");
      this.accounts.insertDevice(input.deviceID, pairing.accountID, safeLabel, tokenDigest, now);
    });
    if (!accepted) throw new RefConflictError(this.get(configTree.id)?.ref ?? null);
    this.notifyAccepted(accepted);
    return { device: this.accounts.device(input.deviceID)!, confirmationCode: pairing.confirmationCode };
  }

  accountByHandle(handle: string): CanopyAccount | null {
    return this.accounts.accountByHandle(handle);
  }

  resetAccountToken(handle: string, token: string): CanopyAccount {
    return this.accounts.resetAccountToken(handle, token);
  }

  community(): CanopyTree {
    const community = this.boundary("/");
    if (!community) throw new Error("Community profile is missing");
    return community;
  }

  communityHandle(): string {
    return this.accounts.communityHandle();
  }

  isReservedHandle(handle: string): boolean {
    return HANDLE.test(handle)
      && !this.boundary(`/~${handle}`)
      && !this.accountByHandle(handle)
      && this.communityMemberHandles().has(handle);
  }

  setCommunityHost(host: string, allowTestPortChange = false): void {
    this.accounts.setCommunityHost(host, allowTestPortChange);
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
      await this.objects.store([...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
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
        this.access.set(id, rule.subject.kind, subject, rule.access);
      }
    }
  }

  private async accountConfigGraph(account: CanopyAccount): Promise<AccountConfigGraph> {
    if (!account.configTree) throw new Error("Account configuration tree is missing");
    const tree = this.get(account.configTree);
    if (!tree) throw new Error("Account configuration tree is missing");
    return readAccountConfigGraph(await this.objects.completeSnapshot(tree.ref), tree.id);
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
    let statusEvent: ObservationRecord | undefined;
    const activated = await this.insertTree(
      declaration.canonicalPath,
      declaration.kind,
      snapshot,
      "none",
      parent.id,
      (id) => {
        for (const rule of declaration.access) {
          const subject = rule.subject.kind === "everyone" ? "everyone" : rule.subject.kind === "profile" ? rule.subject.tree : rule.subject.digest;
          this.access.set(id, rule.subject.kind, subject, rule.access);
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
    return this.access.entries(tree);
  }

  canRead(account: CanopyAccount | null, treeID: string, linkDigest?: string): boolean {
    return this.access.canRead(account, treeID, linkDigest);
  }

  canWrite(account: CanopyAccount | null, treeID: string, linkDigest?: string): boolean {
    return this.access.canWrite(account, treeID, linkDigest);
  }

  canAdminister(account: CanopyAccount, treeID: string): boolean {
    return this.access.canAdminister(account, treeID);
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
    await this.objects.store([...input.configurationSnapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
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
          this.access.set(profileID, rule.subject.kind, subject, rule.access);
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
          this.access.set(parent.id, "profile", profileID, "write");
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
    return this.acceptedStore.insert(generateArborID("up"), input);
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
    const policy = tree.policy === "account-config-v1"
      ? this.accountConfigPolicy(tree, request, account, credentialSubject)
      : this.ordinaryPolicy(tree, request, account, linkDigest, credentialSubject);
    const { subject } = policy;
    const requestDigest = updateRequestDigest(treeID, request);
    const replay = this.acceptedRequest(treeID, subject, requestDigest);
    if (replay) return replay;
    const baseUpdate = this.update(request.base.update);
    if (!baseUpdate || baseUpdate.tree !== treeID || baseUpdate.root !== request.base.root) {
      throw new UpdateProtocolError("base-not-retained", "Base update is not retained for this tree and root");
    }
    const proposed = new Map(request.objects.map(({ hash, bytes }) => [hash, bytes]));
    const reconstructed = await this.objects.reconstructDeltas(request.base.root, request.deltas ?? [], proposed);
    for (const object of reconstructed) {
      if (!await this.objects.contains(request.candidate, object.hash, proposed)) {
        throw new Error(`Object delta result is not reachable from candidate: ${object.hash}`);
      }
    }
    await this.validateGraph(request.candidate, proposed);
    await policy.validateCandidate(request.candidate, proposed);

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
        (hash) => this.objects.load(hash, proposed),
        policy.merge,
      );
      if (reconciled.outcome === "current") {
        return { status: 200, result: { outcome: "current", current: remoteUpdate, requestDigest, observedThrough: remoteUpdate.id } };
      }
      const nextRoot = reconciled.root;
      const kind: AcceptedUpdate["kind"] = reconciled.outcome;
      const merge = reconciled.outcome === "merged" ? reconciled.merge : undefined;
      const objects = new Map([...proposed, ...reconciled.generated]);
      if (reconciled.outcome === "merged" && reconciled.conflicts.length) {
        const draft = await this.objects.completeSnapshot(reconciled.root, objects);
        return {
          status: 409,
          result: {
            error: "conflict",
            message: policy.conflict.message,
            retryable: false,
            tree: treeID,
            details: {
              kind: policy.conflict.kind,
              current: remoteUpdate,
              base: request.base.root,
              candidate: request.candidate,
              draft,
              conflicts: reconciled.conflicts,
            },
          },
        };
      }
      await policy.validateAccepted(remoteTree, nextRoot, objects);
      await this.objects.store(request.objects);
      await this.objects.store(reconstructed);
      await this.objects.store([...reconciled.generated].map(([hash, bytes]) => ({ hash, bytes })));
      const now = Date.now();
      const prepared = await policy.prepareCommit(remoteTree, nextRoot, now);
      const transition = await this.acceptedTransitionPayload(remoteTree.ref, nextRoot);
      const accepted = this.acceptedStore.commit(generateArborID("up"), {
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
      }, prepared.withinTransaction);
      if (!accepted) continue;
      prepared.afterCommit?.(accepted);
      this.notifyAccepted(accepted);
      return kind === "merged"
        ? { status: 201, result: { outcome: "merged", update: accepted, merge: merge!, requestDigest, observedThrough: accepted.id } }
        : { status: 201, result: { outcome: "accepted", update: accepted, requestDigest, observedThrough: accepted.id } };
    }
    throw new UpdateProtocolError("server-busy", "Server update changed repeatedly during merge");
  }

  /** Ordinary trees: graph and boundary validation, the Wire three-way merge, and community reconciliation. */
  private ordinaryPolicy(
    tree: CanopyTree,
    request: UpdateRequest,
    account: CanopyAccount | null,
    linkDigest: string | undefined,
    credentialSubject: string | undefined,
  ): UpdatePolicy {
    return {
      subject: credentialSubject ?? (account ? `account:${account.id}` : linkDigest ? `link:${linkDigest}` : "public"),
      conflict: { kind: "server-update", message: "The candidate could not be merged safely" },
      validateCandidate: async (root, objects) => {
        await this.validateReservedBoundaries(tree, root, objects);
        if (tree.kind === "person-profile") await this.validateProfileRoot(root, objects, "person");
        if (tree.kind === "group-profile" || tree.kind === "community-profile") await this.validateProfileRoot(root, objects, "group");
      },
      validateAccepted: async (remoteTree, root, objects) => {
        if (root === request.candidate) return;
        await this.validateGraph(root, objects);
        await this.validateReservedBoundaries(remoteTree, root, objects);
      },
      prepareCommit: async (remoteTree) => ({
        afterCommit: () => {
          if (remoteTree.kind === "community-profile") this.reconcileCommunityAccounts();
        },
      }),
    };
  }

  /**
   * The private account-configuration tree: device authorization on every
   * transition, the semantic YAML merge, and the derived credential, ACL,
   * and canonical-boundary state committed with the accepted update.
   */
  private accountConfigPolicy(
    tree: CanopyTree,
    request: UpdateRequest,
    account: CanopyAccount | null,
    credentialSubject: string | undefined,
  ): UpdatePolicy {
    if (!account || tree.accountID !== account.id || credentialSubject?.startsWith("device:") !== true) {
      throw new Error("An active account device is required for configuration updates");
    }
    const deviceID = credentialSubject.slice("device:".length);
    const graphAt = async (root: ObjectHash, objects?: ReadonlyMap<ObjectHash, Uint8Array>) =>
      readAccountConfigGraph(await this.objects.completeSnapshot(root, objects), tree.id);
    let baseGraph: AccountConfigGraph;
    let candidateGraph: AccountConfigGraph;
    let currentGraph: AccountConfigGraph;
    let nextGraph: AccountConfigGraph;
    return {
      subject: credentialSubject,
      conflict: { kind: "account-configuration", message: "The account configuration contains incompatible same-field edits" },
      validateCandidate: async (root, objects) => {
        candidateGraph = await graphAt(root, objects);
        baseGraph = await graphAt(request.base.root);
        const current = this.currentUpdate(tree.id);
        if (!current) throw new Error("Account configuration has no accepted update");
        authorizeAccountConfigTransition(await graphAt(current.root), candidateGraph, deviceID, baseGraph);
      },
      merge: async (_base, _candidate, current) => {
        const merged = mergeAccountConfigGraphs(baseGraph, candidateGraph, await graphAt(current));
        const snapshot = snapshotAccountConfig(merged.graph);
        return {
          root: snapshot.root,
          objects: snapshot.objects,
          summary: { version: "account-config-v1", mergedFields: merged.mergedFields },
          conflicts: merged.conflicts.map((path) => ({ path, reason: "account-configuration" as const })),
        };
      },
      validateAccepted: async (remoteTree, root, objects) => {
        currentGraph = await graphAt(remoteTree.ref);
        nextGraph = root === request.candidate ? candidateGraph : await graphAt(root, objects);
        authorizeAccountConfigTransition(currentGraph, nextGraph, deviceID, currentGraph);
      },
      prepareCommit: async (_remoteTree, _root, now) => {
        const rewrites = await this.prepareAccountBoundaryRewrites(currentGraph, nextGraph);
        const transitions = new Map<string, AcceptedTransitionPayload>();
        for (const rewrite of rewrites) {
          await this.cacheMembers(rewrite.nextRoot, rewrite.generated);
          await this.objects.store([...rewrite.generated].map(([hash, bytes]) => ({ hash, bytes })));
          transitions.set(rewrite.parent.id, await this.acceptedTransitionPayload(rewrite.parent.ref, rewrite.nextRoot));
        }
        const boundaryUpdates: AcceptedUpdate[] = [];
        return {
          withinTransaction: () => {
            this.applyAccountConfigDerived(account.id, currentGraph, nextGraph);
            for (const rewrite of rewrites) {
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
                subject: credentialSubject,
                transition: transitions.get(rewrite.parent.id),
              }));
            }
          },
          afterCommit: () => {
            for (const update of boundaryUpdates) this.notifyAccepted(update);
          },
        };
      },
    };
  }

  /** Live observation records for one tree, delivered after each durable append. */
  subscribeObservations(tree: string, listener: (record: ObservationRecord) => void): () => void {
    const listeners = this.observationListeners.get(tree) ?? new Set();
    listeners.add(listener);
    this.observationListeners.set(tree, listeners);
    return () => listeners.delete(listener);
  }

  /** Retained observation records strictly after `cursor` for one tree. */
  observationsAfter(tree: string, cursor: string | null) {
    return this.observations.after(tree, cursor);
  }

  private recordObservation(tree: string, kind: string, change: unknown): ObservationRecord {
    return this.observations.append({ cursor: generateArborID("ob"), tree, kind, change, createdAt: Date.now() });
  }

  private notifyObservation(record: ObservationRecord): void {
    for (const listener of this.observationListeners.get(record.tree) ?? []) listener(record);
  }

  private notifyAccepted(update: AcceptedUpdate): void {
    const record = this.observations.get(update.id);
    if (record) this.notifyObservation(record);
  }

  async object(hash: ObjectHash): Promise<Uint8Array> {
    return this.objects.read(hash);
  }

  /** Verify SQLite plus every object reachable from retained accepted history. */
  async verifyIntegrity(): Promise<void> {
    const rows = this.db.query("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
      throw new Error("Canopy SQLite integrity check failed");
    }
    const roots = (this.db.query("SELECT DISTINCT root FROM accepted_updates").all() as Array<{ root: ObjectHash }>)
      .map(({ root }) => root);
    await this.objects.verifyReachable(roots);
  }

  async isReadableObject(treeID: string, hash: ObjectHash, account: CanopyAccount | null, linkDigest?: string): Promise<boolean> {
    const tree = this.get(treeID);
    return Boolean(tree && this.canRead(account, treeID, linkDigest) && await this.objects.contains(tree.ref, hash));
  }

  private async insertTree(
    canonicalPath: string,
    kind: TreeKind,
    snapshot: TreeSnapshot,
    publicAccess: AccessLevel,
    parentTree: string | null,
    withinTransaction?: (treeID: string) => void,
    credentialSubject?: string,
    requestedTreeID?: string,
    accountID?: string,
  ): Promise<CanopyTree> {
    const path = normalizeBoundaryPath(canonicalPath);
    await this.validateGraph(snapshot.root, snapshot.objects);
    await this.objects.store([...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
    const id = requestedTreeID ?? generateArborID("tr");
    if (this.db.query("SELECT 1 FROM trees WHERE id = ?").get(id)) throw new Error(`TreeID already exists: ${id}`);
    // Attaching a fresh tree is the single-addition boundary rewrite; a plain
    // entry already at that name is replaced by the nested-tree entry.
    const attachment = parentTree
      ? await this.prepareBoundaryRewrite(parentTree, [], [{ path, tree: id }], { replaceEntries: true })
      : null;
    if (attachment) {
      await this.cacheMembers(attachment.nextRoot, attachment.generated);
      await this.objects.store([...attachment.generated].map(([hash, bytes]) => ({ hash, bytes })));
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
      if (publicAccess !== "none") this.access.set(id, "everyone", "everyone", publicAccess);
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
    if (attachment) this.notifyAccepted(this.currentUpdate(attachment.parent.id)!);
    return this.get(id)!;
  }

  /** Regenerate a canonical parent's directories for removed and added nested-tree boundaries. */
  private async prepareBoundaryRewrite(
    parentTreeID: string,
    removals: BoundaryEdit[],
    additions: BoundaryEdit[],
    options: BoundaryRewriteOptions = {},
  ): Promise<{ parent: CanopyTree; nextRoot: ObjectHash; generated: Map<ObjectHash, Uint8Array> }> {
    const parent = this.get(parentTreeID);
    if (!parent?.canonicalPath) throw new Error(`Unknown or noncanonical parent tree: ${parentTreeID}`);
    const rewrite = await rewriteBoundaries(
      { ref: parent.ref, canonicalPath: parent.canonicalPath },
      removals,
      additions,
      (hash, generated) => this.objects.load(hash, generated),
      options,
    );
    return { parent, ...rewrite };
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
        const object = decodeWireObject(await this.objects.load(hash, proposed));
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
    const directory = decodeWireObject(await this.objects.load(root, proposed));
    if (directory.type !== "directory") throw new Error("Profile root must be a directory");
    const index = directory.entries.find((entry) => entry.name === "_index.md");
    if (!index?.hash) throw new Error("Profile tree requires _index.md");
    const file = decodeWireObject(await this.objects.load(index.hash, proposed));
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
    const directory = decodeWireObject(await this.objects.load(root, proposed));
    if (directory.type !== "directory") return;
    const index = directory.entries.find((entry) => entry.name === "_index.md");
    if (!index?.hash) return;
    const file = decodeWireObject(await this.objects.load(index.hash, proposed));
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

  private async validateGraph(root: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array>): Promise<void> {
    const pending = [root];
    const seen = new Set<ObjectHash>();
    let totalBytes = 0;
    while (pending.length) {
      const hash = pending.pop()!;
      if (seen.has(hash)) continue;
      seen.add(hash);
      if (seen.size > 100_000) throw new Error("Tree exceeds the object quota");
      const bytes = await this.objects.find(hash, proposed);
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
            const targetBytes = await this.objects.find(target, proposed);
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

  async [Symbol.asyncDispose](): Promise<void> {
    await this.wireSchemas[Symbol.asyncDispose]();
    this.db.close();
    this.observationListeners.clear();
  }
}

function dirnameURL(path: string): string {
  const segments = pathSegments(path);
  if (segments.length <= 1) return "/";
  return `/${segments.slice(0, -1).join("/")}`;
}
