import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { sha256 } from "@arbor/core";
import {
  decodeWireObject,
  encodeWireObject,
  hashObject,
  type ObjectHash,
  type TreeSnapshot,
  type WireDirectory,
  type WireDirectoryEntry,
} from "./objects.ts";
import { mergeWireTrees, type MergeSummary, type UpdateConflict } from "./merge.ts";

export type PublicAccess = "none" | "read" | "write";
export type TreeAccess = "read" | "write";
export type BoundaryKind =
  | "community-profile"
  | "person-profile"
  | "group-profile"
  | "shared-subtree";

export interface CanonicalBoundary {
  path: string;
  tree: string;
  parentTree: string | null;
  kind: BoundaryKind;
}

export interface AuthorityTree {
  id: string;
  canonicalPath: string;
  parentTree: string | null;
  kind: BoundaryKind;
  ref: ObjectHash;
  publicAccess: PublicAccess;
  updatedAt: number;
}

export interface AuthorityAccount {
  id: string;
  handle: string;
  profileTree: string | null;
  enabled: boolean;
}

export interface AuthorityAuthentication {
  account: AuthorityAccount;
  subject: string;
  device: string | null;
}

export interface AuthorityDevice {
  id: string;
  account: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface PairingOffer {
  id: string;
  secret: string;
  confirmationCode: string;
  expiresAt: number;
}

export interface AuthorityAccessEntry {
  id: string;
  tree: string;
  subjectKind: "everyone" | "profile" | "link";
  subject: string;
  access: TreeAccess;
  claimedProfile?: string;
}

export interface AcceptedUpdate {
  id: string;
  tree: string;
  root: ObjectHash;
  previousRoot: ObjectHash | null;
  kind: "initial" | "accepted" | "merged" | "restored";
  acceptedAt: number;
  subject: string | null;
  baseRoot?: ObjectHash;
  candidateRoot?: ObjectHash;
  remoteRoot?: ObjectHash;
  merge?: MergeSummary;
}

export interface UpdateRequest {
  base: { root: ObjectHash; update: string };
  candidate: ObjectHash;
  objects: Array<{ hash: ObjectHash; bytes: Uint8Array }>;
}

export type UpdateResult =
  | { outcome: "current"; current: AcceptedUpdate }
  | { outcome: "accepted"; update: AcceptedUpdate }
  | { outcome: "merged"; update: AcceptedUpdate; merge: MergeSummary };

export interface UpdateConflictResult {
  error: "conflict";
  message: string;
  retryable: false;
  current: AcceptedUpdate;
  base: ObjectHash;
  candidate: ObjectHash;
  draft: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: Uint8Array }> };
  conflicts: UpdateConflict[];
}

export interface StoredUpdateResponse {
  status: number;
  result: UpdateResult | UpdateConflictResult;
}

export interface CommunityBootstrapAccount {
  handle: string;
  token: string;
  name?: string;
  communityWriter?: boolean;
}

export interface CommunityBootstrap {
  handle: string;
  name: string;
  accounts: CommunityBootstrapAccount[];
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

export class RefConflictError extends Error {
  constructor(readonly current: ObjectHash | null) {
    super("Tree ref changed");
    this.name = "RefConflictError";
  }
}

export class UpdateProtocolError extends Error {
  constructor(readonly code: "mutation-mismatch" | "base-not-retained" | "authority-busy", message: string) {
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

export class WireAuthority implements AsyncDisposable {
  private db: Database;
  private listeners = new Map<string, Set<(tree: AuthorityTree, update: AcceptedUpdate) => void>>();
  private updateLocks = new Map<string, Promise<void>>();

  private constructor(readonly dataRoot: string, db: Database) {
    this.db = db;
  }

  static async open(dataRoot: string, bootstrap?: CommunityBootstrap): Promise<WireAuthority> {
    await mkdir(join(dataRoot, "objects"), { recursive: true });
    const db = new Database(join(dataRoot, "authority.sqlite3"), { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    const existingTreeColumns = db.query("PRAGMA table_info(trees)").all() as Array<{ name: string }>;
    const legacyTrees = existingTreeColumns.some((column) => column.name === "slug")
      ? db.query("SELECT id, slug, ref, publication, updated_at FROM trees ORDER BY slug").all() as Array<{
          id: string;
          slug: string;
          ref: string;
          publication: "private" | "public-read" | "public-write";
          updated_at: number;
        }>
      : [];
    if (legacyTrees.length || existingTreeColumns.some((column) => column.name === "slug")) {
      db.run("ALTER TABLE trees RENAME TO legacy_trees");
    }
    db.run(`
      CREATE TABLE IF NOT EXISTS trees (
        id TEXT PRIMARY KEY,
        ref TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS boundaries (
        path TEXT PRIMARY KEY,
        tree_id TEXT NOT NULL UNIQUE REFERENCES trees(id),
        parent_tree TEXT,
        kind TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS reflog (
        tree_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        previous_ref TEXT,
        changed_at INTEGER NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS accepted_updates (
        id TEXT PRIMARY KEY,
        tree_id TEXT NOT NULL REFERENCES trees(id),
        root TEXT NOT NULL,
        previous_root TEXT,
        kind TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        subject TEXT,
        base_root TEXT,
        candidate_root TEXT,
        remote_root TEXT,
        merge_summary TEXT
      )
    `);
    db.run("CREATE INDEX IF NOT EXISTS accepted_updates_tree_order ON accepted_updates(tree_id, accepted_at, id)");
    db.run(`
      CREATE TABLE IF NOT EXISTS update_replays (
        tree_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        base_update TEXT NOT NULL,
        base_root TEXT NOT NULL,
        candidate_root TEXT NOT NULL,
        status INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (tree_id, subject, idempotency_key)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE,
        profile_tree TEXT,
        token_digest TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS devices (
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
      CREATE TABLE IF NOT EXISTS pairings (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        secret_digest TEXT NOT NULL,
        confirmation_code TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        claimed_at INTEGER
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS access (
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
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    const authority = new WireAuthority(dataRoot, db);
    if (!authority.boundary("/")) {
      if (!bootstrap) throw new Error("A new Arbor authority requires community bootstrap configuration");
      await authority.bootstrap(bootstrap);
    }
    if (legacyTrees.length) {
      const migrationAccount = bootstrap?.accounts[0];
      if (!migrationAccount) throw new Error("Legacy authority migration requires one bootstrap account");
      await authority.migrateLegacyTrees(legacyTrees, migrationAccount.handle);
    }
    authority.upgradeAcceptedUpdatesAndDevices();
    return authority;
  }

  private upgradeAcceptedUpdatesAndDevices(): void {
    this.db.transaction(() => {
      const trees = this.db.query("SELECT id, ref, updated_at FROM trees ORDER BY id").all() as Array<{
        id: string;
        ref: ObjectHash;
        updated_at: number;
      }>;
      for (const tree of trees) {
        const existing = this.db.query("SELECT COUNT(*) AS count FROM accepted_updates WHERE tree_id = ?")
          .get(tree.id) as { count: number };
        if (existing.count) continue;
        const reflog = this.db.query(`
          SELECT ref, previous_ref, changed_at
          FROM reflog WHERE tree_id = ? ORDER BY changed_at, rowid
        `).all(tree.id) as Array<{ ref: ObjectHash; previous_ref: ObjectHash | null; changed_at: number }>;
        for (const row of reflog) {
          this.insertAcceptedUpdate({
            tree: tree.id,
            root: row.ref,
            previousRoot: row.previous_ref,
            kind: row.previous_ref === null ? "initial" : "accepted",
            acceptedAt: row.changed_at,
            subject: "migration",
          });
        }
        const lastRoot = reflog.at(-1)?.ref;
        if (lastRoot !== tree.ref) {
          this.insertAcceptedUpdate({
            tree: tree.id,
            root: tree.ref,
            previousRoot: lastRoot ?? null,
            kind: lastRoot === undefined ? "initial" : "accepted",
            acceptedAt: tree.updated_at,
            subject: "migration",
          });
        }
      }

      const accounts = this.db.query(`
        SELECT a.id, a.token_digest,
          COALESCE(MIN(t.updated_at), 0) AS created_at
        FROM accounts a
        LEFT JOIN trees t ON t.id = a.profile_tree
        WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.account_id = a.id)
        GROUP BY a.id, a.token_digest
        ORDER BY a.id
      `).all() as Array<{ id: string; token_digest: string; created_at: number }>;
      for (const account of accounts) {
        this.db.run(
          "INSERT INTO devices (id, account_id, label, token_digest, created_at) VALUES (?, ?, 'Initial device', ?, ?)",
          [opaqueID("dv"), account.id, account.token_digest, account.created_at],
        );
      }
    })();
  }

  private async migrateLegacyTrees(
    legacyTrees: Array<{
      id: string;
      slug: string;
      ref: string;
      publication: "private" | "public-read" | "public-write";
      updated_at: number;
    }>,
    accountHandle: string,
  ): Promise<void> {
    const profile = this.boundary(`/~${accountHandle}`);
    if (!profile) throw new Error(`Legacy migration profile is missing: ~${accountHandle}`);
    for (const legacy of legacyTrees) {
      const path = `/~${accountHandle}/${legacy.slug}`;
      const attachment = await this.prepareBoundaryAttachment(profile.id, path, legacy.id);
      await this.cacheMembers(attachment.nextRoot, attachment.generated);
      await this.storeObjects([...attachment.generated].map(([hash, bytes]) => ({ hash, bytes })));
      const now = Date.now();
      this.db.transaction(() => {
        this.db.run("INSERT INTO trees (id, ref, updated_at) VALUES (?, ?, ?)", [
          legacy.id,
          legacy.ref,
          legacy.updated_at,
        ]);
        this.insertAcceptedUpdate({
          tree: legacy.id,
          root: legacy.ref,
          previousRoot: null,
          kind: "initial",
          acceptedAt: legacy.updated_at,
          subject: "migration",
        });
        this.db.run(
          "INSERT INTO boundaries (path, tree_id, parent_tree, kind) VALUES (?, ?, ?, 'shared-subtree')",
          [path, legacy.id, profile.id],
        );
        if (legacy.publication !== "private") {
          this.setAccessInternal(
            legacy.id,
            "everyone",
            "everyone",
            legacy.publication === "public-write" ? "write" : "read",
          );
        }
        const result = this.db.run("UPDATE trees SET ref = ?, updated_at = ? WHERE id = ? AND ref = ?", [
          attachment.nextRoot,
          now,
          profile.id,
          attachment.parent.ref,
        ]);
        if (result.changes !== 1) throw new RefConflictError(this.get(profile.id)?.ref ?? null);
        this.db.run(
          "INSERT INTO reflog (tree_id, ref, previous_ref, changed_at) VALUES (?, ?, ?, ?)",
          [profile.id, attachment.nextRoot, attachment.parent.ref, now],
        );
        this.insertAcceptedUpdate({
          tree: profile.id,
          root: attachment.nextRoot,
          previousRoot: attachment.parent.ref,
          kind: "accepted",
          acceptedAt: now,
          subject: "migration",
        });
      })();
    }
  }

  private async bootstrap(config: CommunityBootstrap): Promise<void> {
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

  private treeRow(value: unknown): AuthorityTree | null {
    if (!value) return null;
    const row = value as {
      id: string;
      ref: string;
      updated_at: number;
      path: string;
      parent_tree: string | null;
      kind: BoundaryKind;
      public_access: PublicAccess | null;
    };
    return {
      id: row.id,
      canonicalPath: row.path,
      parentTree: row.parent_tree,
      kind: row.kind,
      ref: row.ref,
      publicAccess: row.public_access ?? "none",
      updatedAt: row.updated_at,
    };
  }

  private treeSelect(where: string, value?: string): AuthorityTree | null {
    const sql = `
      SELECT t.*, b.path, b.parent_tree, b.kind,
        COALESCE((SELECT access FROM access
          WHERE tree_id = t.id AND subject_kind = 'everyone' AND subject = 'everyone'), 'none') AS public_access
      FROM trees t JOIN boundaries b ON b.tree_id = t.id
      ${where}
    `;
    return this.treeRow(value === undefined ? this.db.query(sql).get() : this.db.query(sql).get(value));
  }

  list(): AuthorityTree[] {
    return this.db.query(`
      SELECT t.*, b.path, b.parent_tree, b.kind,
        COALESCE((SELECT access FROM access
          WHERE tree_id = t.id AND subject_kind = 'everyone' AND subject = 'everyone'), 'none') AS public_access
      FROM trees t JOIN boundaries b ON b.tree_id = t.id
      ORDER BY b.path
    `).all().map((row) => this.treeRow(row)!);
  }

  get(id: string): AuthorityTree | null {
    return this.treeSelect("WHERE t.id = ?", id);
  }

  private updateRow(value: unknown): AcceptedUpdate | null {
    if (!value) return null;
    const row = value as {
      id: string;
      tree_id: string;
      root: ObjectHash;
      previous_root: ObjectHash | null;
      kind: AcceptedUpdate["kind"];
      accepted_at: number;
      subject: string | null;
      base_root: ObjectHash | null;
      candidate_root: ObjectHash | null;
      remote_root: ObjectHash | null;
      merge_summary: string | null;
    };
    return {
      id: row.id,
      tree: row.tree_id,
      root: row.root,
      previousRoot: row.previous_root,
      kind: row.kind,
      acceptedAt: row.accepted_at,
      subject: row.subject,
      ...(row.base_root ? { baseRoot: row.base_root } : {}),
      ...(row.candidate_root ? { candidateRoot: row.candidate_root } : {}),
      ...(row.remote_root ? { remoteRoot: row.remote_root } : {}),
      ...(row.merge_summary ? { merge: JSON.parse(row.merge_summary) as MergeSummary } : {}),
    };
  }

  currentUpdate(treeID: string): AcceptedUpdate | null {
    return this.updateRow(this.db.query(
      "SELECT * FROM accepted_updates WHERE tree_id = ? ORDER BY accepted_at DESC, rowid DESC LIMIT 1",
    ).get(treeID));
  }

  update(id: string): AcceptedUpdate | null {
    return this.updateRow(this.db.query("SELECT * FROM accepted_updates WHERE id = ?").get(id));
  }

  updates(treeID: string, cursor?: string, limit = 100): { updates: AcceptedUpdate[]; cursor: string | null } {
    const bounded = Math.max(1, Math.min(limit, 100));
    const cursorRow = cursor
      ? this.db.query("SELECT accepted_at, rowid FROM accepted_updates WHERE id = ? AND tree_id = ?").get(cursor, treeID) as { accepted_at: number; rowid: number } | null
      : null;
    if (cursor && !cursorRow) throw new Error("Invalid update cursor");
    const rows = (cursorRow
      ? this.db.query(`SELECT * FROM accepted_updates WHERE tree_id = ? AND (accepted_at > ? OR (accepted_at = ? AND rowid > ?)) ORDER BY accepted_at, rowid LIMIT ?`)
        .all(treeID, cursorRow.accepted_at, cursorRow.accepted_at, cursorRow.rowid, bounded + 1)
      : this.db.query("SELECT * FROM accepted_updates WHERE tree_id = ? ORDER BY accepted_at, rowid LIMIT ?").all(treeID, bounded + 1));
    const page = rows.slice(0, bounded).map((row) => this.updateRow(row)!);
    return { updates: page, cursor: rows.length > bounded ? page.at(-1)!.id : null };
  }

  boundary(path: string): AuthorityTree | null {
    return this.treeSelect("WHERE b.path = ?", normalizeBoundaryPath(path));
  }

  resolve(path: string): { tree: AuthorityTree; path: string } | null {
    const canonical = normalizeBoundaryPath(path);
    const candidates = this.list()
      .filter((tree) => sameOrDescendant(canonical, tree.canonicalPath))
      .sort((a, b) => b.canonicalPath.length - a.canonicalPath.length);
    const tree = candidates[0];
    if (!tree) return null;
    const remainder = canonical === tree.canonicalPath
      ? "/"
      : canonical.slice(tree.canonicalPath === "/" ? 0 : tree.canonicalPath.length);
    return { tree, path: remainder || "/" };
  }

  account(id: string): AuthorityAccount | null {
    const row = this.db.query("SELECT * FROM accounts WHERE id = ?").get(id) as
      | { id: string; handle: string; profile_tree: string | null; enabled: number }
      | null;
    return row
      ? { id: row.id, handle: row.handle, profileTree: row.profile_tree, enabled: row.enabled === 1 }
      : null;
  }

  authenticateToken(token: string | undefined): AuthorityAuthentication | null {
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

  accountByToken(token: string | undefined): AuthorityAccount | null {
    return this.authenticateToken(token)?.account ?? null;
  }

  private deviceRow(value: unknown): AuthorityDevice | null {
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

  devices(account: AuthorityAccount): AuthorityDevice[] {
    return this.db.query("SELECT * FROM devices WHERE account_id = ? ORDER BY created_at, id")
      .all(account.id).map((row) => this.deviceRow(row)!);
  }

  createPairing(account: AuthorityAccount): PairingOffer {
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

  claimPairing(id: string, secret: string, label: string): { token: string; device: AuthorityDevice } {
    const safeLabel = label.trim();
    if (!safeLabel || safeLabel.length > 100) throw new Error("Device label is required and must be at most 100 characters");
    const pairing = this.db.query(`
      SELECT p.*, a.enabled AS account_enabled
      FROM pairings p JOIN accounts a ON a.id = p.account_id
      WHERE p.id = ?
    `).get(id) as {
      account_id: string;
      secret_digest: string;
      expires_at: number;
      claimed_at: number | null;
      account_enabled: number;
    } | null;
    const presentedDigest = Buffer.from(sha256(secret));
    const expectedDigest = pairing ? Buffer.from(pairing.secret_digest) : Buffer.alloc(presentedDigest.length);
    const secretMatches = presentedDigest.length === expectedDigest.length && timingSafeEqual(presentedDigest, expectedDigest);
    if (!pairing || pairing.account_enabled !== 1 || pairing.claimed_at || pairing.expires_at <= Date.now() || !secretMatches) {
      throw new Error("Pairing is invalid, expired, or already used");
    }
    const token = `arb_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const deviceID = opaqueID("dv");
    const now = Date.now();
    this.db.transaction(() => {
      const claimed = this.db.run("UPDATE pairings SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL AND expires_at > ?", [
        now,
        id,
        now,
      ]);
      if (claimed.changes !== 1) throw new Error("Pairing is invalid, expired, or already used");
      this.db.run(
        "INSERT INTO devices (id, account_id, label, token_digest, created_at) VALUES (?, ?, ?, ?, ?)",
        [deviceID, pairing.account_id, safeLabel, sha256(token), now],
      );
    })();
    return { token, device: this.deviceRow(this.db.query("SELECT * FROM devices WHERE id = ?").get(deviceID))! };
  }

  revokeDevice(account: AuthorityAccount, deviceID: string): AuthorityDevice {
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

  accountByHandle(handle: string): AuthorityAccount | null {
    const row = this.db.query("SELECT id FROM accounts WHERE handle = ?").get(handle) as { id: string } | null;
    return row ? this.account(row.id) : null;
  }

  resetAccountToken(handle: string, token: string): AuthorityAccount {
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

  community(): AuthorityTree {
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

  writableProfiles(account: AuthorityAccount): AuthorityTree[] {
    return this.list().filter((tree) =>
      ["community-profile", "person-profile", "group-profile"].includes(tree.kind)
      && this.canWrite(account, tree.id)
    );
  }

  accessEntries(tree: string): AuthorityAccessEntry[] {
    return this.db.query("SELECT * FROM access WHERE tree_id = ? ORDER BY subject_kind, subject")
      .all(tree)
      .map((row) => {
        const value = row as {
          id: string;
          tree_id: string;
          subject_kind: AuthorityAccessEntry["subjectKind"];
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
    account: AuthorityAccount,
    treeID: string,
    subjectKind: AuthorityAccessEntry["subjectKind"],
    subject: string,
    access: TreeAccess | "none",
  ): AuthorityTree {
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

  removeAccess(account: AuthorityAccount, treeID: string, accessID: string): AuthorityTree {
    if (!this.canAdminister(account, treeID)) throw new Error("Access administration is not allowed");
    const result = this.db.run("DELETE FROM access WHERE id = ? AND tree_id = ?", [accessID, treeID]);
    if (result.changes !== 1) throw new Error("Unknown access entry");
    return this.get(treeID)!;
  }

  clearAccess(account: AuthorityAccount, treeID: string): AuthorityTree {
    if (!this.canAdminister(account, treeID)) throw new Error("Access administration is not allowed");
    this.db.run(
      "DELETE FROM access WHERE tree_id = ? AND NOT (subject_kind = 'profile' AND subject = ?)",
      [treeID, account.profileTree],
    );
    return this.get(treeID)!;
  }

  private setAccessInternal(
    treeID: string,
    subjectKind: AuthorityAccessEntry["subjectKind"],
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

  canRead(account: AuthorityAccount | null, treeID: string, linkDigest?: string): boolean {
    const tree = this.get(treeID);
    if (!tree) return false;
    if (tree.publicAccess === "read" || tree.publicAccess === "write") return true;
    if (linkDigest && this.linkAccess(linkDigest, treeID) !== "none") return true;
    return account ? this.effectiveAccess(account, treeID) !== "none" : false;
  }

  canWrite(account: AuthorityAccount | null, treeID: string, linkDigest?: string): boolean {
    const tree = this.get(treeID);
    if (!tree) return false;
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

  canAdminister(account: AuthorityAccount, treeID: string): boolean {
    const tree = this.get(treeID);
    if (!tree || !account.profileTree) return false;
    if (tree.kind === "person-profile" && tree.id === account.profileTree) return true;
    return this.directAccess(account.profileTree, treeID) === "write";
  }

  private directAccess(profileTree: string, treeID: string): TreeAccess | "none" {
    const row = this.db.query(
      "SELECT access FROM access WHERE tree_id = ? AND subject_kind = 'profile' AND subject = ?",
    ).get(treeID, profileTree) as { access: TreeAccess } | null;
    return row?.access ?? "none";
  }

  private effectiveAccess(account: AuthorityAccount, treeID: string): TreeAccess | "none" {
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
    account: AuthorityAccount,
    canonicalPath: string,
    kind: Exclude<BoundaryKind, "community-profile">,
    snapshot: TreeSnapshot,
    publicAccess: PublicAccess = "none",
    profileAccess: Array<{ profile: string; access: TreeAccess }> = [],
    credentialSubject?: string,
  ): Promise<AuthorityTree> {
    const path = normalizeBoundaryPath(canonicalPath);
    if (this.boundary(path)) throw new Error(`Canonical boundary already exists: ${path}`);
    if (this.list().some((boundary) => boundary.canonicalPath.startsWith(`${path}/`))) {
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
      let ancestor: AuthorityTree | null = parent;
      while (ancestor && ancestor.kind === "shared-subtree") {
        ancestor = ancestor.parentTree ? this.get(ancestor.parentTree) : null;
      }
      if (
        !ancestor
        || !["person-profile", "group-profile"].includes(ancestor.kind)
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
    );
  }

  async claim(handle: string, snapshot: TreeSnapshot): Promise<{ account: AuthorityAccount; token: string; tree: AuthorityTree }> {
    if (!HANDLE.test(handle)) throw new Error(`Invalid profile handle: ${handle}`);
    if (this.accountByHandle(handle) || this.boundary(`/~${handle}`)) throw new AlreadyClaimedError(handle);
    if (!this.communityMemberHandles().has(handle)) throw new Error(`Profile is not reserved by the community: ~${handle}`);
    await this.validateProfileSnapshot(snapshot, "person");
    const token = `arb_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const accountID = opaqueID("ac");
    const deviceID = opaqueID("dv");
    const parent = this.community();
    let tree: AuthorityTree;
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

  private insertAcceptedUpdate(input: {
    tree: string;
    root: ObjectHash;
    previousRoot: ObjectHash | null;
    kind: AcceptedUpdate["kind"];
    acceptedAt: number;
    subject?: string | null;
    baseRoot?: ObjectHash;
    candidateRoot?: ObjectHash;
    remoteRoot?: ObjectHash;
    merge?: MergeSummary;
  }): AcceptedUpdate {
    const id = opaqueID("up");
    this.db.run(`
      INSERT INTO accepted_updates
        (id, tree_id, root, previous_root, kind, accepted_at, subject, base_root, candidate_root, remote_root, merge_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      input.tree,
      input.root,
      input.previousRoot,
      input.kind,
      input.acceptedAt,
      input.subject ?? null,
      input.baseRoot ?? null,
      input.candidateRoot ?? null,
      input.remoteRoot ?? null,
      input.merge ? JSON.stringify(input.merge) : null,
    ]);
    return this.update(id)!;
  }

  private replayResult(row: { status: number; result_json: string }): StoredUpdateResponse {
    return { status: row.status, result: JSON.parse(row.result_json) as UpdateResult };
  }

  private storeReplay(
    tree: string,
    subject: string,
    key: string,
    request: UpdateRequest,
    response: StoredUpdateResponse,
  ): void {
    if ("error" in response.result) throw new Error("Rejected updates are never stored in the authority replay cache");
    this.db.run(`
      INSERT INTO update_replays
        (tree_id, subject, idempotency_key, base_update, base_root, candidate_root, status, result_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      tree,
      subject,
      key,
      request.base.update,
      request.base.root,
      request.candidate,
      response.status,
      JSON.stringify(response.result),
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ]);
  }

  async submitUpdate(
    treeID: string,
    request: UpdateRequest,
    idempotencyKey: string,
    account: AuthorityAccount | null = null,
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
        idempotencyKey,
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
    idempotencyKey: string,
    account: AuthorityAccount | null = null,
    linkDigest?: string,
    credentialSubject?: string,
  ): Promise<StoredUpdateResponse> {
    if (!idempotencyKey || idempotencyKey.length > 200) throw new Error("A bounded Idempotency-Key is required");
    const tree = this.get(treeID);
    if (!tree) throw new Error(`Unknown tree: ${treeID}`);
    if (!this.canWrite(account, treeID, linkDigest)) throw new Error("Write access is not allowed");
    const subject = credentialSubject ?? (account ? `account:${account.id}` : linkDigest ? `link:${linkDigest}` : "public");
    this.db.run("DELETE FROM update_replays WHERE expires_at <= ?", [Date.now()]);
    const replay = this.db.query(`
      SELECT base_update, base_root, candidate_root, status, result_json
      FROM update_replays WHERE tree_id = ? AND subject = ? AND idempotency_key = ?
    `).get(treeID, subject, idempotencyKey) as {
      base_update: string;
      base_root: string;
      candidate_root: string;
      status: number;
      result_json: string;
    } | null;
    if (replay) {
      if (
        replay.base_update !== request.base.update
        || replay.base_root !== request.base.root
        || replay.candidate_root !== request.candidate
      ) throw new UpdateProtocolError("mutation-mismatch", "Idempotency-Key was already used with different update intent");
      return this.replayResult(replay);
    }
    const baseUpdate = this.update(request.base.update);
    if (!baseUpdate || baseUpdate.tree !== treeID || baseUpdate.root !== request.base.root) {
      throw new UpdateProtocolError("base-not-retained", "Base update is not retained for this tree and root");
    }
    const proposed = new Map(request.objects.map(({ hash, bytes }) => [hash, bytes]));
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
      if (request.candidate === remoteTree.ref || request.candidate === request.base.root) {
        const response: StoredUpdateResponse = { status: 200, result: { outcome: "current", current: remoteUpdate } };
        this.db.transaction(() => this.storeReplay(treeID, subject, idempotencyKey, request, response))();
        return response;
      }

      let nextRoot = request.candidate;
      let kind: AcceptedUpdate["kind"] = "accepted";
      let merge: MergeSummary | undefined;
      let generated = new Map<ObjectHash, Uint8Array>();
      if (remoteTree.ref !== request.base.root) {
        const merged = await mergeWireTrees(
          request.base.root,
          request.candidate,
          remoteTree.ref,
          (hash) => this.loadObject(hash, proposed),
        );
        nextRoot = merged.root;
        merge = merged.summary;
        generated = merged.objects;
        if (merged.conflicts.length) {
          const draft = await this.completeSnapshot(merged.root, new Map([...proposed, ...merged.objects]));
          const response: StoredUpdateResponse = {
            status: 409,
            result: {
              error: "conflict",
              message: "The candidate could not be merged safely",
              retryable: false,
              current: remoteUpdate,
              base: request.base.root,
              candidate: request.candidate,
              draft: { root: draft.root, objects: [...draft.objects].map(([hash, bytes]) => ({ hash, bytes })) },
              conflicts: merged.conflicts,
            },
          };
          return response;
        }
        kind = "merged";
        const mergedObjects = new Map([...proposed, ...generated]);
        await this.validateGraph(nextRoot, mergedObjects);
        await this.validateReservedBoundaries(remoteTree, nextRoot, mergedObjects);
      }
      await this.storeObjects(request.objects);
      await this.storeObjects([...generated].map(([hash, bytes]) => ({ hash, bytes })));
      const now = Date.now();
      let accepted: AcceptedUpdate | null = null;
      try {
        this.db.transaction(() => {
          const result = this.db.run("UPDATE trees SET ref = ?, updated_at = ? WHERE id = ? AND ref = ?", [
            nextRoot,
            now,
            treeID,
            remoteTree.ref,
          ]);
          if (result.changes !== 1) throw new RefConflictError(this.get(treeID)?.ref ?? null);
          this.db.run("INSERT INTO reflog (tree_id, ref, previous_ref, changed_at) VALUES (?, ?, ?, ?)", [
            treeID,
            nextRoot,
            remoteTree.ref,
            now,
          ]);
          accepted = this.insertAcceptedUpdate({
            tree: treeID,
            root: nextRoot,
            previousRoot: remoteTree.ref,
            kind,
            acceptedAt: now,
            subject,
            baseRoot: request.base.root,
            candidateRoot: request.candidate,
            remoteRoot: remoteTree.ref,
            ...(merge ? { merge } : {}),
          });
          const response: StoredUpdateResponse = kind === "merged"
            ? { status: 201, result: { outcome: "merged", update: accepted!, merge: merge! } }
            : { status: 201, result: { outcome: "accepted", update: accepted! } };
          this.storeReplay(treeID, subject, idempotencyKey, request, response);
        })();
      } catch (error) {
        if (error instanceof RefConflictError) continue;
        throw error;
      }
      if (remoteTree.kind === "community-profile") this.reconcileCommunityAccounts();
      const updatedTree = this.get(treeID)!;
      for (const listener of this.listeners.get(treeID) ?? []) listener(updatedTree, accepted!);
      return kind === "merged"
        ? { status: 201, result: { outcome: "merged", update: accepted!, merge: merge! } }
        : { status: 201, result: { outcome: "accepted", update: accepted! } };
    }
    throw new UpdateProtocolError("authority-busy", "Authority update changed repeatedly during merge");
  }

  subscribe(id: string, listener: (tree: AuthorityTree, update: AcceptedUpdate) => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => listeners.delete(listener);
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
        for (const entry of object.entries) if (entry.hash) pending.push(entry.hash);
      }
    }
    return { root, objects };
  }

  /** Verify SQLite plus every object reachable from retained accepted history. */
  async verifyIntegrity(): Promise<void> {
    const rows = this.db.query("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
      throw new Error("Authority SQLite integrity check failed");
    }
    const pending = (this.db.query("SELECT DISTINCT root FROM accepted_updates").all() as Array<{ root: ObjectHash }>)
      .map(({ root }) => root);
    const seen = new Set<ObjectHash>();
    while (pending.length) {
      const hash = pending.pop()!;
      if (seen.has(hash)) continue;
      seen.add(hash);
      const object = decodeWireObject(await this.object(hash));
      if (object.type === "directory") {
        for (const entry of object.entries) if (entry.hash) pending.push(entry.hash);
      }
    }
  }

  async isReadableObject(hash: ObjectHash, account: AuthorityAccount | null, linkDigest?: string): Promise<boolean> {
    for (const tree of this.list()) {
      if (this.canRead(account, tree.id, linkDigest) && await this.graphContains(tree.ref, hash)) return true;
      if (!this.canWrite(account, tree.id, linkDigest)) continue;
      const roots = this.db.query("SELECT DISTINCT root FROM accepted_updates WHERE tree_id = ?")
        .all(tree.id) as Array<{ root: ObjectHash }>;
      for (const accepted of roots) if (await this.graphContains(accepted.root, hash)) return true;
    }
    return false;
  }

  private async insertTree(
    canonicalPath: string,
    kind: BoundaryKind,
    snapshot: TreeSnapshot,
    publicAccess: PublicAccess,
    parentTree: string | null,
    withinTransaction?: (treeID: string) => void,
    credentialSubject?: string,
  ): Promise<AuthorityTree> {
    const path = normalizeBoundaryPath(canonicalPath);
    await this.validateGraph(snapshot.root, snapshot.objects);
    await this.storeObjects([...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
    const id = opaqueID("tr");
    const attachment = parentTree ? await this.prepareBoundaryAttachment(parentTree, path, id) : null;
    if (attachment) {
      await this.cacheMembers(attachment.nextRoot, attachment.generated);
      await this.storeObjects([...attachment.generated].map(([hash, bytes]) => ({ hash, bytes })));
    }
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run("INSERT INTO trees (id, ref, updated_at) VALUES (?, ?, ?)", [id, snapshot.root, now]);
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
  ): Promise<{ parent: AuthorityTree; nextRoot: ObjectHash; generated: Map<ObjectHash, Uint8Array> }> {
    const parent = this.get(parentTreeID);
    if (!parent) throw new Error(`Unknown parent tree: ${parentTreeID}`);
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
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const bytes = encodeWireObject({ type: "directory", entries } satisfies WireDirectory);
      const nextHash = hashObject(bytes);
      generated.set(nextHash, bytes);
      return nextHash;
    };
    const nextRoot = await replace(parent.ref, relativeSegments);
    return { parent, nextRoot, generated };
  }

  private async validateReservedBoundaries(
    parent: AuthorityTree,
    root: ObjectHash,
    proposed: ReadonlyMap<ObjectHash, Uint8Array>,
  ): Promise<void> {
    const children = this.db.query(
      "SELECT path, tree_id FROM boundaries WHERE parent_tree = ? ORDER BY length(path)",
    ).all(parent.id) as Array<{ path: string; tree_id: string }>;
    for (const child of children) {
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
        for (const entry of object.entries) if (entry.hash) pending.push(entry.hash);
      }
    }
    return false;
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
        if (entry.hash) pending.push(entry.hash);
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
    this.db.close();
    this.listeners.clear();
  }
}

function dirnameURL(path: string): string {
  const segments = pathSegments(path);
  if (segments.length <= 1) return "/";
  return `/${segments.slice(0, -1).join("/")}`;
}
