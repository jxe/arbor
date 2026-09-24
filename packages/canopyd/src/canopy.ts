import { EntryMetadataStore, entryChanges, type EntryChanges } from "./updates/entry-metadata.ts";
import { AuthenticationRequiredError, NotFoundError, PermissionDeniedError } from "./errors.ts";
import { validateGraphChange, type ValidatedGraph } from "./updates/graph-validation.ts";
import { ExecutionAuthority } from "./execution-authority.ts";
import { resourceEffects, type ResourceEffect } from "./resource-effects.ts";
import { SemanticMerge, type StateRef, type Evaluated } from "./updates/semantic-merge.ts";
import { IntentError } from "@overstory/canopyd-merge/intent-model";
import type { CheckpointRequest } from "@overstory/canopyd-merge";
import { MergeTool, type MergeToolOptions } from "./merge-tool.ts";
import { changedEntryPaths } from "./updates/tree-diff.ts";
import type { DecisionPage } from "@overstory/protocol";
import { mkdir } from "node:fs/promises";
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
} from "@overstory/protocol";
import { parseMarkdown, resourceRuleFromLegacy } from "@overstory/protocol";
import { decodeWireCollectionFile, SchemaSandbox } from "@overstory/apps-runtime/collections";
import {
  validateUpdateRequestIntent,
  compareWireNames,
  decodeWireDirectory,
  encodeWireDirectory,
  hashObject,
  updateRequestDigests,
  type AcceptedTransition,
  type AcceptedTransitionPayload,
  type AcceptedUpdate,
  type ServerDevice,
  type ObjectHash,
  type PairingOffer,
  type TreeSnapshot,
  type CandidateUpdate,
  type UpdateConflictResult,
  type UpdateRequest,
  type UpdateResponse,
  type UpdateResult,
  type WireDirectoryEntry,
} from "@overstory/protocol";
import {
  authorizeAccountConfigTransitionV2,
  readAccountConfigGraphV2,
  snapshotAccountConfigV2,
  type AccountConfigGraphV2,
} from "./account-policy-v2.ts";
import { reconcileUpdate, type MergeStrategy } from "./updates/reconcile.ts";
import { AcceptedUpdateStore } from "./updates/store.ts";
import { ObservationLog, type ObservationRecord } from "./updates/observations.ts";
import { buildAcceptedTransitionPayload } from "./updates/transition.ts";
import { ObjectStore } from "@overstory/object-store";
import { AccessControl, accessRule } from "./access.ts";
import { AccountDirectory } from "./accounts.ts";
import { HANDLE, legacyMemberHandle, profileLocatorTree, recordProfileFacts, rootProfileFacts, storedProfileFacts, type RootProfileFacts } from "./profile.ts";
import { isAccountConfigPolicy, type CanopyAccessEntry, type CanopyAccount, type CanopyAuthentication, type CanopyTree } from "./model.ts";
import { normalizeBoundaryPath, pathSegments, rewriteBoundaries, type BoundaryEdit, type BoundaryRewriteOptions } from "./boundaries.ts";
import { openCanopyDatabase, resourcePolicyFormatKey } from "./schema.ts";
import { markPhase, phaseTimer } from "./updates/timing.ts";

export type { CanopyAccessEntry, CanopyAccount, CanopyAuthentication, CanopyTree } from "./model.ts";

export interface StoredUpdateResponse {
  status: number;
  result: UpdateResponse | UpdateConflictResult;
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

/** The authorization-relevant profile facts of one immutable root. */
interface RootProfile {
  type: "person" | "group" | null;
  members: Array<{ profile: string; handle?: string; legacy?: true }>;
  /** Community reservations: structured handles plus legacy `/~handle` locators. */
  handles: ReadonlySet<string>;
  /** Group membership for access: the Profile TreeID each member locator names. */
  profiles: ReadonlySet<string>;
  /** Group membership for access by a legacy `/~handle` locator alone. */
  legacyHandles: ReadonlySet<string>;
}
const ROOT_PROFILE_LIMIT = 1024;
/** Watch replay derives each update's transition from two roots; every
 * watcher of a tree replays the same recent updates. */
const TRANSITION_CACHE_ENTRIES = 32;

/** Structured handles, plus the handle of a legacy `/~handle` locator. */
function memberHandles(members: RootProfile["members"]): ReadonlySet<string> {
  return new Set(members.flatMap((member) => {
    if (member.handle && HANDLE.test(member.handle)) return [member.handle];
    const handle = legacyMemberHandle(member);
    return handle ? [handle] : [];
  }));
}

/** The Profile TreeID of every `arbor://<TreeID>/` member locator. */
function memberProfiles(members: RootProfile["members"]): ReadonlySet<string> {
  return new Set(members.flatMap((member) => {
    const profile = profileLocatorTree(member.profile);
    return profile ? [profile] : [];
  }));
}

/** One tree row with its boundary and public access, as `treeRow` reads it. */
const TREE_SELECT = `
  SELECT t.*, b.path, b.parent_tree,
    COALESCE((SELECT access FROM access
      WHERE tree_id = t.id AND subject_kind = 'everyone' AND subject = 'everyone'), 'none') AS public_access
  FROM trees t LEFT JOIN boundaries b ON b.tree_id = t.id`;

/** One page of an accepted state's decisions: `after` resumes a page, `conflict` selects one decision. */
function decisionPage<T extends { id: string }>(
  decisions: T[],
  tree: string,
  state: string,
  after: string | undefined,
  conflict: string | undefined,
): { selected: T[]; next: string | null } | null {
  let offset = 0;
  if (after !== undefined) {
    try {
      const token = JSON.parse(Buffer.from(after, "base64url").toString());
      if (token.tree !== tree || token.state !== state || !Number.isSafeInteger(token.offset) || token.offset <= 0 || token.offset >= decisions.length) throw new Error();
      offset = token.offset;
    } catch { throw new Error("Invalid conflict page token"); }
  }
  const selected = conflict === undefined ? decisions.slice(offset, offset + 32) : decisions.filter((d) => d.id === conflict);
  if (conflict !== undefined && !selected.length) return null;
  const next = conflict === undefined && offset + selected.length < decisions.length
    ? Buffer.from(JSON.stringify({ tree, state, offset: offset + selected.length })).toString("base64url")
    : null;
  return { selected, next };
}

function graphTrees(graph: AccountConfigGraphV2): Record<string, { canonicalPath: string; access: AccessRule[] }> {
  return Object.fromEntries(Object.entries(graph.trees).map(([id, declaration]) => [id, {
    canonicalPath: new URL(declaration.canonical).pathname,
    access: declaration.access,
  }]));
}

function graphAdministrators(graph: AccountConfigGraphV2): string[] {
  return Object.values(graph.devices).filter((device) => device.administrator).map((device) => device.id);
}

/** The name in a path's leading /~name segment, if it has one. */
function accountName(path: string): string | undefined {
  return /^\/~([a-z0-9][a-z0-9-]{0,62})(?:\/|$)/.exec(path)?.[1];
}

function sameOrDescendant(path: string, parent: string): boolean {
  return path === parent || parent === "/" || path.startsWith(`${parent}/`);
}

function directSnapshot(source: string): TreeSnapshot {
  const fileBytes = new TextEncoder().encode(source);
  const fileHash = hashObject(fileBytes);
  const rootBytes = encodeWireDirectory({
    type: "directory",
    entries: [{ name: "_index.md", file: fileHash }],
  });
  const rootHash = hashObject(rootBytes);
  return { root: rootHash, objects: new Map([[fileHash, fileBytes], [rootHash, rootBytes]]) };
}

function profileSource(
  kind: "person" | "group",
  name: string,
  members: Array<string | { profile?: string; handle?: string }> = [],
  displayName: string | undefined = name,
): string {
  return [
    "---",
    `type: ${kind}`,
    ...(displayName ? [`displayName: ${JSON.stringify(displayName)}`] : []),
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
  rejection?: { kind: "account-configuration"; message: string };
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
  constructor(readonly code: "base-not-retained" | "server-busy" | "activation-conflict" | "unsupported-operation", message: string) {
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
  private readonly validatedGraphs = new Map<string, ValidatedGraph>();
  /** Parsed profile facts by immutable root hash (`rootProfile`). */
  private readonly rootProfiles = new Map<ObjectHash, RootProfile>();
  private db: Database;
  private acceptedStore: AcceptedUpdateStore;
  private readonly observations: ObservationLog;
  private readonly objects: ObjectStore;
  private readonly mergeTool: MergeTool;
  private readonly semantic: SemanticMerge;
  private readonly access: AccessControl;
  readonly execution: ExecutionAuthority;
  private readonly accounts: AccountDirectory;
  private observationListeners = new Map<string, Set<(record: ObservationRecord) => void>>();
  private updateLocks = new Map<string, Promise<void>>();
  /** Recently replayed transitions by update id (`acceptedTransition`). */
  private readonly transitions = new Map<string, AcceptedTransitionPayload>();

  private constructor(
    readonly dataRoot: string,
    db: Database,
    mergeTool?: MergeToolOptions
  ) {
    this.db = db;
    this.objects = new ObjectStore(join(dataRoot, "objects"), { cacheBytes: objectCacheBytes() });
    this.mergeTool = new MergeTool(dataRoot, {
      onTiming: (phase, ms) => phaseTimer()?.add(`worker-${phase}`, ms),
      onCount: (name, value) => phaseTimer()?.count(name, value),
      objects: this.objects,
      historyCacheBytes: megabytes("ARBOR_HISTORY_CACHE_MB", 256),
      stateProofBytes: megabytes("ARBOR_STATE_PROOF_MB", 64),
      validationMillis: Number(process.env.ARBOR_STATE_VALIDATION_MS) > 0 ? Number(process.env.ARBOR_STATE_VALIDATION_MS) : 60_000,
      ...mergeTool,
    });
    this.semantic = new SemanticMerge(
      db,
      this.mergeTool,
      (hash, objects) => this.objects.load(hash, objects),
    );
    this.acceptedStore = new AcceptedUpdateStore(db);
    this.observations = new ObservationLog(db);
    this.accounts = new AccountDirectory(db);
    this.access = new AccessControl(db, {
      tree: (id) => this.get(id),
      isProfileMember: (group, profileTree, handle) => this.isProfileMember(group, profileTree, handle),
      rootProfileType: (id) => {
        const tree = this.get(id);
        return tree ? this.rootProfileType(tree.ref) : null;
      },
    });
    this.execution = new ExecutionAuthority((context, grant, path, operation) => this.access.executionAllows(context, grant, path, operation));
  }

  static async open(dataRoot: string, bootstrap?: CanopyBootstrap, mergeTool?: MergeToolOptions): Promise<CanopyDaemon> {
    await mkdir(join(dataRoot, "objects"), { recursive: true });
    const databasePath = join(dataRoot, "canopy.sqlite3");
    const db = openCanopyDatabase(databasePath);
    const canopy = new CanopyDaemon(dataRoot, db, mergeTool);
    await canopy.mergeTool.clearStaleJobs();
    if (!process.env.ARBOR_CANOPY_NO_WARMUP && process.env.NODE_ENV !== "test") canopy.warmSemanticStates();
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
        "INSERT INTO accounts (id, handle, profile_tree, enabled) VALUES (?, ?, ?, 1)",
        [accountID, account.handle, profile.id],
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
      kind: isAccountConfigPolicy(row.policy) ? "account-configuration" : "ordinary",
      ref: row.ref,
      publicAccess: row.public_access ?? "none",
      updatedAt: row.updated_at,
      policy: row.policy,
      status: row.status,
      accountID: row.account_id,
    };
  }

  private treeSelect(where: string, value?: string): CanopyTree | null {
    const sql = `${TREE_SELECT} ${where}`;
    return this.treeRow(value === undefined ? this.db.query(sql).get() : this.db.query(sql).get(value));
  }

  list(): CanopyTree[] {
    return this.db.query(`${TREE_SELECT} ORDER BY b.path IS NULL, b.path`).all().map((row) => this.treeRow(row)!);
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

  private matchingRequestDigest(updateID: string, credentialSubject?: string): ObjectHash | null {
    return credentialSubject ? this.acceptedStore.matchingRequestDigest(updateID, credentialSubject) : null;
  }

  /** One accepted update's transition from its predecessor, derived from the
   * two roots (as `netAcceptedTransition` derives a backlog's) and cached,
   * since every watcher of a tree replays the same update. Null for a tree's
   * first retained update, which has no predecessor. */
  async acceptedTransition(updateID: string, credentialSubject?: string): Promise<AcceptedTransition | null> {
    const update = this.update(updateID);
    if (!update?.previous) return null;
    let payload = this.transitions.get(update.id);
    if (payload) this.transitions.delete(update.id);
    else {
      try { payload = await this.acceptedTransitionPayload(update.previous.root, update.root); }
      catch { return null; }
    }
    this.transitions.set(update.id, payload);
    while (this.transitions.size > TRANSITION_CACHE_ENTRIES) this.transitions.delete(this.transitions.keys().next().value!);
    const requestDigest = credentialSubject && update.subject === credentialSubject
      ? this.matchingRequestDigest(updateID, credentialSubject)
      : null;
    return { update, ...payload, ...(requestDigest ? { requestDigest } : {}) };
  }

  /** Capture both endpoints before reading immutable objects; later appends remain queued. */
  async netAcceptedTransition(tree: string, after: number, credentialSubject?: string): Promise<{record: ObservationRecord; transition: AcceptedTransition} | null> {
    const basisRecord = this.observations.atOrBefore(tree, after);
    const tip = this.observations.atOrBefore(tree, this.observations.position(tree, null).through);
    const basis = basisRecord?.updateID ? this.update(basisRecord.updateID) : null;
    const update = tip?.updateID ? this.update(tip.updateID) : null;
    if (!basis || !update || !tip || tip.ordinal <= after) return null;
    const requestDigest = this.matchingRequestDigest(update.id, credentialSubject);
    const payload = await this.acceptedTransitionPayload(basis.root, update.root);
    return {record: tip, transition: {update, from: {id: basis.id, root: basis.root}, ...payload,
      ...(requestDigest ? {requestDigest} : {})}};
  }

  /** Decision inspection is pinned to one retained accepted state. */
  conflictPage(
    tree: string,
    state: string,
    after?: string,
    conflict?: string
  ): DecisionPage | null {
    const update = this.update(state);
    if (!update || update.tree !== tree) return null;
    const semantic = this.semantic.store.get(state);
    if (!semantic) return null;
    const page = decisionPage(semantic.decisions.map((d) => d.inspection), tree, state, after, conflict);
    if (!page) return null;
    return { tree, state, root: update.root, conflicted: update.conflicted, decisions: page.selected, next: page.next };
  }

  /** Complete graph for one retained accepted root, without exposing history metadata. */
  async snapshotForRoot(treeID: string, root: ObjectHash): Promise<TreeSnapshot | null> {
    if (!this.acceptedStore.hasRoot(treeID, root)) return null;
    return this.objects.completeSnapshot(root);
  }

  /** Descriptive metadata of the current accepted root's file entries, keyed
   * by entry path. Not part of any hash; read in one turn with its update. */
  entryMetadata(treeID: string): { update: string; entries: Record<string, { modifiedAt: number }> } | null {
    const current = this.acceptedStore.current(treeID);
    if (!current) return null;
    const entries: Record<string, { modifiedAt: number }> = {};
    for (const [path, entry] of new EntryMetadataStore(this.db).entries(treeID)) entries[path] = { modifiedAt: entry.modifiedAt };
    return { update: current.id, entries };
  }

  boundary(path: string): CanopyTree | null {
    return this.treeSelect("WHERE b.path = ?", normalizeBoundaryPath(path));
  }

  /** The tree whose canonical boundary most closely encloses `path`, and the path within it. */
  resolve(path: string): { tree: CanopyTree; path: string } | null {
    const canonical = normalizeBoundaryPath(path);
    // Only the path itself and its ancestors can enclose it; the longest wins.
    const segments = canonical.split("/").filter(Boolean);
    const enclosing = ["/", ...segments.map((_, index) => `/${segments.slice(0, index + 1).join("/")}`)];
    const tree = this.treeRow(this.db.query(
      `${TREE_SELECT} WHERE b.path IN (${enclosing.map(() => "?").join(", ")}) ORDER BY length(b.path) DESC LIMIT 1`,
    ).get(...enclosing));
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

  authenticationIsActive(authentication: CanopyAuthentication): boolean {
    if (!authentication.device) return false;
    const device = this.accounts.device(authentication.device);
    return Boolean(device && device.account === authentication.account.id && device.revokedAt === null && authentication.account.enabled);
  }

  devices(account: CanopyAccount): ServerDevice[] {
    return this.accounts.devices(account);
  }

  createPairing(account: CanopyAccount): PairingOffer {
    return this.accounts.createPairing(account);
  }

  createAccountChallenge(input: {
    origin: string;
    account?: string;
    profileTree: string;
    configurationTree: string;
  }): AccountChallenge {
    const matches = input.account === undefined
      ? [...this.communityAccountReservations()].filter(([, value]) => value.profileTree === input.profileTree)
      : [];
    if (input.account === undefined && matches.length !== 1) {
      throw new Error(matches.length ? "Several reservations match this identity; enter an exact account URL" : "This community has not reserved an account for this identity");
    }
    const account = input.account ?? `${input.origin}/~${matches[0]![0]}`;
    const reservation = this.accountReservation(account);
    if (!reservation?.profileTree || reservation.profileTree !== input.profileTree) {
      throw new Error("Account challenge requires an exact profile reservation");
    }
    if (!isPersonProfileTreeID(input.profileTree)) throw new Error("Account challenge requires a self-certifying person Profile TreeID");
    if (!isGeneratedArborID(input.configurationTree, "tr")) throw new Error("Account challenge requires a generated configuration TreeID");
    if (new URL(input.origin).origin !== input.origin || new URL(account).origin !== input.origin) {
      throw new Error("Account challenge target must use canonical Canopy URLs");
    }
    if (this.accountByHandle(reservation.handle) || this.nameHeldByTree(reservation.handle)) throw new AlreadyClaimedError(reservation.handle);
    const issuedAt = Date.now();
    const challenge: AccountChallenge = {
      version: 1,
      id: generateArborID("ax"),
      origin: input.origin,
      account,
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
    const expectedUpdate = this.currentUpdate(account.configTree!)!.id;
    const current = await this.accountConfigGraph(account);
    if (current.devices[input.deviceID]) throw new Error("DeviceID is already active");
    const next = { ...current, devices: {
      ...current.devices,
      [input.deviceID]: { id: input.deviceID, label: safeLabel, administrator: false },
    } };
    const nextSnapshot = snapshotAccountConfigV2(next);
    readAccountConfigGraphV2(nextSnapshot, account.configTree!);
    const configTree = this.get(account.configTree!)!;
    const staged = new Map(nextSnapshot.objects);
    const mergeState = await this.semantic.checkpoint(configTree.id, this.update(expectedUpdate)!, nextSnapshot.root, `pairing:${id}`, staged);
    await this.objects.store([...staged].map(([hash, bytes]) => ({ hash, bytes })));
    const changes = await this.entryChanges(configTree.ref, nextSnapshot.root);
    const now = Date.now();
    const accepted = this.acceptedStore.commit({
      entryChanges: changes,
      tree: configTree.id,
      root: nextSnapshot.root,
      previousRoot: configTree.ref,
      expectedUpdate,
      acceptedAt: now,
      subject: `pairing:${id}`,
      mergeState,
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
    return (
      HANDLE.test(handle)
      && !this.nameHeldByTree(handle) &&
      !this.accountByHandle(handle) &&
      this.communityAccountReservations().has(handle)
    );
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

  /** The founder account's handle while it is still reserved for its profile and unclaimed; null once claimed or when the community was bootstrapped with token accounts. */
  unclaimedFounderHandle(): string | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = 'first_writer_handle'").get() as { value: string } | null;
    return row?.value ?? null;
  }

  setCommunityHost(host: string, allowTestPortChange = false): void {
    this.accounts.setCommunityHost(host, allowTestPortChange);
  }

  writableProfiles(account: CanopyAccount): CanopyTree[] {
    return this.list().filter((tree) =>
      tree.status === "active"
      && tree.canonicalPath !== null
      && tree.policy === "ordinary"
      && this.rootProfileType(tree.ref) !== null
      && this.canWrite(account, tree)
    );
  }

  async ensureAccountConfigTrees(origin: string): Promise<void> {
    const accounts = this.db.query("SELECT id FROM accounts WHERE config_tree IS NULL ORDER BY id").all() as Array<{ id: string }>;
    for (const { id } of accounts) {
      const account = this.account(id)!;
      if (!account.profileTree) continue;
      const devices = Object.fromEntries(this.devices(account)
        .filter((device) => device.revokedAt === null)
        .map((device) => [device.id, { id: device.id, label: device.label, administrator: true }]));
      const active = Object.keys(devices);
      if (!active.length) throw new Error(`Account ${id} has no active device to administer its configuration`);
      const declarations = Object.fromEntries(this.list()
        .filter((tree) => tree.canonicalPath && tree.policy === "ordinary" && this.canAdminister(account, tree.id))
        .map((tree) => [tree.id, {
          canonical: `${new URL(origin).origin}${tree.canonicalPath!}`,
          access: this.accessEntries(tree.id).map(accessRule),
        }]));
      if (!declarations[account.profileTree]) {
        const profile = this.get(account.profileTree)!;
        declarations[profile.id] = {
          canonical: `${new URL(origin).origin}${profile.canonicalPath!}`,
          access: this.accessEntries(profile.id).map(accessRule),
        };
      }
      const graph = {
        account: { canopy: new URL(origin).origin, profile: account.profileTree },
        trees: declarations,
        devices,
      };
      const snapshot = snapshotAccountConfigV2(graph);
      const configID = generateArborID("tr");
      await this.validateGraph(snapshot.root, snapshot.objects);
      const staged = new Map(snapshot.objects);
      const mergeState = await this.semantic.checkpoint(configID, null, snapshot.root, `initial:${configID}`, staged);
      await this.objects.store([...staged].map(([hash, bytes]) => ({ hash, bytes })));
      const changes = await this.entryChanges(null, snapshot.root);
      const now = Date.now();
      this.db.transaction(() => {
        this.db.run(
          "INSERT INTO trees (id, ref, updated_at, policy, status, account_id) VALUES (?, ?, ?, 'account-config-v2', 'active', ?)",
          [configID, snapshot.root, now, account.id],
        );
        this.acceptedStore.insert({ tree: configID, root: snapshot.root, previousRoot: null, acceptedAt: now, entryChanges: changes, mergeState });
        this.db.run("UPDATE accounts SET config_tree = ? WHERE id = ? AND config_tree IS NULL", [configID, account.id]);
      })();
    }
  }

  private applyAccountConfigDerived(accountID: string, current: AccountConfigGraphV2, next: AccountConfigGraphV2): void {
    const now = Date.now();
    for (const id of Object.keys(current.devices)) {
      if (!next.devices[id]) this.db.run("UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND account_id = ?", [now, id, accountID]);
    }
    for (const id of Object.keys(next.devices)) {
      const row = this.db.query("SELECT revoked_at FROM devices WHERE id = ? AND account_id = ?").get(id, accountID) as { revoked_at: number | null } | null;
      if (!row) throw new Error(`Device ${id} has no credential binding`);
      if (row.revoked_at !== null) throw new Error(`Retired DeviceID cannot be reactivated: ${id}`);
    }
    if (current.resources || next.resources) {
      this.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES (?, '1')", [resourcePolicyFormatKey(accountID)]);
    }
    this.db.run("DELETE FROM resource_policy WHERE account_id = ?", [accountID]);
    const resources = next.resources ?? (
      this.db.query("SELECT 1 FROM meta WHERE key=?").get(resourcePolicyFormatKey(accountID))
        ? Object.fromEntries(Object.entries(next.trees).map(([id, declaration]) => [id, {
          canonical: declaration.canonical, access: declaration.access.map(resourceRuleFromLegacy),
        }])) : undefined
    );
    if (resources) {
      for (const [tree, declaration] of Object.entries(resources)) {
        this.db.run("INSERT INTO resource_policy(account_id, tree_id, rules_json) VALUES (?, ?, ?)", [accountID, tree, JSON.stringify(declaration.access)]);
      }
      for (const tree of Object.keys(graphTrees(current))) {
        if (resources[tree] && !resources[tree].canonical) throw new Error("Cannot remove hosting through a policy-only entry");
      }
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
      this.access.setRules(id, declaration.access);
    }
  }

  private async accountConfigGraph(account: CanopyAccount): Promise<AccountConfigGraphV2> {
    if (!account.configTree) throw new Error("Account configuration tree is missing");
    const tree = this.get(account.configTree);
    if (!tree) throw new Error("Account configuration tree is missing");
    const snapshot = await this.objects.completeSnapshot(tree.ref);
    return readAccountConfigGraphV2(snapshot, tree.id);
  }

  private async activateTree(
    authentication: CanopyAuthentication,
    treeID: string,
    snapshot: TreeSnapshot,
    requestDigest?: ObjectHash,
    change?: string,
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
    if (!graphAdministrators(config).includes(authentication.device)) throw new PermissionDeniedError("Only an administrator device may initialize a tree");
    const declaration = graphTrees(config)[treeID];
    if (!declaration) throw new Error("Tree declaration disappeared before activation");
    const requiredType = this.requiredProfileType(treeID, declaration.canonicalPath);
    if (requiredType) await this.validateProfileRoot(snapshot.root, snapshot.objects, requiredType);
    const parent = this.resolve(dirnameURL(declaration.canonicalPath))?.tree;
    if (!parent) throw new Error("Canonical parent is unavailable");
    const activated = await this.insertTree(
      declaration.canonicalPath,
      snapshot,
      "none",
      parent.id,
      (id) => {
        this.access.setRules(id, declaration.access);
        this.db.run("DELETE FROM tree_reservations WHERE id = ? AND account_id = ?", [id, authentication.account.id]);
      },
      authentication.subject,
      treeID,
      authentication.account.id,
      requestDigest,
      change,
    );
    return activated;
  }

  scopedCaller(account: CanopyAccount | null, tree: string, subject: string, active: () => boolean, linkDigest?: string) {
    return this.access.directExecution(account, tree, subject, active, linkDigest);
  }

  resourcePolicy(account: CanopyAccount, tree: string) {
    return this.execution.current ? undefined : this.access.safePolicy(account.id, tree);
  }

  accessEntries(tree: string): CanopyAccessEntry[] {
    return this.access.entries(tree);
  }

  communityMembers(): RootProfileFacts["members"] {
    return this.rootProfile(this.community().ref).members;
  }

  handleForProfile(profileTree: string): string | undefined {
    const row = this.db.query("SELECT handle FROM accounts WHERE profile_tree = ? AND enabled = 1").get(profileTree) as { handle: string } | null;
    return row?.handle;
  }

  readableGroupTrees(account: CanopyAccount): CanopyTree[] {
    return this.list().filter((tree) => tree.status === "active" && this.rootProfileType(tree.ref) === "group" && this.canRead(account, tree));
  }

  administeredTrees(account: CanopyAccount): CanopyTree[] {
    return this.list().filter((tree) => tree.status === "active" && tree.accountID === account.id);
  }

  /** A root's complete profile facts, card fields included: its stored row,
   * or read from the root when it has none (it is not a profile root). */
  async profileCard(root: ObjectHash): Promise<RootProfileFacts> {
    return storedProfileFacts(this.db, root) ?? await rootProfileFacts(root, (hash) => this.objects.read(hash));
  }

  /** `tree` is an ID, or a tree the caller already read, which saves reading it again. */
  canRead(account: CanopyAccount | null, tree: string | CanopyTree, linkDigest?: string): boolean {
    return this.execution.current ? this.execution.allows(idOf(tree), "/", "read") : this.access.canRead(account, tree, linkDigest);
  }

  canWrite(account: CanopyAccount | null, tree: string | CanopyTree, linkDigest?: string): boolean {
    return this.execution.current ? this.execution.allows(idOf(tree), "/", "write") : this.access.canWrite(account, tree, linkDigest);
  }

  canAdminister(account: CanopyAccount, treeID: string): boolean {
    return !this.execution.current && this.access.canAdminister(account, treeID);
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
    if (this.nameHeldByTree(input.handle)) throw new AlreadyClaimedError(input.handle);
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
    const firstWriter = this.unclaimedFounderHandle() === input.handle;
    const staged = new Map(input.configurationSnapshot.objects);
    const mergeState = await this.semantic.checkpoint(input.configurationTree, null, input.configurationSnapshot.root, `initial:${input.configurationTree}`, staged);
    await this.objects.store([...staged].map(([hash, bytes]) => ({ hash, bytes })));
    const configurationChanges = await this.entryChanges(null, input.configurationSnapshot.root);
    const accountID = generateArborID("ac");
    const now = Date.now();
    this.db.transaction(() => {
      const consumed = this.db.run(
        "UPDATE account_challenges SET consumed_at = ?, claim_digest = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?",
        [now, claimDigest, proof.challenge.id, now],
      );
      if (consumed.changes !== 1) throw new Error("Account challenge was already consumed or expired");
      this.db.run(
        "INSERT INTO accounts (id, handle, profile_tree, config_tree, claim_digest, enabled) VALUES (?, ?, ?, ?, ?, 1)",
        [accountID, input.handle, input.profileTree, input.configurationTree, claimDigest],
      );
      this.db.run(
        "INSERT INTO devices (id, account_id, label, token_digest, created_at) VALUES (?, ?, ?, ?, ?)",
        [input.deviceID, accountID, input.deviceLabel, input.credentialDigest.slice("sha256:".length), now],
      );
      this.db.run(
        "INSERT INTO trees (id, ref, updated_at, policy, status, account_id) VALUES (?, ?, ?, 'account-config-v2', 'active', ?)",
        [input.configurationTree, input.configurationSnapshot.root, now, accountID],
      );
      this.acceptedStore.insert({
        tree: input.configurationTree,
        root: input.configurationSnapshot.root,
        previousRoot: null,
        acceptedAt: now,
        subject: `device:${input.deviceID}`,
        entryChanges: configurationChanges,
        mergeState,
      });
      if (config.resources) this.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES (?, '1')", [resourcePolicyFormatKey(accountID)]);
      if (config.resources) for (const [tree, declaration] of Object.entries(config.resources)) {
        this.db.run("INSERT INTO resource_policy(account_id, tree_id, rules_json) VALUES (?, ?, ?)", [accountID, tree, JSON.stringify(declaration.access)]);
      }
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

  /** Attach the transition from the candidate root to the accepted root whenever the two differ. */
  private async withReconciliation(
    result: UpdateResult,
    candidate: ObjectHash,
    proposed: ReadonlyMap<ObjectHash, Uint8Array>,
  ): Promise<UpdateResult> {
    if (result.update.root === candidate) return result;
    if (this.execution.current && !this.execution.allows(result.update.tree, "/", "read")) throw new PermissionDeniedError("Reconciliation disclosure is not allowed");
    const reconciliation = await buildAcceptedTransitionPayload(candidate, result.update.root, (hash) => this.objects.load(hash, proposed));
    return { ...result, reconciliation };
  }

  private acceptedTransitionPayload(previousRoot: ObjectHash, root: ObjectHash): Promise<AcceptedTransitionPayload> {
    return buildAcceptedTransitionPayload(previousRoot, root, (hash) => this.object(hash));
  }

  /** The file entries an accepted update writes, read before its transaction. */
  private entryChanges(previousRoot: ObjectHash | null, root: ObjectHash): Promise<EntryChanges> {
    return entryChanges(previousRoot, root, (hash) => this.object(hash));
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
    markPhase("lock-wait");
    try {
      return await this.submitUpdatesLocked(
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

  private async submitUpdatesLocked(
    treeID: string,
    request: UpdateRequest,
    account: CanopyAccount | null = null,
    linkDigest?: string,
    credentialSubject?: string,
    authentication?: CanopyAuthentication
  ): Promise<StoredUpdateResponse> {
    validateUpdateRequestIntent(request);
    if (this.execution.current && (request.base === null || request.updates.length !== 1 || request.updates.some(u => u.trace !== null || u.resolves.length))) throw new PermissionDeniedError("Execution update form is not allowed");
    // Preflight the whole batch: unsupported semantics must never accept a prefix.
    for (const [index, update] of request.updates.entries()) {
      if (
        (request.base === null ||
          isAccountConfigPolicy(this.get(treeID)?.policy ?? "ordinary")) &&
        update.trace !== null
      ) {
        throw new UpdateProtocolError(
          "unsupported-operation",
          `Update ${index} (${update.change}) carries a trace or resolutions not yet supported by Canopy`
        );
      }
    }
    const digests = updateRequestDigests(treeID, request);
    const completed: UpdateResult[] = [];
    let accepted = false;
    let baseRoot: ObjectHash | null = null;
    if (request.base !== null) {
      const baseUpdate = this.update(request.base);
      if (!baseUpdate || baseUpdate.tree !== treeID) {
        throw new UpdateProtocolError("base-not-retained", "Base update is not retained for this tree");
      }
      baseRoot = baseUpdate.root;
    }
    // A recorded later digest proves every earlier element ran, including no-ops
    // without accepted rows. Those elements must not recheck a now-stale guard.
    let recordedThrough = -1;
    const retainedTree = this.get(treeID);
    if (retainedTree && (this.canWrite(account, treeID, linkDigest) || this.execution.canSubmit(treeID))) {
      const subject = this.subjectFor(retainedTree, account, linkDigest, credentialSubject);
      for (let index = digests.length - 1; index >= 0; index--) {
        if (this.acceptedStore.acceptedRequest(treeID, subject, digests[index]!)) { recordedThrough = index; break; }
      }
    }
    markPhase("receipts");
    const intents = new Map<number, { basis: StateRef; evaluated: Evaluated; guards: string[] }>();
    if (
      request.base &&
      request.updates.some((update) => update.trace !== null)
    ) {
      if (!(this.canWrite(account, treeID, linkDigest) || this.execution.canSubmit(treeID))) throw new PermissionDeniedError("Write access is not allowed");
      // Receipts precede execution: a tool upgrade/outage cannot alter an exact retry.
      if (recordedThrough === request.updates.length - 1) {
        const subject = this.subjectFor(this.get(treeID)!, account, linkDigest, credentialSubject);
        const results = [];
        for (let index = 0; index < request.updates.length; index++) {
          const receipt = this.acceptedStore.acceptedRequest(
            treeID,
            subject,
            digests[index]!
          );
          if (!receipt) break;
          results.push(
            await this.withReconciliation(
              receipt.result,
              request.updates[index]!.candidate,
              new Map()
            )
          );
        }
        if (results.length === request.updates.length)
          return {
            status: 201,
            result: { results, observedThrough: this.observedThrough(treeID) },
          };
      }
      const objects = new Map<ObjectHash, Uint8Array>();
      let basis = this.semantic.state(this.update(request.base)!);
      markPhase("preflight-state");
      for (const [index, update] of request.updates.entries()) {
        for (const object of update.objects) objects.set(object.hash, object.bytes);
        if (index <= recordedThrough) {
          const subject = this.subjectFor(this.get(treeID)!, account, linkDigest, credentialSubject);
          const receipt = this.acceptedStore.acceptedRequest(treeID, subject, digests[index]!);
          const retained = receipt && this.semantic.store.get(receipt.result.update.id);
          // A receipt binds this exact prefix to its credential. Continue from
          // the author's candidate, not the possibly merged accepted projection.
          // Unchanged receipts can point at another change's state; those
          // still need normal evaluation.
          if (retained?.request.change === update.change && retained.request.candidate === update.candidate) {
            basis = { object: update.candidate, state: retained.authored };
            continue;
          }
        }
        for (const object of await this.objects.reconstructDeltas(
          basis.object,
          update.deltas,
          objects
        ))
          objects.set(object.hash, object.bytes);
        if (update.trace !== null) {
          try {
            const keys = update.resolves.flatMap(
              (r) =>
                this.semantic.store
                  .get(r.state)
                  ?.decisions.filter((d) => d.inspection.id === r.conflict)
                  .map((d) => d.key) ?? []
            );
            const validated = await this.semantic.evaluate(
              treeID,
              basis,
              basis,
              update,
              objects,
              keys
            );
            markPhase("preflight-evaluate");
            intents.set(index, { basis, evaluated: validated, guards: keys });
            basis = validated.authored;
          } catch (error) {
            if (error instanceof IntentError && error.code === "unsupported")
              throw new UpdateProtocolError("unsupported-operation", error.message);
            throw error;
          }
        } else {
          const checkpoint = await this.mergeTool.evaluate(
            {
              kind: "checkpoint",
              tree: treeID,
              current: basis,
              projection: update.candidate,
              change: update.change,
              decisions: [],
            },
            objects
          );
          for (const [hash, bytes] of checkpoint.objects)
            objects.set(hash, bytes);
          basis = checkpoint.response.result;
        }
      }
      // These are immutable preflight objects, not accepted state. The accepted
      // transaction below is their only authority; an aborted batch leaves no rows.
      await this.objects.store(
        [...objects].map(([hash, bytes]) => ({ hash, bytes }))
      );
      markPhase("preflight-store");
    }
    const proposed = new Map<ObjectHash, Uint8Array>();
    for (const [index, update] of request.updates.entries()) {
      const requestDigest = digests[index]!;
      for (const { hash, bytes } of update.objects) proposed.set(hash, bytes);
      if (baseRoot === null) {
        const activation = await this.activateFromUpdate(treeID, update, requestDigest, authentication, index < recordedThrough);
        completed.push(activation.result as UpdateResult);
        accepted ||= activation.result.outcome !== "unchanged";
        baseRoot = update.candidate;
        continue;
      }
      // Credential-bound receipts already prove this prefix. Transport aids
      // do not participate in its identity; rebuilding accepted deltas repeats
      // work and can demand bytes an exact retry no longer needs to supply.
      const reconstructed = index <= recordedThrough ? []
        : await this.objects.reconstructDeltas(baseRoot, update.deltas, proposed);
      for (const object of reconstructed) {
        if (
          !(await this.objects.contains(update.candidate, object.hash, proposed))
        ) {
          throw new Error(
            `Object delta result is not reachable from candidate: ${object.hash}`
          );
        }
        proposed.set(object.hash, object.bytes);
      }
      const result = await this.submitCandidateLocked(
        treeID,
        baseRoot,
        update,
        requestDigest,
        proposed,
        // The request's accepted base, or the activation that preceded this update.
        request.base ?? completed[0]!.update.id,
        account,
        linkDigest,
        credentialSubject,
        index < recordedThrough,
        intents.get(index),
      );
      if ("error" in result.result) {
        result.result.details.completed = completed;
        result.result.details.failedIndex = index;
        return { status: result.status, result: result.result };
      }
      completed.push(result.result);
      accepted ||= result.result.outcome !== "unchanged";
      baseRoot = update.candidate;
    }
    return {
      status: accepted ? 201 : 200,
      result: {
        results: completed,
        observedThrough: this.observedThrough(treeID),
      },
    };
  }

  private async submitCandidateLocked(
    treeID: string,
    baseRoot: ObjectHash,
    request: CandidateUpdate,
    requestDigest: ObjectHash,
    proposed: Map<ObjectHash, Uint8Array>,
    since: string,
    account: CanopyAccount | null = null,
    linkDigest?: string,
    credentialSubject?: string,
    provenAcceptedPrefix = false,
    preparedIntent?: { basis: StateRef; evaluated: Evaluated; guards: string[] },
  ): Promise<{ status: number; result: UpdateResult | UpdateConflictResult }> {
    const tree = this.get(treeID);
    if (!tree) throw new NotFoundError(`Unknown tree: ${treeID}`);
    if (!(this.canWrite(account, treeID, linkDigest) || this.execution.canSubmit(treeID))) throw new PermissionDeniedError("Write access is not allowed");
    const policy = isAccountConfigPolicy(tree.policy)
      ? this.accountConfigPolicy(tree, request, baseRoot, account, credentialSubject, proposed)
      : this.ordinaryPolicy(tree, request, account, linkDigest, credentialSubject);
    const { subject } = policy;
    const execution = this.execution.current;
    if (execution) {
      if (this.currentUpdate(treeID)?.conflicted) throw new PermissionDeniedError("Execution updates of conflicted trees are not allowed until alternative scope validation is available");
      if (!request.ifCurrent || request.trace !== null || request.resolves.length) throw new PermissionDeniedError("Execution update form is not allowed");
      const effects = await resourceEffects(baseRoot, request.candidate, hash => this.objects.load(hash, proposed));
      if (!this.execution.covered(execution) || effects.some(e => !this.execution.allows(treeID, e.path, e.operation, execution))) throw new PermissionDeniedError("Execution effects are not allowed");
    }
    const replay = this.acceptedStore.acceptedRequest(treeID, subject, requestDigest);
    if (!replay && execution && request.ifCurrent !== this.currentUpdate(treeID)?.id) throw new UpdateProtocolError("base-not-retained", "Execution guard is stale; recompute against a current authorized basis");
    if (replay) {
      return { ...replay, result: await this.withReconciliation(replay.result, request.candidate, proposed) };
    }
    if (provenAcceptedPrefix) {
      const current = this.currentUpdate(treeID);
      if (!current) throw new UpdateProtocolError("base-not-retained", "Accepted prefix state is unavailable");
      return {
        status: 200,
        result: await this.withReconciliation({ outcome: "unchanged", update: current, requestDigest }, request.candidate, proposed),
      };
    }
    if (this.acceptedStore.acceptedChange(treeID, request.change)) {
      throw new Error("Authored change identity is already bound to a different accepted request");
    }
    await this.validateGraph(request.candidate, proposed, tree.ref);
    markPhase("validate-graph");
    await policy.validateCandidate(request.candidate, proposed);
    markPhase("validate-candidate");
    return this.submitSemanticCandidate(tree, baseRoot, request, requestDigest, proposed, policy, since, preparedIntent);
  }

  /** A 409 that leaves accepted state unchanged: an exact-state or resolution
   * guard no longer matches, or governed policy refuses the merge. The draft is
   * what the client keeps: its own candidate unless a merge proposes another. */
  private async rejectedCandidate(
    treeID: string,
    current: AcceptedUpdate,
    baseRoot: ObjectHash,
    request: CandidateUpdate,
    proposed: ReadonlyMap<ObjectHash, Uint8Array>,
    message: string,
    kind: UpdateConflictResult["details"]["kind"] = "server-update",
    root: ObjectHash = request.candidate,
    conflicts: UpdateConflictResult["details"]["conflicts"] = [{ path: "/", reason: "node-conflict" }],
  ): Promise<{ status: number; result: UpdateConflictResult }> {
    const draft = { root, ...(await buildAcceptedTransitionPayload(request.candidate, root, (hash) => this.objects.load(hash, proposed))) };
    return {
      status: 409,
      result: {
        error: "conflict",
        message,
        retryable: false,
        tree: treeID,
        details: { kind, completed: [], failedIndex: 0, current, base: baseRoot, candidate: request.candidate, draft, conflicts },
      },
    };
  }

  /** Attribution for the current side of a snapshot choice: each change
   * accepted after `since` (the request's accepted base) through `current`
   * that touched a path, or a path within or above it. A physical change is
   * evidence of a change, never of an editor operation. */
  private async concurrentChanges(
    since: string,
    current: AcceptedUpdate,
    proposed: ReadonlyMap<ObjectHash, Uint8Array>,
  ): Promise<(path: string) => Array<{ change: string; operation: null }>> {
    const touched: Array<{ change: string; paths: string[] }> = [];
    for (const update of this.acceptedStore.ancestry(since, current.id, Infinity) ?? []) {
      const change = this.acceptedStore.changeForAccepted(update.id);
      if (change && update.previous)
        touched.push({ change, paths: await changedEntryPaths(update.previous.root, update.root, (hash) => this.objects.load(hash, proposed)) });
    }
    const related = (a: string, b: string) => a === "/" || b === "/" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    return (path) => touched.filter((t) => t.paths.some((p) => related(p, path))).map((t) => ({ change: t.change, operation: null }));
  }

  /** Checkpoint decisions for a conflicting snapshot, and the projection that
   * shows the current material for each. Each conflict is scoped to one entry
   * and the rest of the merge is accepted: a file (a file against its deletion
   * included) is a choice about that file; a conflict inside a folder the tree
   * merge could not reconcile, or at an entry that is not a file on both
   * sides, is a choice about the nearest folder that both sides hold. A choice
   * inside another choice's folder is part of that choice. Only a conflict at
   * the root, or one no folder below it contains, is a single whole-root
   * choice that keeps the current tree. The current alternative names the
   * concurrent changes that produced it; the candidate names this change. A
   * folder choice depends on the open choices already inside that folder.
   *
   * A candidate whose basis showed a hidden alternative of an open choice
   * about the same entry (a batch suffix after its prefix was withheld)
   * continues that alternative: the choice keeps its identity, that
   * alternative becomes the candidate's version, and `replaces` names the
   * choice so the checkpoint retires its old form. */
  private async snapshotDecisions(
    change: string,
    current: AcceptedUpdate,
    since: string,
    base: ObjectHash,
    candidate: ObjectHash,
    merged: ObjectHash,
    conflicts: Array<{ path: string }>,
    folders: string[],
    proposed: Map<ObjectHash, Uint8Array>
  ): Promise<{ projection: ObjectHash; decisions: CheckpointRequest["decisions"]; replaces: string[] }> {
    const concurrent = await this.concurrentChanges(since, current, proposed);
    const own = [{ change, operation: null }];
    const roots = [...new Set([current.root, candidate, merged])];
    const whole = {
      projection: current.root,
      replaces: [],
      decisions: [{
        key: `snapshot:${change}`,
        selected: 0,
        alternatives: roots.map((object) => ({
          object,
          contributions: object === current.root ? concurrent("/") : object === candidate ? own : [...concurrent("/"), ...own],
        })),
      }],
    };
    const load = async (hash: ObjectHash) => decodeWireDirectory(await this.objects.load(hash, proposed));
    const entryAt = async (root: ObjectHash, names: string[]) => {
      let directory = root;
      for (const [index, name] of names.entries()) {
        const entry = (await load(directory)).entries.find((e) => e.name === name);
        if (!entry || index === names.length - 1) return entry ?? null;
        if (!entry.directory) return null;
        directory = entry.directory;
      }
      return null;
    };
    // Replace (or remove) one entry below `root`; null when a parent directory is absent.
    const withEntry = async (root: ObjectHash, names: string[], entry: WireDirectoryEntry | null): Promise<ObjectHash | null> => {
      const directory = await load(root);
      const [name, ...rest] = names as [string, ...string[]];
      const prior = directory.entries.find((e) => e.name === name);
      let next: WireDirectoryEntry | null = entry;
      if (rest.length) {
        if (!prior?.directory) return null;
        const child = await withEntry(prior.directory, rest, entry);
        if (!child) return null;
        next = { ...prior, directory: child };
      }
      directory.entries = [...directory.entries.filter((e) => e.name !== name), ...(next ? [next] : [])]
        .sort((a, b) => compareWireNames(a.name, b.name));
      const bytes = encodeWireDirectory(directory), hash = hashObject(bytes);
      proposed.set(hash, bytes);
      return hash;
    };
    if (!conflicts.length && !folders.length) return whole;
    const within = (path: string, scope: string) => scope === "/" || path === scope || path.startsWith(`${scope}/`);
    const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
    const namesOf = (path: string) => path.slice(1).split("/");
    // The entry each conflict is about.
    const scopes = new Set<string>();
    for (const conflict of [...folders, ...conflicts.map((c) => c.path)]) {
      // The outermost unreconciled folder containing the conflict owns it.
      let path = folders.filter((folder) => within(conflict, folder)).sort((a, b) => a.length - b.length)[0] ?? conflict;
      for (;;) {
        if (path === "/") return whole;
        const [mine, theirs] = await Promise.all([current.root, candidate].map((root) => entryAt(root, namesOf(path))));
        const file = (entry: WireDirectoryEntry | null | undefined) => !entry || !!entry.file;
        if ((mine || theirs) && file(mine) && file(theirs)) break;
        if (mine?.directory && theirs?.directory) break;
        path = parentOf(path);
      }
      scopes.add(path);
    }
    const open = this.semantic.store.get(current.id)?.decisions ?? [];
    // The path an open choice is about: its entry, or the file its range is in.
    const placed = ({ inspection }: (typeof open)[number]) => {
      const placement = inspection.alternatives.find((a) => a.placement)?.placement;
      if (placement) return `/${[...(placement.parent.within ?? []), placement.name].join("/")}`;
      const ref = inspection.affected[0];
      return inspection.kind === "content" && ref?.material.kind === "basis" ? ref.material.path : null;
    };
    const entryPath = (d: (typeof open)[number]) => d.inspection.kind === "entry" ? placed(d) : null;
    const valueOf = (entry: object | null | undefined) =>
      entry && "file" in entry && typeof entry.file === "string" ? { file: entry.file }
      : entry && "directory" in entry && typeof entry.directory === "string" ? { directory: entry.directory } : null;
    let projection: ObjectHash = merged;
    const decisions: CheckpointRequest["decisions"] = [], replaces: string[] = [];
    for (const path of [...scopes].filter((p) => ![...scopes].some((q) => q !== p && within(p, q))).sort()) {
      const names = namesOf(path);
      const [mine, theirs, before] = await Promise.all([current.root, candidate, base].map((root) => entryAt(root, names)));
      const shown = await withEntry(projection, names, mine ?? null);
      if (!shown) return whole;
      projection = shown;
      const folder = !!(mine?.directory && theirs?.directory);
      const dependencies = folder
        ? open.filter((d) => { const at = placed(d); return !!at && at !== path && within(at, path); }).map((d) => d.key)
        : [];
      const basis = valueOf(before);
      const prior = basis
        ? open.find((d) => !d.inspection.dependencies.length && entryPath(d) === path)
        : undefined;
      const continued = prior?.inspection.alternatives.findIndex((a) =>
        a.id !== prior.inspection.selected && stableJSONString(a.value) === stableJSONString(basis)) ?? -1;
      if (prior && continued >= 0) {
        const alternatives = [];
        for (const [index, alternative] of prior.inspection.alternatives.entries()) {
          const value = valueOf(alternative.value);
          const object = index === continued ? candidate
            : alternative.id === prior.inspection.selected ? current.root
            : await withEntry(current.root, names, value ? { name: names.at(-1)!, ...value } as WireDirectoryEntry : null);
          if (!object) break;
          alternatives.push({ object, contributions: index === continued ? [...alternative.contributions, ...own] : alternative.contributions });
        }
        if (alternatives.length === prior.inspection.alternatives.length) {
          replaces.push(prior.key);
          decisions.push({
            key: prior.key,
            path: names,
            selected: prior.inspection.alternatives.findIndex((a) => a.id === prior.inspection.selected),
            alternatives,
            ...(dependencies.length ? { dependencies } : {}),
          });
          continue;
        }
      }
      decisions.push({
        key: `snapshot:${change}:${path}`,
        path: names,
        selected: 0,
        alternatives: [
          { object: current.root, contributions: concurrent(path) },
          { object: candidate, contributions: own },
        ],
        ...(dependencies.length ? { dependencies } : {}),
      });
    }
    return { projection, decisions, replaces };
  }

  /**
   * Every candidate, traced or snapshot, on every tree policy: evaluate it
   * against the current accepted merge state and record the result's merge
   * state with the accepted row. A snapshot is merged as a tree, then
   * checkpointed onto the current state together with the author's own
   * candidate, in one worker request.
   */
  private async submitSemanticCandidate(
    tree: CanopyTree,
    baseRoot: ObjectHash,
    request: CandidateUpdate,
    requestDigest: ObjectHash,
    proposed: Map<ObjectHash, Uint8Array>,
    policy: UpdatePolicy,
    since: string,
    prepared?: { basis: StateRef; evaluated: Evaluated; guards: string[] }
  ): Promise<{ status: number; result: UpdateResult | UpdateConflictResult }> {
    const governed = isAccountConfigPolicy(tree.policy);
    for (let race = 0; race < 3; race++) {
      const current = this.currentUpdate(tree.id)!;
      if (current.root !== this.get(tree.id)!.ref) {
        throw new Error(`Invariant violated: tree ${tree.id} ref does not match its current accepted update`);
      }
      if (request.ifCurrent !== undefined && request.ifCurrent !== current.id)
        return this.rejectedCandidate(tree.id, current, baseRoot, request, proposed, "Accepted state no longer matches ifCurrent", policy.rejection?.kind);
      const open = this.semantic.openDecisions(current);
      if (governed && (open || request.resolves.length)) {
        // Governed policy conflicts retain the conservative projection. Further
        // edits must explicitly resolve the complete current decision set; an
        // ordinary snapshot or stale device cannot silently restore authority.
        const keys = this.semantic.guards(current, request);
        if (!keys || request.ifCurrent !== current.id || baseRoot !== current.root ||
            request.resolves.length !== open || new Set(keys).size !== open) {
          throw new UpdateProtocolError("unsupported-operation", "Configuration policy conflicts require an exact guarded resolution of every current decision");
        }
      }
      const guards = this.semantic.guards(current, request);
      if (guards === null)
        return this.rejectedCandidate(tree.id, current, baseRoot, request, proposed, "Resolution guards no longer match the accepted decisions");
      const currentState = this.semantic.state(current);
      markPhase("current-state");
      let result: StateRef,
        authored: StateRef,
        evidence: Evaluated["evidence"] | null = null;
      if (prepared) {
        // Preflight already evaluated the exact no-concurrency case. Reuse only
        // when both material states and resolution keys still match; authority,
        // guards, candidate validation and commit checks remain above/below.
        const exact = prepared.basis.object === currentState.object && prepared.basis.state === currentState.state
          && stableJSONString(prepared.guards) === stableJSONString(guards);
        const evaluated = exact ? prepared.evaluated : await this.semantic.evaluate(
          tree.id,
          prepared.basis,
          currentState,
          request,
          proposed,
          guards
        );
        result = evaluated.result;
        authored = evaluated.authored;
        evidence = evaluated.evidence;
      } else {
        // Resolving a governed policy conflict accepts the author's exact
        // candidate; selecting the restrictive projection is still a resolution.
        const merged = governed && guards.length
          ? { outcome: "accepted" as const, root: request.candidate, generated: new Map<ObjectHash, Uint8Array>() }
          : await reconcileUpdate(
            baseRoot,
            request.candidate,
            current.root,
            (hash) => this.objects.load(hash, proposed),
            { merge: policy.merge ?? ((base, candidate, remote) => this.mergeTool.tree(base, candidate, remote, proposed)) }
          );
        markPhase("reconcile");
        if (merged.outcome === "current" && !guards.length)
          return {
            status: 200,
            result: await this.withReconciliation({ outcome: "unchanged", update: current, requestDigest }, request.candidate, proposed),
          };
        if (merged.outcome !== "current")
          for (const [hash, bytes] of merged.generated)
            proposed.set(hash, bytes);
        const conflicts = "conflicts" in merged ? merged.conflicts : [];
        const mergedRoot = merged.outcome === "current" ? current.root : merged.root;
        // Only an access narrowing may stay open as a policy choice; any other
        // governed conflict is refused, not accepted.
        if (governed && conflicts.some((c) => c.path !== "/trees.yaml/access"))
          return this.rejectedCandidate(tree.id, current, baseRoot, request, proposed, policy.rejection!.message, policy.rejection!.kind, mergedRoot, conflicts);
        // A merge keeps the candidate's version of a conflict for the client's
        // draft; acceptance shows the current material and retains the other.
        // A governed access conflict instead keeps the merge's restrictive
        // projection, as one whole-configuration choice.
        const { projection, decisions, replaces } = !conflicts.length && merged.outcome !== "rejected"
          ? { projection: mergedRoot, decisions: [], replaces: [] }
          : governed
          ? { projection: mergedRoot, replaces: [], decisions: [{
              key: `policy:${request.change}`,
              selected: 0,
              alternatives: [...new Set([mergedRoot, current.root, request.candidate])].map((object) => ({ object, contributions: [] })),
            }] }
          : await this.snapshotDecisions(request.change, current, since, baseRoot, request.candidate, mergedRoot, conflicts,
            "unresolvedDirectories" in merged ? merged.unresolvedDirectories ?? [] : [], proposed);
        const checkpoint = await this.mergeTool.evaluate(
          {
            kind: "checkpoint",
            tree: tree.id,
            current: currentState,
            projection,
            candidate: request.candidate,
            continueSelected: baseRoot === current.root,
            conflictProjection: "current",
            change: request.change,
            resolves: [...guards, ...replaces],
            decisions,
            // The snapshot candidate is the author's basis for a later batch suffix.
            authored: true,
          },
          proposed
        );
        for (const [hash, bytes] of checkpoint.objects)
          proposed.set(hash, bytes);
        result = checkpoint.response.result;
        authored = checkpoint.response.authored!;
      }
      markPhase("evaluate");
      const mergeState = await this.semantic.record(
        tree.id,
        result,
        authored,
        request,
        proposed,
        evidence
      );
      markPhase("record");
      await policy.validateAccepted(
        this.get(tree.id)!,
        result.object,
        proposed
      );
      markPhase("validate-accepted");
      await this.objects.store(
        [...proposed].map(([hash, bytes]) => ({ hash, bytes }))
      );
      markPhase("accepted-store");
      const now = Date.now(),
        commit = await policy.prepareCommit(
          this.get(tree.id)!,
          result.object,
          now
        );
      const changes = await this.entryChanges(current.root, result.object);
      const profile = await this.profileFacts(result.object, proposed);
      markPhase("entry-changes");
      const accepted = this.acceptedStore.commit(
        {
          entryChanges: changes,
          tree: tree.id,
          root: result.object,
          previousRoot: current.root,
          expectedUpdate: current.id,
          acceptedAt: now,
          subject: policy.subject,
          requestDigest,
          change: request.change,
          mergeState,
        },
        () => {
          commit.withinTransaction?.();
          recordProfileFacts(this.db, result.object, profile);
        }
      );
      if (!accepted) continue;
      markPhase("commit");
      commit.afterCommit?.(accepted);
      this.notifyAccepted(accepted);
      markPhase("notify");
      return {
        status: 201,
        result: await this.withReconciliation(
          { outcome: "accepted", update: accepted, requestDigest },
          request.candidate,
          proposed
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
    request: CandidateUpdate,
    requestDigest: ObjectHash,
    authentication: CanopyAuthentication | undefined,
    provenAcceptedPrefix = false,
  ): Promise<{ status: number; result: UpdateResult }> {
    if (!authentication) throw new AuthenticationRequiredError("Account authentication is required to activate a tree");
    const replay = this.acceptedStore.acceptedRequest(treeID, authentication.subject, requestDigest);
    if (replay) return replay;
    if (this.acceptedStore.acceptedChange(treeID, request.change)) throw new Error("Authored change identity is already bound to a different accepted request");
    const existing = this.get(treeID);
    if (existing) {
      const current = this.currentUpdate(treeID);
      if ((existing.ref === request.candidate || provenAcceptedPrefix) && current) {
        return { status: 200, result: { outcome: "unchanged", update: current, requestDigest } };
      }
      throw new UpdateProtocolError("activation-conflict", `TreeID is already active with different content: ${treeID}`);
    }
    const snapshot: TreeSnapshot = { root: request.candidate, objects: new Map(request.objects.map(({ hash, bytes }) => [hash, bytes])) };
    const tree = await this.activateTree(authentication, treeID, snapshot, requestDigest, request.change);
    const update = this.currentUpdate(tree.id);
    if (!update) throw new Error("Activation recorded no accepted update");
    return { status: 201, result: { outcome: "accepted", update, requestDigest } };
  }

  /** The subject an update to `tree` is recorded and replayed under. */
  private subjectFor(tree: CanopyTree, account: CanopyAccount | null, linkDigest: string | undefined, credentialSubject: string | undefined): string {
    if (isAccountConfigPolicy(tree.policy)) return this.configurationCaller(tree, account, credentialSubject).subject;
    const execution = this.execution.current;
    return execution?.code ? `execution:${execution.subject}:${execution.code}` : credentialSubject ?? (account ? `account:${account.id}` : linkDigest ? `link:${linkDigest}` : "public");
  }

  /** Only a device of the owning account may update its configuration tree. */
  private configurationCaller(tree: CanopyTree, account: CanopyAccount | null, credentialSubject: string | undefined): { account: CanopyAccount; subject: string } {
    if (!account || tree.accountID !== account.id || credentialSubject?.startsWith("device:") !== true) {
      throw new PermissionDeniedError("An active account device is required for configuration updates");
    }
    return { account, subject: credentialSubject };
  }

  /** Ordinary trees: graph and boundary validation, the Wire three-way merge, and community reconciliation. */
  private ordinaryPolicy(
    tree: CanopyTree,
    request: CandidateUpdate,
    account: CanopyAccount | null,
    linkDigest: string | undefined,
    credentialSubject: string | undefined,
  ): UpdatePolicy {
    const execution = this.execution.current;
    let effects: ResourceEffect[] = [];
    const checkEffects = async (before: string, after: string, objects: ReadonlyMap<ObjectHash, Uint8Array>) => {
      if (!execution) return;
      if (request.resolves.length || request.trace !== null) throw new PermissionDeniedError("Scoped execution operations/resolutions are not allowed until effect validation is available");
      effects = await resourceEffects(before, after, hash => this.objects.load(hash, objects));
      if (effects.some(e => !this.execution.allows(tree.id, e.path, e.operation, execution))) throw new PermissionDeniedError("Execution effects are not allowed");
    };
    return {
      subject: this.subjectFor(tree, account, linkDigest, credentialSubject),
      validateCandidate: async (root, objects) => {
        if (execution && !request.ifCurrent) throw new Error("Execution updates require an exact-state guard");
        await checkEffects(tree.ref, root, objects);
        await this.validateReservedBoundaries(tree, root, objects);
        const requiredType = this.requiredProfileType(tree.id, tree.canonicalPath);
        if (requiredType) await this.validateProfileRoot(root, objects, requiredType);
        if (tree.canonicalPath === "/") await this.validateCommunityReservations(root, objects);
      },
      validateAccepted: async (remoteTree, root, objects) => {
        await checkEffects(remoteTree.ref, root, objects);
        if (root === request.candidate) return;
        await this.validateGraph(root, objects, remoteTree.ref);
        await this.validateReservedBoundaries(remoteTree, root, objects);
        if (remoteTree.canonicalPath === "/") await this.validateCommunityReservations(root, objects);
      },
      prepareCommit: async (remoteTree) => ({
        withinTransaction: () => {
          if (execution && (!this.execution.covered(execution) || effects.some(e => !this.execution.allows(tree.id, e.path, e.operation, execution)))) throw new PermissionDeniedError("Execution permission is not allowed");
        },
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
    request: CandidateUpdate,
    baseRoot: ObjectHash,
    caller: CanopyAccount | null,
    credential: string | undefined,
    proposed: ReadonlyMap<ObjectHash, Uint8Array> = new Map(),
  ): UpdatePolicy {
    const { account, subject: credentialSubject } = this.configurationCaller(tree, caller, credential);
    const deviceID = credentialSubject.slice("device:".length);
    const graphAt = async (root: ObjectHash, objects?: ReadonlyMap<ObjectHash, Uint8Array>): Promise<AccountConfigGraphV2> => {
      const snapshot = await this.objects.completeSnapshot(root, objects);
      return readAccountConfigGraphV2(snapshot, tree.id);
    };
    let baseGraph: AccountConfigGraphV2;
    let candidateGraph: AccountConfigGraphV2;
    let currentGraph: AccountConfigGraphV2;
    let nextGraph: AccountConfigGraphV2;
    const authorize = (current: AccountConfigGraphV2, next: AccountConfigGraphV2, changesFrom: AccountConfigGraphV2) => {
      authorizeAccountConfigTransitionV2(
        current, next, deviceID, changesFrom,
        !!current.resources || !!this.db.query("SELECT 1 FROM meta WHERE key=?").get(resourcePolicyFormatKey(account.id)),
      );
    };
    return {
      subject: credentialSubject,
      rejection: { kind: "account-configuration", message: "The account configuration contains incompatible same-field edits" },
      validateCandidate: async (root, objects) => {
        candidateGraph = await graphAt(root, objects);
        this.validateCurrentCanopyAccountPaths(account.handle, candidateGraph, account);
        baseGraph = await graphAt(baseRoot);
        const current = this.currentUpdate(tree.id);
        if (!current) throw new Error("Account configuration has no accepted update");
        const acceptedGraph = await graphAt(current.root);
        if (request.resolves.length && !acceptedGraph.devices[deviceID]?.administrator) throw new PermissionDeniedError("Only an administrator may resolve policy conflicts");
        authorize(acceptedGraph, candidateGraph, baseGraph);
      },
      merge: (base, candidate, current) => this.mergeTool.tree(base, candidate, current, proposed,
        "account-config-v2"),
      validateAccepted: async (remoteTree, root, objects) => {
        currentGraph = await graphAt(remoteTree.ref);
        nextGraph = root === request.candidate ? candidateGraph : await graphAt(root, objects);
        this.validateCurrentCanopyAccountPaths(account.handle, nextGraph, account);
        authorize(currentGraph, nextGraph, currentGraph);
      },
      prepareCommit: async (_remoteTree, _root, now) => {
        const rewrites: Array<Awaited<ReturnType<CanopyDaemon["prepareParentAdvance"]>>> = [];
        for (const rewrite of await this.prepareAccountBoundaryRewrites(currentGraph, nextGraph))
          rewrites.push(await this.prepareParentAdvance(rewrite));
        const boundaryUpdates: AcceptedUpdate[] = [];
        return {
          withinTransaction: () => {
            this.applyAccountConfigDerived(account.id, currentGraph, nextGraph);
            for (const rewrite of rewrites) boundaryUpdates.push(this.advanceParent(rewrite, now, credentialSubject));
          },
          afterCommit: () => {
            for (const update of boundaryUpdates) this.notifyAccepted(update);
          },
        };
      },
    };
  }

  /**
   * Changes whenever anything an authorization decision reads may have
   * changed: an execution invalidation, a write through this connection, or a
   * commit by any other connection to the database. Equal values mean an
   * earlier decision over database state still holds.
   */
  authorizationEpoch(): string {
    const row = this.db.query("SELECT total_changes() AS local, (SELECT data_version FROM pragma_data_version) AS shared").get() as { local: number; shared: number };
    return `${this.execution.epoch}:${row.local}:${row.shared}`;
  }

  /** Live observation records for one tree, delivered after each durable append. */
  subscribeObservations(tree: string, listener: (record: ObservationRecord) => void): () => void {
    const listeners = this.observationListeners.get(tree) ?? new Set();
    listeners.add(listener);
    this.observationListeners.set(tree, listeners);
    return () => listeners.delete(listener);
  }

  observationPosition(tree: string, cursor: string | null) { return this.observations.position(tree, cursor); }
  observationPage(tree: string, after: number) { return this.observations.page(tree, after); }

  private notifyObservation(record: ObservationRecord): void {
    for (const listener of this.observationListeners.get(record.tree) ?? []) listener(record);
  }

  private notifyAccepted(update: AcceptedUpdate): void {
    this.execution.invalidate();
    const record = this.observations.forUpdate(update.id);
    if (record) this.notifyObservation(record);
  }

  async object(hash: ObjectHash): Promise<Uint8Array> {
    return this.objects.read(hash);
  }

  /** Prime validation proofs and retention closures for every tree's current
   * semantic state in the background, so the first edit after a restart does
   * not pay the cold history walk. Failures are logged and never fatal. */
  private warmSemanticStates(): void {
    const started = performance.now();
    const trees = (this.db.query("SELECT id FROM trees").all() as Array<{ id: string }>).map((row) => row.id);
    void (async () => {
      let warmed = 0;
      for (const tree of trees) {
        try {
          const current = this.currentUpdate(tree);
          if (!current) continue;
          const ref = this.semantic.state(current);
          const result = await this.mergeTool.warm(tree, { object: ref.object, state: ref.state });
          warmed++;
          if (process.env.NODE_ENV !== "test") console.log(JSON.stringify({ event: "warm", tree, reads: result.reads, ms: Math.round(result.milliseconds) }));
        } catch (error) {
          if (process.env.NODE_ENV !== "test") console.log(JSON.stringify({ event: "warm", tree, error: error instanceof Error ? error.message : String(error) }));
        }
      }
      if (process.env.NODE_ENV !== "test") console.log(JSON.stringify({ event: "warm-done", trees: warmed, ms: Math.round(performance.now() - started) }));
    })();
  }

  /** Snapshot of cumulative object read/write counters, for request diagnostics. */
  objectCounters(): Record<string, number> {
    return {
      objects: this.objects.writes.objects, written: this.objects.writes.written, fsyncs: this.objects.writes.fsyncs,
      reads: this.objects.readCounters.reads, "read-files": this.objects.readCounters.files, "read-bytes": this.objects.readCounters.bytes, "read-ms": this.objects.readCounters.milliseconds,
    };
  }

  /** Cheap readiness: SQLite answers and its pages are consistent. */
  verifyDatabase(): void {
    const rows = this.db.query("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
      throw new Error("Canopy SQLite integrity check failed");
    }
  }

  private integrityRun: Promise<void> | null = null;

  /** Verify SQLite plus every object reachable from retained accepted history.
   * This walks all retained history, so concurrent callers share one run. */
  verifyIntegrity(): Promise<void> {
    this.integrityRun ??= this.auditIntegrity().finally(() => { this.integrityRun = null; });
    return this.integrityRun;
  }

  private async auditIntegrity(): Promise<void> {
    this.verifyDatabase();
    const roots = (this.db.query("SELECT DISTINCT root FROM accepted_updates").all() as Array<{ root: ObjectHash }>)
      .map(({ root }) => root);
    await this.objects.verifyReachable(roots);
    const { retentionAudit } = await import("@overstory/canopyd-merge/retention");
    const auditRetention = retentionAudit(hash => this.objects.load(hash));
    const stateRoots = new Set<string>();
    for (const { accepted, record } of this.semantic.store.entries()) {
      const owner = this.update(accepted);
      if (!owner || owner.conflicted !== (record.decisions.length > 0))
        throw new Error("Invalid merge state ownership");
      stateRoots.add(record.state); stateRoots.add(record.authored);
    }
    if (this.db.query("SELECT 1 FROM accepted_updates u WHERE NOT EXISTS (SELECT 1 FROM accepted_merge_states m WHERE m.accepted_id = u.ordinal) LIMIT 1").get())
      throw new Error("Accepted update without a merge state");
    await auditRetention([...stateRoots]);
  }

  /** The object route is gated on tree read access only. Objects are
   * content-addressed and shared across trees, so a caller who can read any
   * tree may fetch any retained object whose hash they know; the route does not
   * prove reachability from that tree's roots or alternatives. */
  isReadableObject(treeID: string, account: CanopyAccount | null, linkDigest?: string): boolean {
    return this.get(treeID) !== null && this.canRead(account, treeID, linkDigest);
  }

  /** Retained object bytes, or null when no object has this hash. */
  async retainedObject(hash: ObjectHash): Promise<Uint8Array | null> {
    try { return await this.objects.read(hash); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
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
    requestDigest?: ObjectHash,
    change?: string,
  ): Promise<CanopyTree> {
    const path = normalizeBoundaryPath(canonicalPath);
    await this.validateGraph(snapshot.root, snapshot.objects);
    await this.objects.store([...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
    const id = requestedTreeID ?? generateArborID("tr");
    if (this.db.query("SELECT 1 FROM trees WHERE id = ?").get(id)) throw new Error(`TreeID already exists: ${id}`);
    // Attaching a fresh tree is the single-addition boundary rewrite; a plain
    // entry already at that name is replaced by the nested-tree entry.
    const attachment = parentTree
      ? await this.prepareParentAdvance(await this.prepareBoundaryRewrite(parentTree, [], [{ path, tree: id }], { replaceEntries: true }))
      : null;
    const staged = new Map(snapshot.objects);
    const mergeState = await this.semantic.checkpoint(id, null, snapshot.root, change ?? `initial:${id}`, staged);
    const profile = await this.profileFacts(snapshot.root, staged);
    await this.objects.store([...staged].map(([hash, bytes]) => ({ hash, bytes })));
    const initialChanges = await this.entryChanges(null, snapshot.root);
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run("INSERT INTO trees (id, ref, updated_at, account_id) VALUES (?, ?, ?, ?)", [id, snapshot.root, now, accountID ?? null]);
      this.db.run(
        "INSERT INTO boundaries (path, tree_id, parent_tree) VALUES (?, ?, ?)",
        [path, id, parentTree],
      );
      this.acceptedStore.insert({
        tree: id,
        root: snapshot.root,
        previousRoot: null,
        acceptedAt: now,
        subject: credentialSubject ?? null,
        requestDigest,
        change,
        entryChanges: initialChanges,
        mergeState,
      });
      recordProfileFacts(this.db, snapshot.root, profile);
      if (publicAccess !== "none") this.access.set(id, "everyone", "everyone", publicAccess);
      withinTransaction?.(id);
      if (attachment) this.advanceParent(attachment, now, credentialSubject ?? null);
    })();
    if (attachment) this.notifyAccepted(this.currentUpdate(attachment.tree)!);
    return this.get(id)!;
  }

  /** Everything a server-side rewrite of a canonical parent's boundaries needs
   * before its transaction: the stored objects, the entry changes, and a merge
   * state checkpointed onto the parent's current update. */
  private async prepareParentAdvance(rewrite: { parent: CanopyTree; nextRoot: ObjectHash; generated: Map<ObjectHash, Uint8Array> }) {
    const from = this.currentUpdate(rewrite.parent.id);
    if (!from || from.root !== rewrite.parent.ref) throw new RefConflictError(this.get(rewrite.parent.id)?.ref ?? null);
    const staged = new Map(rewrite.generated);
    const mergeState = await this.semantic.checkpoint(rewrite.parent.id, from, rewrite.nextRoot, `boundary:${crypto.randomUUID()}`, staged);
    const profile = await this.profileFacts(rewrite.nextRoot, staged);
    await this.objects.store([...staged].map(([hash, bytes]) => ({ hash, bytes })));
    const changes = await this.entryChanges(rewrite.parent.ref, rewrite.nextRoot);
    return { tree: rewrite.parent.id, previousRoot: rewrite.parent.ref, root: rewrite.nextRoot, expectedUpdate: from.id, entryChanges: changes, mergeState, profile };
  }

  /** Advance a canonical parent inside the caller's transaction, only from the
   * update its merge state was checkpointed onto. */
  private advanceParent(prepared: Awaited<ReturnType<CanopyDaemon["prepareParentAdvance"]>>, acceptedAt: number, subject: string | null): AcceptedUpdate {
    const { expectedUpdate, profile, ...input } = prepared;
    const accepted = this.acceptedStore.current(input.tree)?.id === expectedUpdate
      ? this.acceptedStore.advance({ ...input, acceptedAt, subject })
      : null;
    if (!accepted) throw new RefConflictError(this.get(input.tree)?.ref ?? null);
    recordProfileFacts(this.db, input.root, profile);
    return accepted;
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

  private async prepareAccountBoundaryRewrites(current: AccountConfigGraphV2, next: AccountConfigGraphV2) {
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
        const object = decodeWireDirectory(await this.objects.load(hash, proposed));
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
        } else if (entry.directory) {
          hash = entry.directory;
        } else {
          valid = false;
          break;
        }
      }
      if (!valid) throw new ReservedBoundaryConflictError(child.path, child.tree_id);
    }
  }

  private async validateProfileRoot(
    root: ObjectHash,
    proposed: ReadonlyMap<ObjectHash, Uint8Array>,
    kind: "person" | "group",
  ): Promise<void> {
    const directory = decodeWireDirectory(await this.objects.load(root, proposed));
    if (directory.type !== "directory") throw new Error("Profile root must be a directory");
    const index = directory.entries.find((entry) => entry.name === "_index.md");
    if (!index?.file) throw new Error("Profile tree requires _index.md");
    const file = await this.objects.load(index.file, proposed);
    const { frontmatter } = parseMarkdown(new TextDecoder().decode(file));
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

  private isProfileMember(groupTree: string, profileTree: string, handle: string | undefined): boolean {
    const tree = this.get(groupTree);
    if (!tree) return false;
    const profile = this.rootProfile(tree.ref);
    return profile.profiles.has(profileTree) || (handle !== undefined && profile.legacyHandles.has(handle));
  }

  private communityMemberHandles(): ReadonlySet<string> {
    return this.memberHandlesFromRoot(this.community().ref);
  }

  /** A root's profile facts, when it is a person or group profile root. */
  private async profileFacts(root: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array>): Promise<RootProfileFacts | null> {
    const facts = await rootProfileFacts(root, (hash) => this.objects.load(hash, proposed));
    return facts.type ? facts : null;
  }

  /**
   * Authorization reads each accepted root's stored profile facts (see
   * `storedProfileFacts` in profile.ts) by immutable root hash, so it never reparses mutable
   * filesystem state or treats display names as identity. A root without a
   * row declares no profile type.
   */
  private rootProfile(root: ObjectHash): RootProfile {
    const cached = this.rootProfiles.get(root);
    if (cached) return cached;
    const profile = storedProfileFacts(this.db, root);
    // Not memoized: a profile root's facts are stored when it is accepted.
    if (!profile) return { type: null, members: [], handles: new Set(), profiles: new Set(), legacyHandles: new Set() };
    const facts: RootProfile = {
      type: profile.type,
      members: profile.members,
      handles: memberHandles(profile.members),
      profiles: memberProfiles(profile.members),
      legacyHandles: new Set(profile.members.flatMap((member) => legacyMemberHandle(member) ?? [])),
    };
    if (this.rootProfiles.size >= ROOT_PROFILE_LIMIT) this.rootProfiles.delete(this.rootProfiles.keys().next().value!);
    this.rootProfiles.set(root, facts);
    return facts;
  }

  /** The root document's `type: person` or `type: group`, or null when it declares neither. */
  rootProfileType(root: ObjectHash): "person" | "group" | null {
    return this.rootProfile(root).type;
  }

  private memberHandlesFromRoot(root: ObjectHash): ReadonlySet<string> {
    return this.rootProfile(root).handles;
  }

  /**
   * canopyd's path policy. An account declares canonical paths below its own
   * /~handle. An account that can write the community profile may also
   * declare paths below any /~name that no person has reserved or claimed,
   * so top-level names can address groups or any other tree.
   */
  private validateCurrentCanopyAccountPaths(handle: string, graph: AccountConfigGraphV2, existingAccount?: CanopyAccount): void {
    const root = `/~${handle}`;
    const administersCommunity = !!existingAccount && this.canWrite(existingAccount, this.community().id);
    for (const [treeID, declaration] of Object.entries(graph.trees)) {
      const path = new URL(declaration.canonical).pathname;
      const retainedAdministeredTree = existingAccount
        && this.get(treeID)?.canonicalPath === path
        && this.canAdminister(existingAccount, treeID);
      if (sameOrDescendant(path, root) || retainedAdministeredTree) continue;
      const name = accountName(path);
      if (!name || !administersCommunity) {
        throw new Error(`Canonical path is outside this Canopy account allocation: ${path}`);
      }
      if (this.communityAccountReservations().has(name) || this.accountByHandle(name)) {
        throw new Error(`~${name} is reserved for a person on this Canopy: ${path}`);
      }
    }
    const profile = graph.trees[graph.account.profile];
    const rootTree = Object.entries(graph.trees).find(([, declaration]) => new URL(declaration.canonical).pathname === root)?.[0];
    // A newly claimed account may leave its profile unhosted. Once the
    // canonical handle is declared, however, that boundary is reserved for
    // the account's self-certifying Profile TreeID.
    if ((profile && new URL(profile.canonical).pathname !== root) || (rootTree && rootTree !== graph.account.profile)) {
      throw new Error("account.profile must match a tree declaration at its canonical handle");
    }
  }

  /**
   * Whether a tree not administered by the ~name account holds /~name or a
   * path below it, active or declared and awaiting its first update. A person
   * may then neither reserve nor claim that name.
   */
  private nameHeldByTree(name: string): boolean {
    const root = `/~${name}`;
    const below = `${root}/`;
    const owner = this.accountByHandle(name)?.id ?? null;
    return this.db.query(`
      SELECT 1 FROM trees t JOIN boundaries b ON b.tree_id = t.id
      WHERE t.status = 'active' AND (b.path = ? OR substr(b.path, 1, ?) = ?) AND (? IS NULL OR t.account_id IS NOT ?)
      UNION ALL
      SELECT 1 FROM tree_reservations
      WHERE (canonical_path = ? OR substr(canonical_path, 1, ?) = ?) AND (? IS NULL OR account_id IS NOT ?)
      LIMIT 1
    `).get(root, below.length, below, owner, owner, root, below.length, below, owner, owner) !== null;
  }

  /** A community update may not reserve a handle whose /~name a tree already holds. */
  private async validateCommunityReservations(root: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array>): Promise<void> {
    const facts = await rootProfileFacts(root, (hash) => this.objects.load(hash, proposed));
    const current = this.communityMemberHandles();
    for (const handle of memberHandles(facts.members)) {
      if (!current.has(handle) && this.nameHeldByTree(handle)) {
        throw new Error(`~${handle} is already the address of a tree on this Canopy`);
      }
    }
  }

  /** Current-Canopy allocation policy: structured local handles reserve /~handle. */
  private communityAccountReservations(): Map<string, { profileTree?: string }> {
    const reservations = new Map<string, { profileTree?: string }>();
    for (const member of this.rootProfile(this.community().ref).members) {
      const handle = member.handle ?? legacyMemberHandle(member);
      if (!handle || !HANDLE.test(handle)) continue;
      const profile = member.legacy ? undefined : profileLocatorTree(member.profile);
      reservations.set(handle, profile ? { profileTree: profile } : {});
    }
    return reservations;
  }

  private reconcileCommunityAccounts(): void {
    const members = this.communityMemberHandles();
    for (const account of this.db.query("SELECT handle FROM accounts").all() as Array<{ handle: string }>) {
      this.db.run("UPDATE accounts SET enabled = ? WHERE handle = ?", [members.has(account.handle) ? 1 : 0, account.handle]);
    }
  }

  private async validateGraph(root: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array>, acceptedBasis?: ObjectHash): Promise<void> {
    // acceptedBasis comes from the server's current tree, never from worker or
    // client assertions. A staged proof is only inherited once that root has
    // actually become accepted (and therefore durable).
    const collection = async (directory: ReturnType<typeof decodeWireDirectory>, load: (hash: string) => Promise<Uint8Array>) => {
      const source = directory.childrenSource!;
      const loadFile = async (name: string) => {
        const target = directory.entries.find(entry => entry.name === name)?.file;
        if (!target) throw Error(`Missing collection-file entry: ${name}`);
        return load(target);
      };
      await decodeWireCollectionFile(source, await loadFile(source.source), await loadFile(source.schemaSource), this.wireSchemas);
    };
    let basis = acceptedBasis ? this.validatedGraphs.get(acceptedBasis) : undefined;
    if (acceptedBasis && !basis)
      basis = await validateGraphChange(acceptedBasis, hash => this.objects.read(hash), new Map(), collection);
    const result = await validateGraphChange(root, hash => this.objects.read(hash), proposed, collection, basis);
    this.validatedGraphs.delete(root);
    this.validatedGraphs.set(root, result);
    while (this.validatedGraphs.size > 8 || [...this.validatedGraphs.values()].reduce((n, graph) => n + graph.objects.size, 0) > 200_000)
      this.validatedGraphs.delete(this.validatedGraphs.keys().next().value!);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.mergeTool[Symbol.asyncDispose]();
    await this.wireSchemas[Symbol.asyncDispose]();
    this.db.close();
    this.observationListeners.clear();
  }
}

function idOf(tree: string | CanopyTree): string {
  return typeof tree === "string" ? tree : tree.id;
}

function dirnameURL(path: string): string {
  const segments = pathSegments(path);
  if (segments.length <= 1) return "/";
  return `/${segments.slice(0, -1).join("/")}`;
}

/** Immutable object cache size; `ARBOR_OBJECT_CACHE_MB` overrides the 256 MB default. */
function objectCacheBytes(): number {
  return megabytes("ARBOR_OBJECT_CACHE_MB", 256);
}

function megabytes(variable: string, fallback: number): number {
  const configured = Number(process.env[variable]);
  return (Number.isFinite(configured) && configured >= 0 ? configured : fallback) * 1024 * 1024;
}
