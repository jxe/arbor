import { link, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  accountChallengeBytes,
  personProfileTreeID,
  stableJSONString,
  generateArborID,
  isGeneratedArborID,
  isPersonProfileTreeID,
  sha256,
  validateAccountChallenge,
  type AccountChallenge,
  type AccessLevel,
  type AccessRule,
  type ReadWriteAccess,
} from "@arbor/core";
import { parseMarkdown } from "@arbor/editor";
import { decodeWireCollectionFile, SchemaSandbox } from "@arbor/stores";
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
import {
  authorizeAccountConfigTransitionV2,
  mergeAccountConfigGraphsV2,
  readAccountConfigGraphV2,
  snapshotAccountConfigV2,
  type AccountConfigGraphV2,
} from "./account-policy-v2.ts";
import { reconcileUpdate, type MergeStrategy } from "./updates/reconcile.ts";
import { effectiveOnConflict } from "@arbor/wire";
import { AcceptedUpdateStore, type AcceptedUpdateInput } from "./updates/store.ts";
import { ObservationLog, type ObservationRecord } from "./updates/observations.ts";
import { buildAcceptedTransitionPayload } from "./updates/transition.ts";
import { ObjectStore } from "./objects.ts";
import { AccessControl } from "./access.ts";
import { AccountDirectory } from "./accounts.ts";
import { rootProfileFacts } from "./profile.ts";
import type { CanonicalBoundary, CanopyAccessEntry, CanopyAccount, CanopyAuthentication, CanopyTree } from "./model.ts";
import { normalizeBoundaryPath, pathSegments, rewriteBoundaries, type BoundaryEdit, type BoundaryRewriteOptions } from "./boundaries.ts";
import { openCanopyDatabase } from "./schema.ts";

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
    profileTree: string;
    name?: string;
  };
}

const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const TREE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

type AnyAccountConfigGraph = AccountConfigGraph | AccountConfigGraphV2;

function v2Graph(graph: AnyAccountConfigGraph): graph is AccountConfigGraphV2 {
  return !("version" in graph.account);
}

function graphTrees(graph: AnyAccountConfigGraph): Record<string, { canonicalPath: string; access: AccessRule[] }> {
  if (!v2Graph(graph)) return graph.trees.trees;
  return Object.fromEntries(Object.entries(graph.trees).map(([id, declaration]) => [id, {
    canonicalPath: new URL(declaration.canonical).pathname,
    access: declaration.access,
  }]));
}

function graphAdministrators(graph: AnyAccountConfigGraph): string[] {
  return v2Graph(graph)
    ? Object.values(graph.devices).filter((device) => device.administrator).map((device) => device.id)
    : graph.account.admins;
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

function profileSource(
  kind: "person" | "group",
  name: string,
  members: Array<string | { profile?: string; handle?: string }> = [],
): string {
  return [
    "---",
    `type: ${kind}`,
    ...(kind === "group"
      ? ["members:", ...members.flatMap((member) => typeof member === "string"
          ? [`  - ${JSON.stringify(member)}`]
          : [
              "  -",
              ...(member.profile ? [`    profile: ${JSON.stringify(member.profile)}`] : []),
              ...(member.handle ? [`    handle: ${JSON.stringify(member.handle)}`] : []),
            ])]
      : []),
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}

export { CANOPY_SCHEMA_VERSION, assertCanopySchemaVersion, assertCurrentCanopySchema } from "./schema.ts";

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
  constructor(readonly code: "base-not-retained" | "server-busy" | "activation-conflict", message: string) {
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
      rootProfileType: (id) => {
        const tree = this.get(id);
        return tree ? this.rootProfileType(tree.ref) : null;
      },
    });
  }

  static async open(dataRoot: string, bootstrap?: CanopyBootstrap): Promise<CanopyDaemon> {
    await mkdir(join(dataRoot, "objects"), { recursive: true });
    const databasePath = join(dataRoot, "canopy.sqlite3");
    const db = openCanopyDatabase(databasePath);
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
    if (config.firstWriter && !isPersonProfileTreeID(config.firstWriter.profileTree)) {
      throw new Error("First-writer profile must be a self-certifying person Profile TreeID");
    }
    const preparedAccounts = config.accounts.map((account) => ({ account, profileTree: generateArborID("tr") }));
    const members: Array<{ profile?: string; handle: string }> = [
      ...preparedAccounts.map(({ account, profileTree }) => ({
        profile: `arbor://${profileTree}/`,
        handle: account.handle,
      })),
      ...(config.firstWriter ? [{ profile: `arbor://${config.firstWriter.profileTree}/`, handle: config.firstWriter.handle }] : []),
    ];
    const community = await this.insertTree(
      "/",
      directSnapshot(profileSource("group", config.name, members)),
      "read",
      null,
    );
    this.db.run("INSERT INTO meta (key, value) VALUES ('community_handle', ?)", [config.handle]);
    this.db.run("INSERT INTO meta (key, value) VALUES ('community_name', ?)", [config.name]);
    if (config.firstWriter) {
      this.db.run("INSERT INTO meta (key, value) VALUES ('first_writer_handle', ?)", [config.firstWriter.handle]);
    }
    for (const { account, profileTree } of preparedAccounts) {
      if (!HANDLE.test(account.handle)) throw new Error(`Invalid account handle: ${account.handle}`);
      const profile = await this.insertTree(
        `/~${account.handle}`,
        directSnapshot(profileSource("person", account.name ?? account.handle)),
        "read",
        community.id,
        undefined,
        undefined,
        profileTree,
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
      public_access: AccessLevel | null;
      policy: CanopyTree["policy"];
      status: CanopyTree["status"];
      account_id: string | null;
    };
    return {
      id: row.id,
      canonicalPath: row.path,
      parentTree: row.parent_tree,
      kind: row.policy.startsWith("account-config-") ? "account-configuration" : "ordinary",
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
      SELECT t.*, b.path, b.parent_tree,
        COALESCE((SELECT access FROM access
          WHERE tree_id = t.id AND subject_kind = 'everyone' AND subject = 'everyone'), 'none') AS public_access
      FROM trees t LEFT JOIN boundaries b ON b.tree_id = t.id
      ${where}
    `;
    return this.treeRow(value === undefined ? this.db.query(sql).get() : this.db.query(sql).get(value));
  }

  list(): CanopyTree[] {
    return this.db.query(`
      SELECT t.*, b.path, b.parent_tree,
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

  createAccountChallenge(input: {
    origin: string;
    account: string;
    profileTree: string;
    configurationTree: string;
  }): AccountChallenge {
    const reservation = this.accountReservation(input.account);
    if (!reservation?.profileTree || reservation.profileTree !== input.profileTree) {
      throw new Error("Account challenge requires an exact profile reservation");
    }
    if (!isPersonProfileTreeID(input.profileTree)) throw new Error("Account challenge requires a self-certifying person Profile TreeID");
    if (!isGeneratedArborID(input.configurationTree, "tr")) throw new Error("Account challenge requires a generated configuration TreeID");
    if (new URL(input.origin).origin !== input.origin || new URL(input.account).origin !== input.origin) {
      throw new Error("Account challenge target must use canonical Canopy URLs");
    }
    if (this.accountByHandle(reservation.handle) || this.boundary(`/~${reservation.handle}`)) throw new AlreadyClaimedError(reservation.handle);
    const issuedAt = Date.now();
    const challenge: AccountChallenge = {
      version: 1,
      id: generateArborID("ax"),
      origin: input.origin,
      account: input.account,
      profileTree: input.profileTree,
      configurationTree: input.configurationTree,
      nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
      issuedAt,
      expiresAt: issuedAt + 5 * 60 * 1000,
    };
    this.db.run(
      "INSERT INTO account_challenges (id, challenge_json, expires_at) VALUES (?, ?, ?)",
      [challenge.id, stableJSONString(challenge), challenge.expiresAt],
    );
    return challenge;
  }

  private verifyAccountIdentityProof(input: {
    accountLocator: string;
    profileTree: string;
    configurationTree: string;
    challenge: AccountChallenge;
    publicKey: string;
    signature: string;
  }): { challenge: AccountChallenge; proofDigest: string } {
    const challenge = validateAccountChallenge(input.challenge);
    if (
      challenge.account !== input.accountLocator
      || challenge.origin !== new URL(input.accountLocator).origin
      || challenge.profileTree !== input.profileTree
      || challenge.configurationTree !== input.configurationTree
    ) throw new Error("Account challenge does not match the claim");
    const publicKey = Buffer.from(input.publicKey, "base64url");
    const signature = Buffer.from(input.signature, "base64url");
    if (publicKey.byteLength !== 32 || publicKey.toString("base64url") !== input.publicKey) throw new Error("Account claim public key is invalid");
    if (signature.byteLength !== 64 || signature.toString("base64url") !== input.signature) throw new Error("Account claim signature is invalid");
    if (personProfileTreeID(publicKey) !== input.profileTree) throw new Error("Account claim public key derives another Profile TreeID");
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]);
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    if (!verify(null, accountChallengeBytes(challenge), key, signature)) throw new Error("Account claim signature is invalid");
    return { challenge, proofDigest: sha256(stableJSONString({ challenge, publicKey: input.publicKey, signature: input.signature })) };
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
    const tokenDigest = input.credentialDigest.slice("sha256:".length);
    const pairing = this.accounts.pairing(id);
    const secretMatches = pairing?.secretMatches(secret) ?? false;
    if (pairing?.claimedAt && pairing.claimedDevice === input.deviceID) {
      const replay = this.accounts.deviceBinding(input.deviceID, pairing.accountID);
      if (replay?.tokenDigest === tokenDigest && replay.label === safeLabel && secretMatches) {
        return { device: this.accounts.device(input.deviceID)!, confirmationCode: pairing.confirmationCode };
      }
    }
    if (this.accounts.deviceExists(input.deviceID)) {
      throw new Error(`Retired DeviceID cannot be reused: ${input.deviceID}`);
    }
    if (!pairing || !pairing.accountEnabled || pairing.claimedAt || pairing.expiresAt <= Date.now() || !secretMatches) {
      throw new Error("Pairing is invalid, expired, or already used");
    }
    const account = this.account(pairing.accountID)!;
    const current = await this.accountConfigGraph(account);
    if (current.devices[input.deviceID]) throw new Error("DeviceID is already active");
    const next = v2Graph(current)
      ? {
          account: current.account,
          trees: current.trees,
          devices: {
            ...current.devices,
            [input.deviceID]: { id: input.deviceID, label: safeLabel, administrator: false },
          },
        }
      : {
          account: current.account,
          trees: current.trees,
          devices: {
            ...current.devices,
            [input.deviceID]: { version: 1 as const, id: input.deviceID, label: safeLabel, placements: input.placements },
          },
        };
    const nextSnapshot = v2Graph(current)
      ? snapshotAccountConfigV2(next as Omit<AccountConfigGraphV2, "sources">)
      : snapshotAccountConfig(next as Omit<AccountConfigGraph, "sources">);
    if (v2Graph(current)) readAccountConfigGraphV2(nextSnapshot, account.configTree!);
    else readAccountConfigGraph(nextSnapshot, account.configTree!);
    await this.objects.store([...nextSnapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
    const configTree = this.get(account.configTree!)!;
    const transition = await this.acceptedTransitionPayload(configTree.ref, nextSnapshot.root);
    const now = Date.now();
    const accepted = this.acceptedStore.commit({
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
      && this.communityAccountReservations().has(handle);
  }

  accountReservation(locator: string): { handle: string; profileTree?: string } | null {
    let url: URL;
    try { url = new URL(locator); } catch { return null; }
    const host = (this.db.query("SELECT value FROM meta WHERE key = 'community_host'").get() as { value: string } | null)?.value;
    const match = /^\/~([a-z0-9][a-z0-9-]{0,62})\/?$/.exec(url.pathname);
    if (!match || !host || url.host.toLowerCase() !== host) return null;
    const reservation = this.communityAccountReservations().get(match[1]!);
    return reservation ? { handle: match[1]!, ...reservation } : null;
  }

  private firstWriterHandle(): string | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = 'first_writer_handle'").get() as { value: string } | null;
    return row?.value ?? null;
  }

  setCommunityHost(host: string, allowTestPortChange = false): void {
    this.accounts.setCommunityHost(host, allowTestPortChange);
  }

  writableProfiles(account: CanopyAccount): CanopyTree[] {
    return this.list().filter((tree) =>
      tree.policy === "ordinary"
      && this.rootProfileType(tree.ref) !== null
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

  private applyAccountConfigDerived(accountID: string, current: AnyAccountConfigGraph, next: AnyAccountConfigGraph): void {
    const now = Date.now();
    for (const id of Object.keys(current.devices)) {
      if (!next.devices[id]) this.db.run("UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND account_id = ?", [now, id, accountID]);
    }
    for (const id of Object.keys(next.devices)) {
      const row = this.db.query("SELECT revoked_at FROM devices WHERE id = ? AND account_id = ?").get(id, accountID) as { revoked_at: number | null } | null;
      if (!row) throw new Error(`Device ${id} has no credential binding`);
      if (row.revoked_at !== null) throw new Error(`Retired DeviceID cannot be reactivated: ${id}`);
    }
    const currentTrees = graphTrees(current);
    const nextTrees = graphTrees(next);
    for (const id of Object.keys(currentTrees)) {
      if (!nextTrees[id]) {
        const reservation = this.db.query("SELECT status FROM tree_reservations WHERE id = ? AND account_id = ?").get(id, accountID) as { status: string } | null;
        if (reservation?.status === "awaiting-initialization") this.db.run("DELETE FROM tree_reservations WHERE id = ?", [id]);
        else {
          const active = this.get(id);
          if (!active || active.policy !== "ordinary" || active.accountID !== accountID) {
            throw new Error(`Account cannot retire tree declaration: ${id}`);
          }
          this.db.run("DELETE FROM access WHERE tree_id = ?", [id]);
          this.db.run("DELETE FROM boundaries WHERE tree_id = ?", [id]);
          this.db.run("UPDATE trees SET status = 'retired', updated_at = ? WHERE id = ?", [now, id]);
        }
      }
    }
    for (const [id, declaration] of Object.entries(nextTrees)) {
      const active = this.get(id);
      if (!active) {
        this.db.run(`INSERT INTO tree_reservations (id, account_id, canonical_path, status, error)
          VALUES (?, ?, ?, 'awaiting-initialization', NULL)
          ON CONFLICT(id) DO UPDATE SET canonical_path = excluded.canonical_path`,
        [id, accountID, declaration.canonicalPath]);
        continue;
      }
      if (active.status === "retired") throw new Error(`Retired TreeID cannot be reactivated: ${id}`);
      if (active.policy !== "ordinary") throw new Error(`Configuration may not declare governed tree ${id}`);
      const boundary = this.boundary(declaration.canonicalPath);
      if (boundary && boundary.id !== id) throw new Error(`Canonical boundary is occupied: ${declaration.canonicalPath}`);
      const parent = this.resolve(dirnameURL(declaration.canonicalPath))?.tree;
      this.db.run("UPDATE boundaries SET path = ?, parent_tree = ? WHERE tree_id = ?", [
        declaration.canonicalPath, parent?.id ?? null, id,
      ]);
      this.db.run("DELETE FROM access WHERE tree_id = ?", [id]);
      for (const rule of declaration.access) {
        const subject = rule.subject.kind === "everyone" ? "everyone" : rule.subject.kind === "profile" ? rule.subject.tree : rule.subject.digest;
        this.access.set(id, rule.subject.kind, subject, rule.access);
      }
    }
  }

  private async accountConfigGraph(account: CanopyAccount): Promise<AnyAccountConfigGraph> {
    if (!account.configTree) throw new Error("Account configuration tree is missing");
    const tree = this.get(account.configTree);
    if (!tree) throw new Error("Account configuration tree is missing");
    const snapshot = await this.objects.completeSnapshot(tree.ref);
    return tree.policy === "account-config-v2"
      ? readAccountConfigGraphV2(snapshot, tree.id)
      : readAccountConfigGraph(snapshot, tree.id);
  }

  async activateTree(
    authentication: CanopyAuthentication,
    treeID: string,
    snapshot: TreeSnapshot,
  ): Promise<CanopyTree> {
    if (!isGeneratedArborID(treeID, "tr") && !isPersonProfileTreeID(treeID)) {
      throw new Error("New tree activation requires a generated TreeID");
    }
    const existing = this.get(treeID);
    if (existing) {
      if (existing.ref === snapshot.root) return existing;
      throw new UpdateProtocolError("activation-conflict", `TreeID is already active with different content: ${treeID}`);
    }
    const reservation = this.db.query("SELECT * FROM tree_reservations WHERE id = ?").get(treeID) as {
      account_id: string; canonical_path: string; status: string;
    } | null;
    if (!reservation || reservation.account_id !== authentication.account.id || reservation.status !== "awaiting-initialization") {
      throw new Error(`TreeID is not reserved for activation: ${treeID}`);
    }
    if (!authentication.device) throw new Error("An administrator device is required for activation");
    const config = await this.accountConfigGraph(authentication.account);
    if (!graphAdministrators(config).includes(authentication.device)) throw new Error("Only an administrator device may initialize a tree");
    if (!v2Graph(config) && !config.devices[authentication.device]?.placements[treeID]) throw new Error("The initializing administrator must place the tree");
    const declaration = graphTrees(config)[treeID];
    if (!declaration) throw new Error("Tree declaration disappeared before activation");
    const requiredType = this.requiredProfileType(treeID, declaration.canonicalPath);
    if (requiredType) await this.validateProfileSnapshot(snapshot, requiredType);
    const parent = this.resolve(dirnameURL(declaration.canonicalPath))?.tree;
    if (!parent) throw new Error("Canonical parent is unavailable");
    let statusEvent: ObservationRecord | undefined;
    const activated = await this.insertTree(
      declaration.canonicalPath,
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

  /**
   * Claim a Canopy-allocated account locator for a stable profile TreeID.
   * Profile content is deliberately absent: hosting it is the ordinary
   * declaration/activation workflow represented by trees.yaml.
   */
  async claimAccountWithConfiguration(input: {
    accountLocator: string;
    handle: string;
    origin: string;
    profileTree: string;
    configurationTree: string;
    challenge: AccountChallenge;
    publicKey: string;
    signature: string;
    deviceID: string;
    deviceLabel: string;
    credentialDigest: string;
    configurationSnapshot: TreeSnapshot;
  }): Promise<{ account: CanopyAccount; configuration: CanopyTree }> {
    const proof = this.verifyAccountIdentityProof(input);
    const claimDigest = sha256(stableJSONString({
      handle: input.handle,
      accountLocator: input.accountLocator,
      identityProof: proof.proofDigest,
      profileTree: input.profileTree,
      configurationTree: input.configurationTree,
      deviceID: input.deviceID,
      deviceLabel: input.deviceLabel,
      credentialDigest: input.credentialDigest,
      configurationRoot: input.configurationSnapshot.root,
    }));
    if (!HANDLE.test(input.handle)) throw new Error(`Invalid account handle: ${input.handle}`);
    const reservation = this.accountReservation(input.accountLocator);
    if (!reservation || reservation.handle !== input.handle) throw new Error("Account locator is not reserved by this community");
    if (!isPersonProfileTreeID(input.profileTree) || !isGeneratedArborID(input.configurationTree, "tr")) {
      throw new Error("Account join requires profile and configuration TreeIDs");
    }
    if (!isGeneratedArborID(input.deviceID, "dv")) throw new Error("Account join requires a client-generated 128-bit DeviceID");
    if (!/^sha256:[a-f0-9]{64}$/.test(input.credentialDigest)) throw new Error("Device credential digest is invalid");
    const prior = this.accountByHandle(input.handle);
    if (prior) {
      const row = this.db.query("SELECT claim_digest FROM accounts WHERE id = ?").get(prior.id) as { claim_digest: string | null };
      if (row.claim_digest === claimDigest) {
        return { account: prior, configuration: this.get(input.configurationTree)! };
      }
      throw new AlreadyClaimedError(input.handle);
    }
    const challengeRow = this.db.query("SELECT challenge_json, expires_at, consumed_at FROM account_challenges WHERE id = ?")
      .get(proof.challenge.id) as { challenge_json: string; expires_at: number; consumed_at: number | null } | null;
    if (!challengeRow || challengeRow.challenge_json !== stableJSONString(proof.challenge)) throw new Error("Account challenge is invalid");
    if (challengeRow.expires_at <= Date.now()) throw new Error("Account challenge is expired");
    if (challengeRow.consumed_at !== null) throw new Error("Account challenge was already consumed");
    if (this.boundary(`/~${input.handle}`)) throw new AlreadyClaimedError(input.handle);
    if (!this.communityMemberHandles().has(input.handle)) {
      throw new Error(`Profile is not reserved by the community: ~${input.handle}`);
    }
    await this.validateGraph(input.configurationSnapshot.root, input.configurationSnapshot.objects);
    const config = readAccountConfigGraphV2(input.configurationSnapshot, input.configurationTree);
    this.validateCurrentCanopyAccountPaths(input.handle, config);
    if (config.account.canopy !== new URL(input.origin).origin) throw new Error("account.yaml Canopy does not match the target server");
    if (config.account.profile !== input.profileTree) {
      throw new Error("account.yaml profile does not match the proven account identity");
    }
    if (Object.keys(config.devices).length !== 1 || !config.devices[input.deviceID] || config.devices[input.deviceID]!.label !== input.deviceLabel) {
      throw new Error("Initial configuration must contain exactly the joining device and matching label");
    }
    if (!config.devices[input.deviceID]!.administrator) throw new Error("The joining device must be the first administrator");
    const firstWriter = this.firstWriterHandle() === input.handle;
    await this.objects.store([...input.configurationSnapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
    const accountID = generateArborID("ac");
    const now = Date.now();
    this.db.transaction(() => {
      const consumed = this.db.run(
        "UPDATE account_challenges SET consumed_at = ?, claim_digest = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?",
        [now, claimDigest, proof.challenge.id, now],
      );
      if (consumed.changes !== 1) throw new Error("Account challenge was already consumed or expired");
      this.db.run(
        "INSERT INTO accounts (id, handle, profile_tree, config_tree, token_digest, claim_digest, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)",
        [accountID, input.handle, input.profileTree, input.configurationTree, input.credentialDigest.slice("sha256:".length), claimDigest],
      );
      this.db.run(
        "INSERT INTO devices (id, account_id, label, token_digest, created_at) VALUES (?, ?, ?, ?, ?)",
        [input.deviceID, accountID, input.deviceLabel, input.credentialDigest.slice("sha256:".length), now],
      );
      this.db.run(
        "INSERT INTO trees (id, ref, updated_at, policy, status, account_id) VALUES (?, ?, ?, 'account-config-v2', 'active', ?)",
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
      for (const [id, declaration] of Object.entries(config.trees)) {
        this.db.run(
          "INSERT INTO tree_reservations (id, account_id, canonical_path, status) VALUES (?, ?, ?, 'awaiting-initialization')",
          [id, accountID, new URL(declaration.canonical).pathname],
        );
      }
      if (firstWriter) {
        this.access.set(this.community().id, "profile", input.profileTree, "write");
        this.db.run("DELETE FROM meta WHERE key = 'first_writer_handle'");
      }
    })();
    return { account: this.account(accountID)!, configuration: this.get(input.configurationTree)! };
  }

  private insertAcceptedUpdate(input: AcceptedUpdateInput): AcceptedUpdate {
    return this.acceptedStore.insert(input);
  }

  /** Attach the transition from the candidate root to the accepted root whenever the two differ. */
  private async withReconciliation(
    result: UpdateResult,
    candidate: ObjectHash,
    proposed: ReadonlyMap<ObjectHash, Uint8Array>,
  ): Promise<UpdateResult> {
    if (result.update.root === candidate) return result;
    const reconciliation = await buildAcceptedTransitionPayload(candidate, result.update.root, (hash) => this.objects.load(hash, proposed));
    return { ...result, reconciliation };
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
    authentication?: CanopyAuthentication,
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
        authentication,
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
    authentication?: CanopyAuthentication,
  ): Promise<StoredUpdateResponse> {
    const requestDigest = updateRequestDigest(treeID, request);
    if (request.base === null) return this.activateFromUpdate(treeID, request, requestDigest, authentication);
    const tree = this.get(treeID);
    if (!tree) throw new Error(`Unknown tree: ${treeID}`);
    if (!this.canWrite(account, treeID, linkDigest)) throw new Error("Write access is not allowed");
    const baseUpdate = this.update(request.base);
    if (!baseUpdate || baseUpdate.tree !== treeID) {
      throw new UpdateProtocolError("base-not-retained", "Base update is not retained for this tree");
    }
    const baseRoot = baseUpdate.root;
    const policy = tree.policy.startsWith("account-config-")
      ? this.accountConfigPolicy(tree, request, baseRoot, account, credentialSubject)
      : this.ordinaryPolicy(tree, request, account, linkDigest, credentialSubject);
    const { subject } = policy;
    const proposed = new Map(request.objects.map(({ hash, bytes }) => [hash, bytes]));
    const replay = this.acceptedRequest(treeID, subject, requestDigest);
    if (replay) {
      return "error" in replay.result
        ? replay
        : { ...replay, result: await this.withReconciliation(replay.result, request.candidate, proposed) };
    }
    const reconstructed = await this.objects.reconstructDeltas(baseRoot, request.deltas, proposed);
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
        baseRoot,
        request.candidate,
        remoteTree.ref,
        (hash) => this.objects.load(hash, proposed),
        { ifMatch: request.ifMatch, onConflict: effectiveOnConflict(request), merge: policy.merge },
      );
      if (reconciled.outcome === "current") {
        return {
          status: 200,
          result: await this.withReconciliation(
            { outcome: "current", update: remoteUpdate, requestDigest, observedThrough: remoteUpdate.id },
            request.candidate,
            proposed,
          ),
        };
      }
      const nextRoot = reconciled.root;
      const kind: AcceptedUpdate["kind"] = reconciled.outcome === "merged" ? "merged" : "accepted";
      const merge = reconciled.outcome === "merged" ? reconciled.merge : undefined;
      const objects = new Map([...proposed, ...reconciled.generated]);
      if (reconciled.outcome === "rejected" || (reconciled.outcome === "merged" && reconciled.conflicts.length)) {
        const draft = {
          root: reconciled.root,
          ...(await buildAcceptedTransitionPayload(request.candidate, reconciled.root, (hash) => this.objects.load(hash, objects))),
        };
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
              base: baseRoot,
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
      const accepted = this.acceptedStore.commit({
        tree: treeID,
        root: nextRoot,
        previousRoot: remoteTree.ref,
        expectedRoot: remoteTree.ref,
        kind,
        acceptedAt: now,
        subject,
        baseRoot,
        candidateRoot: request.candidate,
        remoteRoot: remoteTree.ref,
        ...(merge ? { merge } : {}),
        requestDigest,
        transition,
      }, prepared.withinTransaction);
      if (!accepted) continue;
      prepared.afterCommit?.(accepted);
      this.notifyAccepted(accepted);
      return {
        status: 201,
        result: await this.withReconciliation(
          { outcome: kind === "merged" ? "merged" : "accepted", update: accepted, requestDigest, observedThrough: accepted.id },
          request.candidate,
          proposed,
        ),
      };
    }
    throw new UpdateProtocolError("server-busy", "Server update changed repeatedly during merge");
  }

  /**
   * A null base is the first update of a reserved tree: the complete initial
   * snapshot, admitted through the same request identity, replay, and result
   * shape as every later update.
   */
  private async activateFromUpdate(
    treeID: string,
    request: UpdateRequest,
    requestDigest: ObjectHash,
    authentication: CanopyAuthentication | undefined,
  ): Promise<StoredUpdateResponse> {
    if (!authentication) throw new Error("Account authentication is required to activate a tree");
    const existing = this.get(treeID);
    if (existing) {
      const current = this.currentUpdate(treeID);
      if (existing.ref === request.candidate && current) {
        return { status: 200, result: { outcome: "current", update: current, requestDigest, observedThrough: current.id } };
      }
      throw new UpdateProtocolError("activation-conflict", `TreeID is already active with different content: ${treeID}`);
    }
    const snapshot: TreeSnapshot = { root: request.candidate, objects: new Map(request.objects.map(({ hash, bytes }) => [hash, bytes])) };
    const tree = await this.activateTree(authentication, treeID, snapshot);
    const update = this.currentUpdate(tree.id);
    if (!update) throw new Error("Activation recorded no accepted update");
    return { status: 201, result: { outcome: "accepted", update, requestDigest, observedThrough: update.id } };
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
        const requiredType = this.requiredProfileType(tree.id, tree.canonicalPath);
        if (requiredType) await this.validateProfileRoot(root, objects, requiredType);
      },
      validateAccepted: async (remoteTree, root, objects) => {
        if (root === request.candidate) return;
        await this.validateGraph(root, objects);
        await this.validateReservedBoundaries(remoteTree, root, objects);
      },
      prepareCommit: async (remoteTree) => ({
        afterCommit: () => {
          if (remoteTree.canonicalPath === "/") this.reconcileCommunityAccounts();
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
    baseRoot: ObjectHash,
    account: CanopyAccount | null,
    credentialSubject: string | undefined,
  ): UpdatePolicy {
    if (!account || tree.accountID !== account.id || credentialSubject?.startsWith("device:") !== true) {
      throw new Error("An active account device is required for configuration updates");
    }
    const deviceID = credentialSubject.slice("device:".length);
    const v2 = tree.policy === "account-config-v2";
    const graphAt = async (root: ObjectHash, objects?: ReadonlyMap<ObjectHash, Uint8Array>): Promise<AnyAccountConfigGraph> => {
      const snapshot = await this.objects.completeSnapshot(root, objects);
      const graph = v2 ? readAccountConfigGraphV2(snapshot, tree.id) : readAccountConfigGraph(snapshot, tree.id);
      if (v2) this.validateCurrentCanopyAccountPaths(account.handle, graph as AccountConfigGraphV2, account);
      return graph;
    };
    let baseGraph: AnyAccountConfigGraph;
    let candidateGraph: AnyAccountConfigGraph;
    let currentGraph: AnyAccountConfigGraph;
    let nextGraph: AnyAccountConfigGraph;
    const authorize = (current: AnyAccountConfigGraph, next: AnyAccountConfigGraph, changesFrom: AnyAccountConfigGraph) => {
      if (v2) {
        authorizeAccountConfigTransitionV2(
          current as AccountConfigGraphV2,
          next as AccountConfigGraphV2,
          deviceID,
          changesFrom as AccountConfigGraphV2,
        );
      } else {
        authorizeAccountConfigTransition(
          current as AccountConfigGraph,
          next as AccountConfigGraph,
          deviceID,
          changesFrom as AccountConfigGraph,
        );
      }
    };
    return {
      subject: credentialSubject,
      conflict: { kind: "account-configuration", message: "The account configuration contains incompatible same-field edits" },
      validateCandidate: async (root, objects) => {
        candidateGraph = await graphAt(root, objects);
        baseGraph = await graphAt(baseRoot);
        const current = this.currentUpdate(tree.id);
        if (!current) throw new Error("Account configuration has no accepted update");
        authorize(await graphAt(current.root), candidateGraph, baseGraph);
      },
      merge: async (_base, _candidate, current, _load, _onConflict) => {
        const remoteGraph = await graphAt(current);
        const merged = v2
          ? mergeAccountConfigGraphsV2(
              baseGraph as AccountConfigGraphV2,
              candidateGraph as AccountConfigGraphV2,
              remoteGraph as AccountConfigGraphV2,
            )
          : mergeAccountConfigGraphs(
              baseGraph as AccountConfigGraph,
              candidateGraph as AccountConfigGraph,
              remoteGraph as AccountConfigGraph,
            );
        const snapshot = v2
          ? snapshotAccountConfigV2(merged.graph as Omit<AccountConfigGraphV2, "sources">)
          : snapshotAccountConfig(merged.graph as Omit<AccountConfigGraph, "sources">);
        return {
          root: snapshot.root,
          objects: snapshot.objects,
          summary: { version: v2 ? "account-config-v2" : "account-config-v1", mergedFields: merged.mergedFields },
          conflicts: merged.conflicts.map((path) => ({ path, reason: "account-configuration" as const })),
        };
      },
      validateAccepted: async (remoteTree, root, objects) => {
        currentGraph = await graphAt(remoteTree.ref);
        nextGraph = root === request.candidate ? candidateGraph : await graphAt(root, objects);
        authorize(currentGraph, nextGraph, currentGraph);
      },
      prepareCommit: async (_remoteTree, _root, now) => {
        const rewrites = await this.prepareAccountBoundaryRewrites(currentGraph, nextGraph);
        const transitions = new Map<string, AcceptedTransitionPayload>();
        for (const rewrite of rewrites) {
          await this.cacheRootProfile(rewrite.nextRoot, rewrite.generated);
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
    return this.observations.append({ tree, kind, change, createdAt: Date.now() });
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
      await this.cacheRootProfile(attachment.nextRoot, attachment.generated);
      await this.objects.store([...attachment.generated].map(([hash, bytes]) => ({ hash, bytes })));
    }
    const attachmentTransition = attachment
      ? await this.acceptedTransitionPayload(attachment.parent.ref, attachment.nextRoot)
      : null;
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run("INSERT INTO trees (id, ref, updated_at, account_id) VALUES (?, ?, ?, ?)", [id, snapshot.root, now, accountID ?? null]);
      this.db.run(
        "INSERT INTO boundaries (path, tree_id, parent_tree) VALUES (?, ?, ?)",
        [path, id, parentTree],
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

  private async prepareAccountBoundaryRewrites(current: AnyAccountConfigGraph, next: AnyAccountConfigGraph) {
    const grouped = new Map<string, { removals: Array<{ path: string; tree: string }>; additions: Array<{ path: string; tree: string }> }>();
    const group = (parent: string) => {
      const value = grouped.get(parent) ?? { removals: [], additions: [] };
      grouped.set(parent, value);
      return value;
    };
    const currentTrees = graphTrees(current);
    const nextTrees = graphTrees(next);
    for (const [id, declaration] of Object.entries(currentTrees)) {
      if (nextTrees[id]) continue;
      const active = this.get(id);
      if (!active?.parentTree) continue;
      group(active.parentTree).removals.push({ path: declaration.canonicalPath, tree: id });
    }
    for (const [id, declaration] of Object.entries(nextTrees)) {
      const before = currentTrees[id];
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
    const { frontmatter } = parseMarkdown(new TextDecoder().decode(file.bytes));
    if (frontmatter.type !== kind) throw new Error(`Profile root must declare type: ${kind}`);
  }

  /**
   * The two profile invariants the server enforces: an account's profile tree
   * keeps `type: person` and the community root keeps `type: group`. Every
   * other tree's `type:` is authored data the server does not validate.
   */
  private requiredProfileType(treeID: string, canonicalPath: string | null): "person" | "group" | null {
    if (canonicalPath === "/") return "group";
    if (this.db.query("SELECT 1 FROM accounts WHERE profile_tree = ?").get(treeID)) return "person";
    return null;
  }

  private profileMemberHandles(treeID: string): Set<string> {
    const tree = this.get(treeID);
    return tree ? this.memberHandlesFromRoot(tree.ref) : new Set();
  }

  private communityMemberHandles(): Set<string> {
    return this.memberHandlesFromRoot(this.community().ref);
  }

  /**
   * Graph validation caches each root's `_index.md` frontmatter profile facts
   * (`type` and the authored member locators) by immutable root hash, so
   * synchronous authorization never reparses mutable filesystem state or
   * treats display names as identity.
   */
  private rootProfile(root: ObjectHash): {
    type: "person" | "group" | null;
    members: Array<{ profile: string; handle?: string; legacy?: true }>;
  } {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(`profile:${root}`) as { value: string } | null;
    if (!row) return { type: null, members: [] };
    const value = JSON.parse(row.value) as { type?: unknown; members?: unknown };
    return {
      type: value.type === "person" || value.type === "group" ? value.type : null,
      members: Array.isArray(value.members) ? value.members.flatMap((member) => {
        if (typeof member === "string") return [{ profile: member, legacy: true as const }];
        if (!member || typeof member !== "object" || Array.isArray(member)) return [];
        const candidate = member as Record<string, unknown>;
        if (typeof candidate.profile !== "string") return [];
        return [{
          profile: candidate.profile,
          ...(typeof candidate.handle === "string" ? { handle: candidate.handle } : {}),
          ...(candidate.legacy === true ? { legacy: true as const } : {}),
        }];
      }) : [],
    };
  }

  /** The root document's `type: person` or `type: group`, or null when it declares neither. */
  rootProfileType(root: ObjectHash): "person" | "group" | null {
    return this.rootProfile(root).type;
  }

  private memberHandlesFromRoot(root: ObjectHash): Set<string> {
    const members = this.rootProfile(root).members;
    return new Set(members.flatMap((member) => {
      if (member.handle && HANDLE.test(member.handle)) return [member.handle];
      if (!member.legacy) return [];
      const match = /\/\~([a-z0-9][a-z0-9-]{0,62})\/?$/.exec(member.profile);
      return match ? [match[1]!] : [];
    }));
  }

  /** The current Canopy allocates all of one account's canonical paths below /~handle. */
  private validateCurrentCanopyAccountPaths(handle: string, graph: AccountConfigGraphV2, existingAccount?: CanopyAccount): void {
    const root = `/~${handle}`;
    for (const [treeID, declaration] of Object.entries(graph.trees)) {
      const path = new URL(declaration.canonical).pathname;
      const retainedAdministeredTree = existingAccount
        && this.get(treeID)?.canonicalPath === path
        && this.canAdminister(existingAccount, treeID);
      if (!sameOrDescendant(path, root) && !retainedAdministeredTree) {
        throw new Error(`Canonical path is outside this Canopy account allocation: ${path}`);
      }
    }
  }

  /** Current-Canopy allocation policy: structured local handles reserve /~handle. */
  private communityAccountReservations(): Map<string, { profileTree?: string }> {
    const reservations = new Map<string, { profileTree?: string }>();
    for (const member of this.rootProfile(this.community().ref).members) {
      const legacyHandle = member.legacy ? /\/\~([a-z0-9][a-z0-9-]{0,62})\/?$/.exec(member.profile)?.[1] : undefined;
      const handle = member.handle ?? legacyHandle;
      if (!handle || !HANDLE.test(handle)) continue;
      const profile = !member.legacy
        ? /^arbor:\/\/(tr_[a-z2-7]+)\/?$/.exec(member.profile)?.[1]
        : undefined;
      reservations.set(handle, profile ? { profileTree: profile } : {});
    }
    return reservations;
  }

  private async cacheRootProfile(root: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array>): Promise<void> {
    const facts = await rootProfileFacts(root, (hash) => this.objects.load(hash, proposed));
    this.db.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [`profile:${root}`, JSON.stringify(facts)],
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
      }
      if (object.childrenSource) {
        const loadFile = async (name: string): Promise<Uint8Array> => {
          const target = object.entries.find((entry) => entry.name === name)?.hash;
          if (!target) throw new Error(`Missing collection-file entry: ${name}`);
          const targetBytes = await this.objects.find(target, proposed);
          if (!targetBytes || hashObject(targetBytes) !== target) throw new Error(`Missing collection-file object: ${target}`);
          const targetObject = decodeWireObject(targetBytes);
          if (targetObject.type !== "file") throw new Error(`Collection-file source is not a file: ${target}`);
          return targetObject.bytes;
        };
        await decodeWireCollectionFile(
          object.childrenSource,
          await loadFile(object.childrenSource.source),
          await loadFile(object.childrenSource.schemaSource),
          this.wireSchemas,
        );
      }
    }
    await this.cacheRootProfile(root, proposed);
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
