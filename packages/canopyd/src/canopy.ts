import { EntryMetadataStore, entryChanges, type EntryChanges } from "./updates/entry-metadata.ts";
import { AuthenticationRequiredError, NotFoundError, PermissionDeniedError, ServerFaultError } from "./errors.ts";
import { validateGraphChange, type ValidatedGraph } from "./updates/graph-validation.ts";
import { ExecutionAuthority } from "./execution-authority.ts";
import { resourceEffects, type ResourceEffect } from "./resource-effects.ts";
import { MergeHistory } from "./updates/merge-history.ts";
import { LOG_ENTRY_FORMAT, MergeRefusal, type Asked, type Candidate, type LogDecision, type MergeAnswer, type MergeQuestion } from "@overstory/merge-protocol";
import { MergeTool, type MergeToolOptions } from "./merge-tool.ts";
import { retainedObjects } from "./retention.ts";
import { checkPlainTrace, TreeReader, type DecisionPage } from "@overstory/protocol";
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
} from "@overstory/protocol";
import { CollectionSchemaCache, decodeProtocolCollectionFile } from "@overstory/collection-schema";
import {
  validateUpdateRequestIntent,
  decodeProtocolDirectory,
  encodeProtocolDirectory,
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
} from "@overstory/protocol";
import {
  initialPersonConfig,
  readTreeConfigGraph,
  snapshotTreeConfig,
  treeConfigurationID,
  type ResourceAccessRule,
  type TreeConfigKind,
  type TreeConfigValues,
} from "@overstory/protocol";
import { authorizePersonConfigTransition, mergeTreeConfigTrees, TREE_CONFIG_POLICY_CONFLICT } from "./tree-config-policy.ts";
import { decideUpdate, reconcileUpdate, type MergeStrategy } from "./updates/reconcile.ts";
import { AcceptedUpdateStore } from "./updates/store.ts";
import { ObservationLog, type ObservationRecord } from "./updates/observations.ts";
import { buildAcceptedTransitionPayload } from "./updates/transition.ts";
import { ObjectStore } from "@overstory/object-store";
import { AccessControl } from "./access.ts";
import { AccountDirectory } from "./accounts.ts";
import {
  HANDLE, handleOfPath, legacyMemberHandle, memberReservations, profileChanged, profileLocatorTree,
  readRootProfile, readStoredProfile, rootIndexHash, storedProfileOf, writeStoredProfile,
  type RootProfileFacts, type RootProfileRead, type StoredProfile,
} from "./profile.ts";
import { isTreeConfigPolicy, type HostAccessEntry, type HostAccount, type HostAuthentication, type HostTree } from "./model.ts";
import { normalizeBoundaryPath, pathWithin, rewriteBoundaries, type BoundaryEdit, type BoundaryRewriteOptions } from "./boundaries.ts";
import { assertHostData, openHostDatabase } from "./schema.ts";
import { markPhase, phaseTimer } from "./updates/timing.ts";

export type { HostAccessEntry, HostAccount, HostAuthentication, HostTree } from "./model.ts";

export interface StoredUpdateResponse {
  status: number;
  result: UpdateResponse | UpdateConflictResult;
}

export interface HostBootstrapAccount {
  handle: string;
  token: string;
  name?: string;
  communityWriter?: boolean;
}

export interface HostBootstrap {
  handle: string;
  name: string;
  accounts: HostBootstrapAccount[];
  firstWriter?: {
    handle: string;
    profileTree: string;
    name?: string;
  };
}

/** The authorization-relevant profile facts of one tree's head. */
interface RootProfile {
  type: "person" | "group" | null;
  members: RootProfileFacts["members"];
  /** Community reservations: structured handles plus legacy `/~handle` locators. */
  reservations: ReadonlyMap<string, { profileTree?: string; inviteDigest?: string }>;
  /** Group membership for access: the Profile TreeID each member locator names. */
  profiles: ReadonlySet<string>;
  /** Group membership for access by a legacy `/~handle` locator alone. */
  legacyHandles: ReadonlySet<string>;
}
/** A tree's stored profile row and the facts authorization derives from it. */
interface TreeProfile {
  stored: StoredProfile | null;
  profile: RootProfile;
}
const NO_PROFILE: RootProfile = { type: null, members: [], reservations: new Map(), profiles: new Set(), legacyHandles: new Set() };
/** One accept's profile reads: each root's `_index.md` is parsed at most
 * once, and its validations and stored facts share the result. */
type ProfileReader = (root: ObjectHash, objects: ReadonlyMap<ObjectHash, Uint8Array>) => Promise<RootProfileRead>;
/** A profile write an accepted update makes: a row, null to delete the row,
 * or undefined when the update leaves `_index.md` and the avatar alone. */
type ProfileUpdate = StoredProfile | null | undefined;
/** Watch replay derives each update's transition from two roots; every
 * watcher of a tree replays the same recent updates. */
const TRANSITION_CACHE_ENTRIES = 32;

/** The Profile TreeID of every `arbor://<TreeID>/` member locator. */
function memberProfiles(members: RootProfile["members"]): ReadonlySet<string> {
  return new Set(members.flatMap((member) => {
    const profile = profileLocatorTree(member.profile);
    return profile ? [profile] : [];
  }));
}

/** One tree row with its boundary, as `treeRow` reads it. */
const TREE_SELECT = `
  SELECT t.*, b.path, b.parent_tree
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

/** A tree configuration's first update, prepared before its transaction. */
interface PreparedConfig {
  tree: string;
  kind: TreeConfigKind;
  values: TreeConfigValues;
  root: ObjectHash;
  entry: { hash: ObjectHash; conflicted: boolean };
  entryChanges: EntryChanges;
}

/** The profiles a configuration's `admin` rules name. */
function adminProfiles(access: readonly ResourceAccessRule[]): string[] {
  return [...new Set(access.flatMap((rule) => rule.allow.includes("admin") && typeof rule.who === "object" && "profile" in rule.who ? [rule.who.profile] : []))].sort();
}

/** Mount paths as canonical paths below a parent's root. */
function mountBelow(parentPath: string, mount: string): string {
  return parentPath === "/" ? `/${mount}` : `${parentPath}/${mount}`;
}

function directSnapshot(source: string): TreeSnapshot {
  const fileBytes = new TextEncoder().encode(source);
  const fileHash = hashObject(fileBytes);
  const rootBytes = encodeProtocolDirectory({
    type: "directory",
    entries: [{ name: "_index.md", file: fileHash }],
  });
  const rootHash = hashObject(rootBytes);
  return { root: rootHash, objects: new Map([[fileHash, fileBytes], [rootHash, rootBytes]]) };
}

function profileSource(
  kind: "person" | "group",
  name: string,
  members: Array<{ profile?: string; handle?: string }> = [],
  displayName: string | undefined = name,
): string {
  return [
    "---",
    `type: ${kind}`,
    ...(displayName ? [`displayName: ${JSON.stringify(displayName)}`] : []),
    ...(kind === "group"
      ? ["members:", ...members.flatMap((member) => [
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

export { CANOPY_SCHEMA_VERSION, SchemaMismatchError, assertHostData, assertHostSchemaVersion, assertCurrentHostSchema } from "./schema.ts";

/** The basis a batch element was authored on: an accepted log entry, and the
 * earlier candidates of the batch authored on it that no entry records as
 * their author wrote them. */
interface AuthoredBasis {
  entry: ObjectHash;
  prefix: Candidate[];
}

/** What an entry records of the question that produced it, beyond its own
 * fields: enough for a sidecar to ask it again with `previous` as the head. */
function asked(question: MergeQuestion, root: ObjectHash): Asked {
  const { candidate } = question;
  const end = candidate.trace ? candidate.trace.at(-1)?.after ?? root : root;
  return {
    ...(question.base !== question.head ? { base: question.base } : {}),
    ...(question.prefix?.length ? { prefix: question.prefix } : {}),
    ...(candidate.root !== end ? { candidate: candidate.root } : {}),
    ...(candidate.alternatives?.length ? { alternatives: candidate.alternatives } : {}),
    rules: question.rules,
  };
}

/** A question preflight already asked, reusable only verbatim. */
interface PreparedAnswer {
  question: MergeQuestion;
  answer: MergeAnswer;
  objects: Map<ObjectHash, Uint8Array>;
}

/**
 * What differs between tree policies inside the one update pipeline: who the
 * subject is, how a candidate and an accepted root are validated, which merge
 * runs when both sides changed, and what commits alongside the accepted row.
 */
interface UpdatePolicy {
  subject: string;
  /** The accept's profile reads, shared by validation and the stored facts. */
  profiles: ProfileReader;
  rejection?: { kind: "tree-configuration"; message: string };
  merge?: MergeStrategy;
  /** Validate the complete candidate graph once, before reconciliation. */
  validateCandidate(root: ObjectHash, objects: ReadonlyMap<ObjectHash, Uint8Array>): Promise<void>;
  /** Validate the root about to be accepted against the tree as it is now. */
  validateAccepted(remoteTree: HostTree, root: ObjectHash, objects: ReadonlyMap<ObjectHash, Uint8Array>): Promise<void>;
  /** Durable side effects for the accepted update; runs after every candidate object is stored. */
  prepareCommit(remoteTree: HostTree, root: ObjectHash, at: number): Promise<{
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

export class HostDaemon implements AsyncDisposable {
  private readonly wireSchemas = new CollectionSchemaCache();
  private readonly validatedGraphs = new Map<string, ValidatedGraph>();
  /** Stored profile rows by TreeID (`treeProfile`), committed state only. */
  private readonly treeProfiles = new Map<string, TreeProfile>();
  private db: Database;
  private acceptedStore: AcceptedUpdateStore;
  private readonly observations: ObservationLog;
  private readonly objects: ObjectStore;
  private readonly mergeTool: MergeTool;
  private readonly history: MergeHistory;
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
      ...mergeTool,
    });
    this.acceptedStore = new AcceptedUpdateStore(db);
    this.history = new MergeHistory(this.acceptedStore, this.objects);
    this.observations = new ObservationLog(db);
    this.accounts = new AccountDirectory(db);
    this.access = new AccessControl(db, {
      tree: (id) => this.get(id),
      isProfileMember: (group, profileTree, handle) => this.isProfileMember(group.id, profileTree, handle),
      rootProfileType: (tree) => this.rootProfileType(tree.id),
    });
    this.execution = new ExecutionAuthority((context, grant, path, operation) => this.access.executionAllows(context, grant, path, operation));
  }

  static async open(dataRoot: string, bootstrap?: HostBootstrap, mergeTool?: MergeToolOptions): Promise<HostDaemon> {
    await mkdir(join(dataRoot, "objects"), { recursive: true });
    const databasePath = join(dataRoot, "canopy.sqlite3");
    const db = openHostDatabase(databasePath);
    const canopy = new HostDaemon(dataRoot, db, mergeTool);
    await canopy.mergeTool.clearStaleJobs();
    if (!canopy.boundary("/")) {
      if (!bootstrap) throw new Error("A new Arbor server requires community bootstrap configuration");
      // One transaction, so a failure leaves no community and the next start bootstraps again.
      // Nested transactions below become savepoints; objects stored before a
      // rollback are unreferenced.
      db.run("BEGIN IMMEDIATE");
      try {
        await canopy.bootstrap(bootstrap);
        db.run("COMMIT");
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }
    }
    return canopy;
  }

  private async bootstrap(config: HostBootstrap): Promise<void> {
    if (!HANDLE.test(config.handle)) throw new Error(`Invalid community handle: ${config.handle}`);
    if (config.firstWriter && !HANDLE.test(config.firstWriter.handle)) {
      throw new Error(`Invalid first-writer handle: ${config.firstWriter.handle}`);
    }
    if (config.firstWriter && !isPersonProfileTreeID(config.firstWriter.profileTree)) {
      throw new Error("First-writer profile must be a self-certifying person Profile TreeID");
    }
    const preparedAccounts = config.accounts.map((account) => ({ account, profileTree: generateArborID("tr"), deviceID: generateArborID("dv") }));
    const members: Array<{ profile?: string; handle: string }> = [
      ...preparedAccounts.map(({ account, profileTree }) => ({
        profile: `arbor://${profileTree}/`,
        handle: account.handle,
      })),
      ...(config.firstWriter ? [{ profile: `arbor://${config.firstWriter.profileTree}/`, handle: config.firstWriter.handle }] : []),
    ];
    const community = await this.insertTree(directSnapshot(profileSource("group", config.name, members)), { root: true });
    // The community's members administer it. Bootstrap token accounts that
    // opted out of writing the community leave it to the others, named one by one.
    const writers = preparedAccounts.filter(({ account }) => account.communityWriter !== false).map(({ profileTree }) => profileTree);
    const everyMemberWrites = writers.length === preparedAccounts.length;
    const communityAdmins = everyMemberWrites || !writers.length ? [community.id] : writers;
    const communityConfig = await this.prepareConfig(community.id, "group", snapshotTreeConfig({
      access: [...communityAdmins.map((profile) => ({ who: { profile }, allow: ["admin" as const] })), { who: "everyone", allow: ["read"] }],
      mounts: {},
      apps: {},
    }));
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run("INSERT INTO meta (key, value) VALUES ('community_handle', ?)", [config.handle]);
      if (config.firstWriter) {
        this.db.run("INSERT INTO meta (key, value) VALUES ('first_writer_handle', ?)", [config.firstWriter.handle]);
      }
      this.insertConfig(communityConfig, now, null);
    })();
    for (const { account, profileTree, deviceID } of preparedAccounts) {
      if (!HANDLE.test(account.handle)) throw new Error(`Invalid account handle: ${account.handle}`);
      const label = "Initial device";
      const profileConfig = await this.prepareConfig(profileTree, "person", snapshotTreeConfig({
        ...initialPersonConfig(profileTree, { id: deviceID, label }),
        access: [{ who: { profile: profileTree }, allow: ["admin"] }, { who: "everyone", allow: ["read"] }],
      }));
      this.insertMemberMount(community.id, account.handle, profileTree);
      await this.insertTree(directSnapshot(profileSource("person", account.name ?? account.handle)), {
        id: profileTree,
        withinTransaction: () => {
          this.db.run("INSERT INTO accounts (id, handle, enabled) VALUES (?, ?, 1)", [profileTree, account.handle]);
          this.accounts.insertDevice(deviceID, profileTree, label, sha256(account.token), Date.now());
          this.insertConfig(profileConfig, Date.now(), null);
        },
      });
    }
  }

  private treeRow(value: unknown): HostTree | null {
    if (!value) return null;
    const row = value as {
      id: string;
      ref: string;
      path: string | null;
      parent_tree: string | null;
      policy: HostTree["policy"];
      status: HostTree["status"];
      governs: string | null;
    };
    return {
      id: row.id,
      canonicalPath: row.path,
      parentTree: row.parent_tree,
      kind: isTreeConfigPolicy(row.policy) ? "tree-configuration" : "ordinary",
      ref: row.ref,
      policy: row.policy,
      status: row.status,
      governs: row.governs,
    };
  }

  private treeSelect(where: string, value?: string): HostTree | null {
    const sql = `${TREE_SELECT} ${where}`;
    return this.treeRow(value === undefined ? this.db.query(sql).get() : this.db.query(sql).get(value));
  }

  list(): HostTree[] {
    return this.db.query(`${TREE_SELECT} ORDER BY b.path IS NULL, b.path`).all().map((row) => this.treeRow(row)!);
  }

  get(id: string): HostTree | null {
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
    const update = this.acceptedStore.current(tree);
    const tip: ObservationRecord | null = update ? { ordinal: Number(update.id), id: update.id, tree } : null;
    const basis = basisRecord ? this.update(basisRecord.id) : null;
    if (!basis || !update || !tip || tip.ordinal <= after) return null;
    const requestDigest = this.matchingRequestDigest(update.id, credentialSubject);
    const payload = await this.acceptedTransitionPayload(basis.root, update.root);
    return {record: tip, transition: {update, from: {id: basis.id, root: basis.root}, ...payload,
      ...(requestDigest ? {requestDigest} : {})}};
  }

  /** Decision inspection is pinned to one retained accepted state. */
  async conflictPage(
    tree: string,
    state: string,
    after?: string,
    conflict?: string
  ): Promise<DecisionPage | null> {
    const update = this.update(state);
    if (!update || update.tree !== tree) return null;
    const open = await this.history.decisions(update);
    const page = decisionPage(open.map((d) => d.inspection), tree, state, after, conflict);
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

  boundary(path: string): HostTree | null {
    return this.treeSelect("WHERE b.path = ?", normalizeBoundaryPath(path));
  }

  /** The tree whose canonical boundary most closely encloses `path`, and the path within it. */
  resolve(path: string): { tree: HostTree; path: string } | null {
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

  account(id: string): HostAccount | null {
    return this.accounts.account(id);
  }

  authenticateToken(token: string | undefined): HostAuthentication | null {
    return this.accounts.authenticateToken(token);
  }

  authenticationIsActive(authentication: HostAuthentication): boolean {
    if (!authentication.device) return false;
    const device = this.accounts.device(authentication.device);
    return Boolean(device && device.account === authentication.account.id && device.revokedAt === null && authentication.account.enabled);
  }

  devices(account: HostAccount): ServerDevice[] {
    return this.accounts.devices(account);
  }

  createPairing(account: HostAccount): PairingOffer {
    return this.accounts.createPairing(account);
  }

  createAccountChallenge(input: {
    origin: string;
    account?: string;
    profileTree: string;
    configurationTree: string;
    inviteCode?: string;
  }): AccountChallenge {
    if (input.inviteCode && !/^[A-Za-z0-9_-]{22}$/.test(input.inviteCode)) throw new Error("Invitation code is invalid");
    const inviteDigest = input.inviteCode ? `sha256:${sha256(input.inviteCode)}` : null;
    const matches = input.account === undefined
      ? [...this.communityReservations()].filter(([, value]) => inviteDigest
        ? value.inviteDigest === inviteDigest : value.profileTree === input.profileTree)
      : [];
    if (input.account === undefined && matches.length !== 1) {
      throw new Error(matches.length ? "Several reservations match this identity; enter an exact account URL" : "This community has not reserved an account for this identity");
    }
    const account = input.account ?? `${input.origin}/~${matches[0]![0]}`;
    const reservation = this.accountReservation(account);
    if (!reservation || (reservation.profileTree && reservation.profileTree !== input.profileTree)
      || (!reservation.profileTree && (!reservation.inviteDigest || reservation.inviteDigest !== inviteDigest))) {
      throw new Error("Account challenge requires an exact profile reservation");
    }
    if (!isPersonProfileTreeID(input.profileTree)) throw new Error("Account challenge requires a self-certifying person Profile TreeID");
    if (input.configurationTree !== treeConfigurationID(input.profileTree)) throw new Error("Account challenge requires the profile's configuration TreeID");
    if (this.accounts.account(input.profileTree) || this.get(input.profileTree)) throw new Error("This profile is already claimed or hosted on this Canopy");
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
    // An expired challenge can never be claimed, consumed or not.
    this.db.run("DELETE FROM account_challenges WHERE expires_at <= ?", [issuedAt]);
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
    const tokenDigest = deviceTokenDigest(input.credentialDigest);
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
    const now = Date.now();
    const accepted = await this.advanceConfig(account.profileTree, `pairing:${id}`, (values) => {
      if (values.devices?.[input.deviceID]) throw new Error("DeviceID is already active");
      return { ...values, devices: { ...values.devices, [input.deviceID]: { id: input.deviceID, label: safeLabel, administrator: false } } };
    }, () => {
      if (!this.accounts.claimPairing(id, input.deviceID, now)) throw new Error("Pairing is invalid, expired, or already used");
      this.accounts.insertDevice(input.deviceID, pairing.accountID, safeLabel, tokenDigest, now);
    });
    this.notifyAccepted(accepted);
    return { device: this.accounts.device(input.deviceID)!, confirmationCode: pairing.confirmationCode };
  }

  /**
   * The host operator's recovery for a person with no administrator device
   * left: every device is revoked and the person's `devices.yaml` becomes one
   * administrator device bound to `token`.
   */
  async resetAccountToken(handle: string, token: string): Promise<HostAccount> {
    if (!/^arb_[a-f0-9]{64}$/.test(token)) {
      throw new Error("A replacement account token must be arb_ followed by 64 lowercase hexadecimal characters");
    }
    const account = this.accountByHandle(handle);
    if (!account) throw new Error(`Unknown account: ~${handle}`);
    const deviceID = generateArborID("dv");
    const label = "Recovered device";
    const now = Date.now();
    const accepted = await this.advanceConfig(account.profileTree, `recovery:${deviceID}`, (values) => ({
      ...values,
      devices: { [deviceID]: { id: deviceID, label, administrator: true } },
    }), () => {
      this.accounts.revokeAllDevices(account.id, now);
      this.accounts.insertDevice(deviceID, account.id, label, sha256(token), now);
    });
    this.notifyAccepted(accepted);
    return this.account(account.id)!;
  }

  accountByHandle(handle: string): HostAccount | null {
    return this.accounts.accountByHandle(handle);
  }

  community(): HostTree {
    const community = this.boundary("/");
    if (!community) throw new ServerFaultError("Community profile is missing");
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
      this.communityReservations().has(handle)
    );
  }

  accountReservation(locator: string): { handle: string; profileTree?: string; inviteDigest?: string } | null {
    let url: URL;
    try { url = new URL(locator); } catch { return null; }
    const host = (this.db.query("SELECT value FROM meta WHERE key = 'community_host'").get() as { value: string } | null)?.value;
    const handle = handleOfPath(url.pathname);
    if (!handle || !host || url.host.toLowerCase() !== host) return null;
    const reservation = this.communityReservations().get(handle);
    return reservation ? { handle, ...reservation } : null;
  }

  /** The founder account's handle while it is still reserved for its profile and unclaimed; null once claimed or when the community was bootstrapped with token accounts. */
  unclaimedFounderHandle(): string | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = 'first_writer_handle'").get() as { value: string } | null;
    return row?.value ?? null;
  }

  setCommunityHost(host: string, allowTestPortChange = false): void {
    this.accounts.setCommunityHost(host, allowTestPortChange);
  }

  writableProfiles(account: HostAccount): HostTree[] {
    return this.list().filter((tree) =>
      tree.status === "active"
      && tree.canonicalPath !== null
      && tree.policy === "ordinary"
      && this.rootProfileType(tree.id) !== null
      && this.canWrite(account, tree)
    );
  }

  /** Which files a tree's configuration holds: a person's if an account
   * claims the tree as its profile, a group's if its head declares
   * `type: group`, and otherwise an ordinary tree's. */
  treeConfigKind(tree: string): TreeConfigKind {
    if (this.accounts.account(tree)) return "person";
    return this.rootProfileType(tree) === "group" ? "group" : "tree";
  }

  /** A configuration graph at a root. An accepted state written while its
   * tree was a group keeps reading as one, so an edit can remove `apps.yaml`. */
  private async configGraphAt(root: ObjectHash, kind: TreeConfigKind, tree: string, objects?: ReadonlyMap<ObjectHash, Uint8Array>, accepted = false) {
    const snapshot = await this.objects.completeSnapshot(root, objects);
    if (accepted && kind === "tree") {
      const names = decodeProtocolDirectory(snapshot.objects.get(root)!).entries.map((entry) => entry.name);
      if (names.includes("apps.yaml")) return readTreeConfigGraph(snapshot, "group", tree);
    }
    return readTreeConfigGraph(snapshot, kind, tree);
  }

  /** The accepted configuration of a tree, or null for a tree without one. */
  async treeConfig(tree: string): Promise<TreeConfigValues | null> {
    const configuration = this.get(treeConfigurationID(tree));
    if (!configuration) return null;
    return this.configGraphAt(configuration.ref, this.treeConfigKind(tree), tree, undefined, true);
  }

  /** Whether `device` is an administrator device of the account's person profile. */
  private async isAdministratorDevice(account: HostAccount, device: string | null): Promise<boolean> {
    if (!device) return false;
    return (await this.treeConfig(account.profileTree))?.devices?.[device]?.administrator === true;
  }

  /** A configuration's first accepted update, validated and stored before its transaction. */
  private async prepareConfig(tree: string, kind: TreeConfigKind, snapshot: TreeSnapshot): Promise<PreparedConfig> {
    const values = readTreeConfigGraph(snapshot, kind, tree);
    const id = treeConfigurationID(tree);
    await this.validateGraph(snapshot.root, snapshot.objects);
    const staged = new Map(snapshot.objects);
    const entry = await this.internalEntry(id, null, snapshot.root, `initial:${id}`, staged);
    const entryChanges = await this.entryChanges(null, snapshot.root);
    return { tree, kind, values, root: snapshot.root, entry, entryChanges };
  }

  /** Insert a prepared configuration and its index; callers run this inside their transaction. */
  private insertConfig(prepared: PreparedConfig, acceptedAt: number, subject: string | null, requestDigest?: ObjectHash, change?: string): AcceptedUpdate {
    const id = treeConfigurationID(prepared.tree);
    this.db.run("INSERT INTO trees (id, ref, policy, status, governs) VALUES (?, ?, 'tree-config-v1', 'active', ?)", [id, prepared.root, prepared.tree]);
    const accepted = this.acceptedStore.insert({
      tree: id, root: prepared.root, previousRoot: null, acceptedAt, subject, requestDigest, change,
      entryChanges: prepared.entryChanges, entry: prepared.entry,
    });
    this.indexTreeConfig(prepared.tree, prepared.kind, null, prepared.values);
    return accepted;
  }

  /**
   * canopyd's own edit of a tree's configuration (pairing, recovery): only
   * the files `change` alters are rewritten, in canonical form, and the rest
   * keep their authored bytes. `withinTransaction` runs before the index, so
   * it can bind the credentials the new `devices.yaml` names.
   */
  private async advanceConfig(
    tree: string,
    subject: string,
    change: (values: TreeConfigValues) => TreeConfigValues,
    withinTransaction: () => void,
  ): Promise<AcceptedUpdate> {
    const configuration = this.get(treeConfigurationID(tree));
    const from = configuration ? this.currentUpdate(configuration.id) : null;
    if (!configuration || !from) throw new Error("Tree configuration is missing");
    const kind = this.treeConfigKind(tree);
    const current = await this.configGraphAt(configuration.ref, kind, tree, undefined, true);
    const next = change(current);
    const canonical = snapshotTreeConfig(next);
    const directory = decodeProtocolDirectory(await this.objects.load(configuration.ref));
    const generated = decodeProtocolDirectory(canonical.objects.get(canonical.root)!);
    const same = (name: string) => JSON.stringify((current as unknown as Record<string, unknown>)[name.replace(".yaml", "")])
      === JSON.stringify((next as unknown as Record<string, unknown>)[name.replace(".yaml", "")]);
    const entries = generated.entries.map((entry) => same(entry.name) ? directory.entries.find((kept) => kept.name === entry.name) ?? entry : entry);
    const rootBytes = encodeProtocolDirectory({ type: "directory", entries });
    const root = hashObject(rootBytes);
    const staged = new Map(canonical.objects);
    staged.set(root, rootBytes);
    const snapshot = await this.objects.completeSnapshot(root, staged);
    const values = readTreeConfigGraph(snapshot, kind, tree);
    const entry = await this.internalEntry(configuration.id, from, root, subject, staged);
    const entryChanges = await this.entryChanges(configuration.ref, root);
    const accepted = this.acceptedStore.commit({
      entryChanges, tree: configuration.id, root, previousRoot: configuration.ref, expectedUpdate: from.id,
      acceptedAt: Date.now(), subject, entry,
    }, () => {
      withinTransaction();
      this.indexTreeConfig(tree, kind, current, values);
    });
    if (!accepted) throw new RefConflictError(this.get(configuration.id)?.ref ?? null);
    return accepted;
  }

  /**
   * Rewrite the derived index of one tree's configuration: its rules and
   * administrators, a profile's app entries, the tree's mounts, and for a
   * person the credential bindings `devices.yaml` names. Callers run this
   * inside the transaction that accepts the configuration.
   */
  private indexTreeConfig(tree: string, kind: TreeConfigKind, previous: TreeConfigValues | null, next: TreeConfigValues): void {
    this.db.run("INSERT INTO tree_policy (tree_id, rules_json) VALUES (?, ?) ON CONFLICT(tree_id) DO UPDATE SET rules_json = excluded.rules_json",
      [tree, JSON.stringify(next.access)]);
    this.db.run("DELETE FROM tree_admins WHERE tree_id = ?", [tree]);
    for (const profile of adminProfiles(next.access)) this.db.run("INSERT INTO tree_admins (tree_id, profile_tree) VALUES (?, ?)", [tree, profile]);
    this.db.run("DELETE FROM app_policy WHERE profile_tree = ?", [tree]);
    for (const [app, rules] of Object.entries(next.apps ?? {})) {
      this.db.run("INSERT INTO app_policy (profile_tree, app_tree, rules_json) VALUES (?, ?, ?)", [tree, app, JSON.stringify(rules)]);
    }
    this.db.run("DELETE FROM mounts WHERE parent_tree = ? AND member = 0", [tree]);
    for (const [path, child] of Object.entries(next.mounts)) {
      const held = this.db.query("SELECT parent_tree, path FROM mounts WHERE tree_id = ?").get(child) as { parent_tree: string; path: string } | null;
      if (held) throw new Error(`Tree ${child} is already mounted at another name`);
      if (this.db.query("SELECT 1 FROM mounts WHERE parent_tree = ? AND path = ?").get(tree, path)) throw new Error(`Mount name is taken: ${path}`);
      this.db.run("INSERT INTO mounts (parent_tree, path, tree_id, member) VALUES (?, ?, ?, 0)", [tree, path, child]);
    }
    if (kind === "person") {
      const now = Date.now();
      for (const id of Object.keys(previous?.devices ?? {})) {
        if (!next.devices?.[id]) this.db.run("UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND account_id = ?", [now, id, tree]);
      }
      for (const id of Object.keys(next.devices ?? {})) {
        const row = this.db.query("SELECT revoked_at FROM devices WHERE id = ? AND account_id = ?").get(id, tree) as { revoked_at: number | null } | null;
        if (!row) throw new Error(`Device ${id} has no credential binding`);
        if (row.revoked_at !== null) throw new Error(`Retired DeviceID cannot be reactivated: ${id}`);
      }
    }
    this.recomputeBoundaries();
  }

  /** The community root mounts a member's profile at `/~handle`; callers run this inside their transaction. */
  private insertMemberMount(root: string, handle: string, profile: string): void {
    this.db.run("INSERT INTO mounts (parent_tree, path, tree_id, member) VALUES (?, ?, ?, 1) ON CONFLICT DO NOTHING", [root, `~${handle}`, profile]);
  }

  /** Where a tree is mounted, if anywhere. */
  private mountOf(tree: string): { parent: string; path: string } | null {
    const row = this.db.query("SELECT parent_tree, path FROM mounts WHERE tree_id = ?").get(tree) as { parent_tree: string; path: string } | null;
    return row ? { parent: row.parent_tree, path: row.path } : null;
  }

  /**
   * Canonical boundaries follow from the mounts: each active ordinary tree
   * mounted in a tree that has a canonical path has one below it. A tree
   * mounted nowhere, or below one that is not canonical, has none. Callers
   * run this inside their transaction.
   */
  private recomputeBoundaries(): void {
    const root = this.db.query("SELECT tree_id FROM boundaries WHERE path = '/'").get() as { tree_id: string } | null;
    if (!root) return;
    const mounts = this.db.query(`
      SELECT m.parent_tree, m.path, m.tree_id FROM mounts m JOIN trees t ON t.id = m.tree_id
      WHERE t.status = 'active' AND t.policy = 'ordinary' ORDER BY m.parent_tree, m.path
    `).all() as Array<{ parent_tree: string; path: string; tree_id: string }>;
    const byParent = new Map<string, typeof mounts>();
    for (const mount of mounts) byParent.set(mount.parent_tree, [...byParent.get(mount.parent_tree) ?? [], mount]);
    const desired: Array<{ path: string; tree: string; parent: string }> = [];
    const visited = new Set([root.tree_id]);
    const queue: Array<{ tree: string; path: string }> = [{ tree: root.tree_id, path: "/" }];
    while (queue.length) {
      const { tree, path } = queue.shift()!;
      for (const mount of byParent.get(tree) ?? []) {
        if (visited.has(mount.tree_id)) continue;
        visited.add(mount.tree_id);
        const childPath = mountBelow(path, mount.path);
        desired.push({ path: childPath, tree: mount.tree_id, parent: tree });
        queue.push({ tree: mount.tree_id, path: childPath });
      }
    }
    this.db.run("DELETE FROM boundaries WHERE path <> '/'");
    for (const boundary of desired) {
      this.db.run("INSERT INTO boundaries (path, tree_id, parent_tree) VALUES (?, ?, ?)", [boundary.path, boundary.tree, boundary.parent]);
    }
  }

  /**
   * Declare a tree: accept the first snapshot of its configuration, which
   * must make the submitter's profile an administrator. The tree is then
   * `awaiting-initialization` until an administrator activates it.
   */
  async declareTree(tree: string, request: UpdateRequest, authentication: HostAuthentication | null): Promise<StoredUpdateResponse> {
    if (!authentication?.device) throw new AuthenticationRequiredError("A device is required to declare a tree");
    validateUpdateRequestIntent(request);
    if (request.base !== null || request.updates.length !== 1 || request.updates[0]!.trace !== null || request.updates[0]!.resolves.length) {
      throw new Error("Declaring a tree is one snapshot update of its configuration with a null base");
    }
    const configurationID = treeConfigurationID(tree);
    const update = request.updates[0]!;
    const [requestDigest] = updateRequestDigests(configurationID, request);
    const replay = this.acceptedStore.acceptedRequest(configurationID, authentication.subject, requestDigest!);
    if (replay) return { status: replay.status, result: { results: [replay.result], observedThrough: this.observedThrough(configurationID) } };
    if (!isGeneratedArborID(tree, "tr")) throw new Error("A declared tree requires a generated TreeID");
    if (this.get(tree) || this.get(configurationID)) throw new UpdateProtocolError("activation-conflict", `TreeID is already declared: ${tree}`);
    const account = authentication.account;
    if (!await this.isAdministratorDevice(account, authentication.device)) throw new PermissionDeniedError("Only an administrator device may declare a tree");
    const snapshot: TreeSnapshot = { root: update.candidate, objects: new Map(update.objects.map(({ hash, bytes }) => [hash, bytes])) };
    const prepared = await this.prepareConfig(tree, "tree", snapshot);
    const admins = adminProfiles(prepared.values.access);
    if (!admins.some((admin) => admin === account.profileTree || this.access.isGroupMember(admin, account.profileTree))) {
      throw new PermissionDeniedError("A declared tree's configuration must make the submitter an administrator");
    }
    this.checkMountAdditions(tree, account, {}, prepared.values.mounts);
    let accepted!: AcceptedUpdate;
    this.db.transaction(() => {
      accepted = this.insertConfig(prepared, Date.now(), authentication.subject, requestDigest, update.change);
    })();
    this.notifyAccepted(accepted);
    return { status: 201, result: { results: [{ outcome: "accepted", update: accepted, requestDigest: requestDigest! }], observedThrough: this.observedThrough(configurationID) } };
  }

  /**
   * Mounting a tree needs its submitter to administer both trees; renaming
   * or removing a mount needs only the parent's administrators. The root may
   * not mount a name a person holds, and nothing mounts the root or a
   * configuration.
   */
  private checkMountAdditions(parent: string, account: HostAccount, before: Record<string, string>, after: Record<string, string>): void {
    const held = new Set(Object.values(before));
    const community = this.boundary("/")?.id;
    for (const [path, child] of Object.entries(after)) {
      if (parent === community) {
        const handle = /^~([^/]+)/.exec(path)?.[1];
        if (handle && (this.communityReservations().has(handle) || this.accountByHandle(handle))) {
          throw new Error(`~${handle} is reserved for a person on this Canopy`);
        }
      }
      if (held.has(child)) continue;
      if (child === community || child === parent) throw new Error(`Tree ${child} cannot be mounted here`);
      const existing = this.get(child);
      if (existing && existing.policy !== "ordinary") throw new Error("A tree configuration cannot be mounted");
      if (!existing && !this.get(treeConfigurationID(child))) throw new Error(`Unknown tree: ${child}`);
      if (!this.access.administers(account.profileTree, child)) {
        throw new PermissionDeniedError(`Mounting ${child} requires administering it`);
      }
      const mounted = this.mountOf(child);
      if (mounted && mounted.parent !== parent) throw new Error(`Tree ${child} is already mounted elsewhere`);
    }
  }

  private async activateTree(
    authentication: HostAuthentication,
    treeID: string,
    snapshot: TreeSnapshot,
    requestDigest?: ObjectHash,
    change?: string,
  ): Promise<HostTree> {
    if (!isGeneratedArborID(treeID, "tr") && !isPersonProfileTreeID(treeID)) {
      throw new Error("New tree activation requires a generated TreeID");
    }
    const existing = this.get(treeID);
    if (existing) {
      if (existing.ref === snapshot.root) return existing;
      throw new UpdateProtocolError("activation-conflict", `TreeID is already active with different content: ${treeID}`);
    }
    if (!this.get(treeConfigurationID(treeID))) throw new Error(`TreeID is not declared for activation: ${treeID}`);
    if (!this.access.administers(authentication.account.profileTree, treeID)) throw new PermissionDeniedError("Only an administrator may initialize a tree");
    if (!await this.isAdministratorDevice(authentication.account, authentication.device)) throw new PermissionDeniedError("Only an administrator device may initialize a tree");
    const requiredType = this.requiredProfileType(treeID, null);
    const profiles = this.profileReader();
    if (requiredType) checkProfileType((await profiles(snapshot.root, snapshot.objects)).facts, requiredType);
    return this.insertTree(snapshot, { id: treeID, subject: authentication.subject, requestDigest, change, profiles });
  }

  scopedCaller(account: HostAccount | null, tree: string, subject: string, active: () => boolean, linkDigest?: string) {
    return this.access.directExecution(account, tree, subject, active, linkDigest);
  }

  /** A tree's rules as its administrators see them; links redacted. */
  resourcePolicy(account: HostAccount, tree: string) {
    return this.canAdminister(account, tree) ? this.access.safePolicy(tree) : undefined;
  }

  accessEntries(tree: string): HostAccessEntry[] {
    return this.access.entries(tree);
  }

  communityMembers(): RootProfileFacts["members"] {
    return this.rootProfile(this.community().id).members;
  }

  handleForProfile(profileTree: string): string | undefined {
    return this.accounts.handleForProfile(profileTree);
  }

  /** A tree's complete profile facts, card fields included, from its stored
   * row. A tree without a row is not a profile. */
  profileCard(tree: string | HostTree): RootProfileFacts {
    return this.treeProfile(idOf(tree)).stored?.facts ?? { version: 3, type: null, members: [] };
  }

  /** Every active tree whose head declares `type: group`, with its facts: one query. */
  groupProfiles(): Array<{ tree: string; facts: RootProfileFacts }> {
    return (this.db.query(`
      SELECT p.tree_id, p.facts FROM profile_facts p JOIN trees t ON t.id = p.tree_id
      WHERE t.status = 'active' AND json_extract(p.facts, '$.type') = 'group'
      ORDER BY p.tree_id
    `).all() as Array<{ tree_id: string; facts: string }>)
      .map((row) => ({ tree: row.tree_id, facts: JSON.parse(row.facts) as RootProfileFacts }));
  }

  /** `tree` is an ID, or a tree the caller already read, which saves reading it again. */
  canRead(account: HostAccount | null, tree: string | HostTree, linkDigest?: string): boolean {
    return this.execution.current ? this.execution.allows(idOf(tree), "/", "read") : this.access.canRead(account, tree, linkDigest);
  }

  canWrite(account: HostAccount | null, tree: string | HostTree, linkDigest?: string): boolean {
    return this.execution.current ? this.execution.allows(idOf(tree), "/", "write") : this.access.canWrite(account, tree, linkDigest);
  }

  canAdminister(account: HostAccount, tree: string | HostTree): boolean {
    return !this.execution.current && this.access.canAdminister(account, tree);
  }

  /**
   * Claim a Canopy-allocated account locator for a stable profile TreeID.
   * The claim declares the profile tree with its configuration; the profile's
   * content is activated afterwards by an ordinary null-base update.
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
    inviteCode?: string;
    deviceID: string;
    deviceLabel: string;
    credentialDigest: string;
    configurationSnapshot: TreeSnapshot;
  }): Promise<{ account: HostAccount; configuration: HostTree }> {
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
    if (!isPersonProfileTreeID(input.profileTree) || input.configurationTree !== treeConfigurationID(input.profileTree)) {
      throw new Error("Account join requires a person Profile TreeID and its configuration TreeID");
    }
    if (!isGeneratedArborID(input.deviceID, "dv")) throw new Error("Account join requires a client-generated 128-bit DeviceID");
    const tokenDigest = deviceTokenDigest(input.credentialDigest);
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
    if (!this.communityReservations().has(input.handle)) {
      throw new Error(`Profile is not reserved by the community: ~${input.handle}`);
    }
    if (reservation.profileTree && reservation.profileTree !== input.profileTree) {
      throw new Error("Account reservation names a different profile TreeID");
    }
    // One host per profile: a profile claimed or hosted here cannot be claimed again.
    if (this.accounts.account(input.profileTree) || this.get(input.profileTree) || this.get(input.configurationTree)) {
      throw new Error("This profile is already claimed or hosted on this Canopy");
    }
    const invitation = reservation.inviteDigest
      ? await this.prepareInvitationClaim(input.handle, reservation.inviteDigest, input.inviteCode, input.profileTree)
      : null;
    // The claim declares the profile tree: its configuration, with the joining
    // device as the first administrator device and the profile as its only
    // administrator. The profile is awaiting initialization until activated.
    const prepared = await this.prepareConfig(input.profileTree, "person", input.configurationSnapshot);
    const devices = prepared.values.devices ?? {};
    if (Object.keys(devices).length !== 1 || !devices[input.deviceID] || devices[input.deviceID]!.label !== input.deviceLabel) {
      throw new Error("Initial configuration must contain exactly the joining device and matching label");
    }
    if (!devices[input.deviceID]!.administrator) throw new Error("The joining device must be the first administrator");
    if (Object.keys(prepared.values.mounts).length) throw new Error("An initial profile configuration mounts nothing");
    const community = this.community();
    const now = Date.now();
    this.db.transaction(() => {
      const consumed = this.db.run(
        "UPDATE account_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?",
        [now, proof.challenge.id, now],
      );
      if (consumed.changes !== 1) throw new Error("Account challenge was already consumed or expired");
      this.db.run(
        "INSERT INTO accounts (id, handle, claim_digest, enabled) VALUES (?, ?, ?, 1)",
        [input.profileTree, input.handle, claimDigest],
      );
      this.accounts.insertDevice(input.deviceID, input.profileTree, input.deviceLabel, tokenDigest, now);
      this.insertConfig(prepared, now, `device:${input.deviceID}`);
      this.insertMemberMount(community.id, input.handle, input.profileTree);
      if (this.unclaimedFounderHandle() === input.handle) this.db.run("DELETE FROM meta WHERE key = 'first_writer_handle'");
      if (invitation) this.advanceParent(invitation, now, `invite:${input.handle}`);
    })();
    if (invitation) this.notifyAccepted(this.currentUpdate(invitation.tree)!);
    return { account: this.account(input.profileTree)!, configuration: this.get(input.configurationTree)! };
  }

  /** Replace the canonical invitation entry without rewriting unrelated authored Markdown. */
  private async prepareInvitationClaim(handle: string, digest: string, code: string | undefined, profileTree: string) {
    if (!code || !/^[A-Za-z0-9_-]{22}$/.test(code) || `sha256:${sha256(code)}` !== digest) {
      throw new Error("Invitation code is invalid");
    }
    const community = this.community();
    const directory = decodeProtocolDirectory(await this.objects.load(community.ref));
    const index = directory.entries.findIndex((entry) => entry.name === "_index.md" && entry.file);
    if (index < 0) throw new ServerFaultError("Community profile has no root document");
    const source = new TextDecoder().decode(await this.objects.load(directory.entries[index]!.file!));
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    const lines = source.split(newline);
    const end = lines.indexOf("---", 1);
    const matches: Array<{ start: number; count: number }> = [];
    const handleLine = new RegExp(`^handle: ["']?${handle}["']?$`);
    const digestLine = new RegExp(`^inviteDigest: ["']?${digest}["']?$`);
    for (let i = 1; i < end - 1; i++) {
      if (lines[i]?.trim().match(new RegExp(`^- handle: ["']?${handle}["']?$`))
        && lines[i + 1]?.trim().match(digestLine)) matches.push({ start: i, count: 2 });
      if (lines[i]?.trim() === "-" && lines[i + 1]?.trim().match(handleLine)
        && lines[i + 2]?.trim().match(digestLine)) matches.push({ start: i, count: 3 });
    }
    if (matches.length !== 1) throw new Error("Invitation entry changed; ask the administrator to renew it");
    const match = matches[0]!;
    const indent = lines[match.start]!.match(/^\s*/)?.[0] ?? "  ";
    lines.splice(match.start, match.count, `${indent}- profile: ${JSON.stringify(`arbor://${profileTree}/`)}`, `${indent}  handle: ${JSON.stringify(handle)}`);
    const bytes = new TextEncoder().encode(lines.join(newline));
    const file = hashObject(bytes);
    const nextDirectory = encodeProtocolDirectory({
      ...directory,
      entries: directory.entries.map((entry, i) => i === index ? { name: entry.name, file } : entry),
    });
    const root = hashObject(nextDirectory);
    const generated = new Map<ObjectHash, Uint8Array>([[file, bytes], [root, nextDirectory]]);
    await this.validateGraph(root, generated, community.ref);
    return this.prepareParentAdvance({ parent: community, nextRoot: root, generated });
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
    return buildAcceptedTransitionPayload(previousRoot, root, this.storedReader());
  }

  /** The file entries an accepted update writes, read before its transaction. */
  private entryChanges(previousRoot: ObjectHash | null, root: ObjectHash): Promise<EntryChanges> {
    return entryChanges(previousRoot, root, this.storedReader());
  }

  /** A tree reader over durable objects, which the store verifies as it reads them. */
  private storedReader(): TreeReader {
    return new TreeReader((hash) => this.object(hash), { verified: true });
  }

  async submitUpdate(
    treeID: string,
    request: UpdateRequest,
    account: HostAccount | null = null,
    linkDigest?: string,
    credentialSubject?: string,
    authentication?: HostAuthentication,
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
    account: HostAccount | null = null,
    linkDigest?: string,
    credentialSubject?: string,
    authentication?: HostAuthentication
  ): Promise<StoredUpdateResponse> {
    validateUpdateRequestIntent(request);
    if (this.execution.current && (request.base === null || request.updates.length !== 1 || request.updates.some(u => u.trace !== null || u.resolves.length))) throw new PermissionDeniedError("Execution update form is not allowed");
    const retainedTree = this.get(treeID);
    // Preflight the whole batch: unsupported semantics must never accept a prefix.
    for (const [index, update] of request.updates.entries()) {
      if (
        (request.base === null ||
          isTreeConfigPolicy(retainedTree?.policy ?? "ordinary")) &&
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
    const writable = retainedTree !== null && (this.canWrite(account, retainedTree, linkDigest) || this.execution.canSubmit(treeID));
    const subject = writable ? this.subjectFor(retainedTree, account, linkDigest, credentialSubject) : null;
    if (subject !== null) {
      for (let index = digests.length - 1; index >= 0; index--) {
        if (this.acceptedStore.acceptedRequest(treeID, subject, digests[index]!)) { recordedThrough = index; break; }
      }
    }
    const traced = request.base !== null && request.updates.some((update) => update.trace !== null);
    if (traced && subject === null) throw new PermissionDeniedError("Write access is not allowed");
    markPhase("receipts");
    // The author's basis for each element: an accepted entry, and the batch
    // candidates authored on it that no entry records as the author wrote them.
    let basis: AuthoredBasis | null = request.base ? { entry: (await this.history.entryFor(request.base)).hash, prefix: [] } : null;
    let prepared: PreparedAnswer | undefined;
    if (traced && request.base !== null && subject !== null) {
      // Receipts precede execution: a tool upgrade/outage cannot alter an exact retry.
      if (recordedThrough === request.updates.length - 1) {
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
      // Check every traced element against the request's base before any is
      // accepted: invalid or unsupported evidence must never accept a prefix.
      const objects = new Map<ObjectHash, Uint8Array>();
      const base = this.update(request.base)!;
      const baseEntry = basis!.entry;
      const open = (await this.history.decisions(base)).map((d) => d.decision);
      const preflight: AuthoredBasis = { entry: baseEntry, prefix: [] };
      let root = base.root;
      // Plain elements chain: each is checked on the one before it.
      let plainSoFar = true;
      markPhase("preflight-state");
      for (const [index, update] of request.updates.entries()) {
        for (const object of update.objects) objects.set(object.hash, object.bytes);
        if (index > recordedThrough) {
          for (const object of await this.objects.reconstructDeltas(root, update.deltas, objects))
            objects.set(object.hash, object.bytes);
          if (update.trace !== null) {
            const plain: boolean = plainSoFar && !update.resolves.length && await this.fastForward(root, update, open, objects);
            plainSoFar &&= plain;
            if (!plain) {
              const candidate = await this.candidate(treeID, update, await this.history.resolutionKeys(treeID, update.resolves));
              const question: MergeQuestion = { base: baseEntry, head: baseEntry, ...(preflight.prefix.length ? { prefix: [...preflight.prefix] } : {}), candidate, rules: this.rules() };
              try {
                const asked = await this.mergeTool.ask(question, objects);
                markPhase("preflight-evaluate");
                if (index === 0) prepared = { question, ...asked };
              } catch (error) {
                if (error instanceof MergeRefusal && error.code === "unsupported")
                  throw new UpdateProtocolError("unsupported-operation", error.message);
                throw error;
              }
            }
          } else plainSoFar = false;
        } else {
          // Receipts prove acceptance, not that the author's candidate chain
          // is plain (acceptance may have merged it). Recheck the retained
          // trace so an ordinary accepted prefix does not force its new tail
          // through the sidecar, while causal prefixes still do.
          plainSoFar &&= update.trace !== null && !update.resolves.length &&
            await this.fastForward(root, update, open, objects);
        }
        preflight.prefix.push(await this.candidate(treeID, update, []));
        root = update.candidate;
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
        basis = { entry: (await this.history.entryFor(activation.result.update)).hash, prefix: [] };
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
        basis!,
        account,
        linkDigest,
        credentialSubject,
        index < recordedThrough,
        index === 0 ? prepared : undefined,
      );
      if ("error" in result.result) {
        result.result.details.completed = completed;
        result.result.details.failedIndex = index;
        return { status: result.status, result: result.result };
      }
      completed.push(result.result);
      accepted ||= result.result.outcome !== "unchanged";
      // An element accepted exactly as authored on the basis entry is the
      // next element's basis; any other is carried as authored.
      const entry = result.result.outcome === "accepted" ? await this.history.entryFor(result.result.update) : null;
      basis = entry && !basis!.prefix.length && entry.entry.previous === basis!.entry && entry.entry.root === update.candidate && entry.entry.asked?.base === undefined
        ? { entry: entry.hash, prefix: [] }
        : { entry: basis!.entry, prefix: [...basis!.prefix, await this.candidate(treeID, update, [])] };
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

  /** The reference sidecar's rules as canopyd configures them. */
  private rules(): MergeQuestion["rules"] {
    return {
      id: "tree-default",
      revision: 1,
      config: { contentChoices: this.mergeTool.contentChoices, conflictProjection: "current", maxMillis: this.mergeTool.evaluationMillis },
    };
  }

  /** A client update as a question names it: its trace, the decision keys it
   * resolves and the alternatives its operations name. */
  private async candidate(tree: string, update: CandidateUpdate, resolves: string[]): Promise<Candidate> {
    const alternatives = update.trace ? await this.history.bindings(tree, update.trace) : [];
    return {
      root: update.candidate,
      change: update.change,
      trace: update.trace,
      resolves,
      ...(alternatives.length ? { alternatives } : {}),
    };
  }

  /** Whether canopyd can accept a traced update on `root` without a question:
   * a plain trace it reproduces exactly, touching nothing an open decision
   * concerns. A miss is logged with its reason and goes to the sidecar. */
  private async fastForward(
    root: ObjectHash,
    update: CandidateUpdate,
    open: readonly LogDecision[],
    objects: ReadonlyMap<ObjectHash, Uint8Array>,
  ): Promise<boolean> {
    const miss = (reason: string) => {
      phaseTimer()?.count("fast-forward-miss", 1);
      console.info(`Fast-forward fell through: ${reason}`);
      return false;
    };
    if (!update.trace?.length) return miss("no frames");
    if (update.trace[0]!.before !== root) return miss("trace is not authored on the head");
    const checked = await checkPlainTrace(update.trace, (hash) => this.objects.load(hash, objects));
    if (!checked.plain) return miss(checked.reason);
    const concerned = open.find((d) => !d.path || checked.touched.some((path) => pathWithin(path, `/${d.path!.join("/")}`)));
    if (concerned) return miss("an open decision concerns the update");
    return true;
  }

  private async submitCandidateLocked(
    treeID: string,
    baseRoot: ObjectHash,
    request: CandidateUpdate,
    requestDigest: ObjectHash,
    proposed: Map<ObjectHash, Uint8Array>,
    basis: AuthoredBasis,
    account: HostAccount | null = null,
    linkDigest?: string,
    credentialSubject?: string,
    provenAcceptedPrefix = false,
    prepared?: PreparedAnswer,
  ): Promise<{ status: number; result: UpdateResult | UpdateConflictResult }> {
    const tree = this.get(treeID);
    if (!tree) throw new NotFoundError(`Unknown tree: ${treeID}`);
    if (!(this.canWrite(account, tree, linkDigest) || this.execution.canSubmit(treeID))) throw new PermissionDeniedError("Write access is not allowed");
    const policy = isTreeConfigPolicy(tree.policy)
      ? this.treeConfigPolicy(tree, request, baseRoot, account, credentialSubject, proposed)
      : this.ordinaryPolicy(tree, request, account, linkDigest, credentialSubject);
    const { subject } = policy;
    const execution = this.execution.current;
    if (execution) {
      if (this.currentUpdate(treeID)?.conflicted) throw new PermissionDeniedError("Execution updates of conflicted trees are not allowed until alternative scope validation is available");
      if (!request.ifCurrent || request.trace !== null || request.resolves.length) throw new PermissionDeniedError("Execution update form is not allowed");
      const effects = await resourceEffects(baseRoot, request.candidate, hash => this.objects.load(hash, proposed));
      if (!this.execution.covered(execution) || effects.some(e => !this.execution.granted(treeID, e.path, e.operation, execution))) throw new PermissionDeniedError("Execution effects are not allowed");
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
    return this.submitSemanticCandidate(tree, baseRoot, request, requestDigest, proposed, policy, basis, prepared);
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

  /**
   * Every candidate, traced or snapshot, on every tree policy, becomes one log
   * entry after the tree's current one. A plain traced edit on the head that
   * no open decision concerns is accepted as authored. Everything else is one
   * question to the merge sidecar; governed account configuration is merged
   * here first and the sidecar asked only to carry its decisions forward.
   */
  private async submitSemanticCandidate(
    tree: HostTree,
    baseRoot: ObjectHash,
    request: CandidateUpdate,
    requestDigest: ObjectHash,
    proposed: Map<ObjectHash, Uint8Array>,
    policy: UpdatePolicy,
    basis: AuthoredBasis,
    prepared?: PreparedAnswer,
  ): Promise<{ status: number; result: UpdateResult | UpdateConflictResult }> {
    const governed = isTreeConfigPolicy(tree.policy);
    for (let race = 0; race < 3; race++) {
      const current = this.currentUpdate(tree.id)!;
      if (current.root !== this.get(tree.id)!.ref) {
        throw new ServerFaultError(`Invariant violated: tree ${tree.id} ref does not match its current accepted update`);
      }
      if (request.ifCurrent !== undefined && request.ifCurrent !== current.id)
        return this.rejectedCandidate(tree.id, current, baseRoot, request, proposed, "Accepted state no longer matches ifCurrent", policy.rejection?.kind);
      const head = await this.history.entryFor(current);
      const open = head.entry.decisions;
      if (governed && (open.length || request.resolves.length)) {
        // Governed policy conflicts retain the conservative projection. Further
        // edits must explicitly resolve the complete current decision set; an
        // ordinary snapshot or stale device cannot silently restore authority.
        const keys = await this.history.guards(current, request);
        if (!keys || request.ifCurrent !== current.id || baseRoot !== current.root ||
            request.resolves.length !== open.length || new Set(keys).size !== open.length) {
          throw new UpdateProtocolError("unsupported-operation", "Configuration policy conflicts require an exact guarded resolution of every current decision");
        }
      }
      const guards = await this.history.guards(current, request);
      if (guards === null)
        return this.rejectedCandidate(tree.id, current, baseRoot, request, proposed, "Resolution guards no longer match the accepted decisions");
      markPhase("current-state");
      // Authored directly on the head: nothing concurrent to merge.
      const direct = basis.entry === head.hash && !basis.prefix.length;
      let root: ObjectHash, decisions: LogDecision[], evidence: unknown;
      let question: MergeQuestion | null = null;
      const carried = request.trace !== null && direct && !guards.length && await this.fastForward(current.root, request, open, proposed)
        ? await this.history.carry(open, request.candidate, proposed) : null;
      if (carried) {
        root = request.candidate;
        decisions = carried;
        markPhase("fast-forward");
      } else {
        let candidate = await this.candidate(tree.id, request, guards);
        let imposed: LogDecision | null = null;
        if (request.trace === null) {
          const identity = decideUpdate(baseRoot, request.candidate, current.root);
          if (identity === "current" && !guards.length)
            return {
              status: 200,
              result: await this.withReconciliation({ outcome: "unchanged", update: current, requestDigest }, request.candidate, proposed),
            };
          if (governed) {
            // Resolving a governed policy conflict accepts the author's exact
            // candidate; selecting the restrictive projection is still a resolution.
            const merged = guards.length
              ? { outcome: "accepted" as const, root: request.candidate, generated: new Map<ObjectHash, Uint8Array>() }
              : await reconcileUpdate(baseRoot, request.candidate, current.root, (hash) => this.objects.load(hash, proposed), { merge: policy.merge! });
            markPhase("reconcile");
            if (merged.outcome === "current" && !guards.length)
              return {
                status: 200,
                result: await this.withReconciliation({ outcome: "unchanged", update: current, requestDigest }, request.candidate, proposed),
              };
            if (merged.outcome !== "current")
              for (const [hash, bytes] of merged.generated) proposed.set(hash, bytes);
            const conflicts = "conflicts" in merged ? merged.conflicts : [];
            const mergedRoot = merged.outcome === "current" ? current.root : merged.root;
            // Only an access narrowing may stay open as a policy choice; any other
            // governed conflict is refused, not accepted.
            if (conflicts.some((c) => c.reason !== TREE_CONFIG_POLICY_CONFLICT))
              return this.rejectedCandidate(tree.id, current, baseRoot, request, proposed, policy.rejection!.message, policy.rejection!.kind, mergedRoot, conflicts);
            // A governed access conflict keeps the merge's restrictive
            // projection, as one whole-configuration choice.
            if (conflicts.length)
              imposed = {
                key: `policy:${request.change}`,
                dependencies: [],
                selected: 0,
                alternatives: [...new Set([mergedRoot, current.root, request.candidate])].map((object) => ({ object, contributions: [] })),
              };
            candidate = { ...candidate, root: mergedRoot };
          }
        }
        question = {
          base: governed ? head.hash : basis.entry,
          head: head.hash,
          ...(!governed && basis.prefix.length ? { prefix: basis.prefix } : {}),
          candidate,
          rules: this.rules(),
        };
        const reuse = prepared && stableJSONString(prepared.question) === stableJSONString(question);
        const { answer, objects } = reuse ? prepared! : await this.mergeTool.ask(question, proposed);
        for (const [hash, bytes] of objects) proposed.set(hash, bytes);
        markPhase("evaluate");
        root = answer.root;
        decisions = imposed ? [...answer.decisions.filter((d) => d.key !== imposed!.key), imposed] : answer.decisions;
        evidence = answer.evidence;
        // A snapshot the sidecar leaves exactly as the head changed nothing.
        if (request.trace === null && root === current.root && stableJSONString(decisions) === stableJSONString(open))
          return {
            status: 200,
            result: await this.withReconciliation({ outcome: "unchanged", update: current, requestDigest }, request.candidate, proposed),
          };
      }
      await policy.validateAccepted(
        this.get(tree.id)!,
        root,
        proposed
      );
      markPhase("validate-accepted");
      const entry = await this.history.write({
        format: LOG_ENTRY_FORMAT,
        tree: tree.id,
        previous: head.hash,
        root,
        change: request.change,
        trace: request.trace,
        resolves: guards,
        decisions,
        ...(question ? { asked: asked(question, root) } : {}),
        ...(evidence !== undefined && evidence !== null ? { evidence } : {}),
      }, [...proposed].map(([hash, bytes]) => ({ hash, bytes })));
      markPhase("accepted-store");
      const now = Date.now(),
        commit = await policy.prepareCommit(
          this.get(tree.id)!,
          root,
          now
        );
      const changes = await this.entryChanges(current.root, root);
      const profile = await this.profileUpdate(tree.id, root, changes, proposed, policy.profiles);
      markPhase("entry-changes");
      const accepted = this.acceptedStore.commit(
        {
          entryChanges: changes,
          tree: tree.id,
          root,
          previousRoot: current.root,
          expectedUpdate: current.id,
          acceptedAt: now,
          subject: policy.subject,
          requestDigest,
          change: request.change,
          entry,
        },
        () => {
          commit.withinTransaction?.();
          // Community membership enables accounts in the same transaction.
          this.applyProfileUpdate(tree.id, tree.canonicalPath === "/", profile);
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
    authentication: HostAuthentication | undefined,
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
    if (!update) throw new ServerFaultError("Activation recorded no accepted update");
    return { status: 201, result: { outcome: "accepted", update, requestDigest } };
  }

  /** The subject an update to `tree` is recorded and replayed under. */
  private subjectFor(tree: HostTree, account: HostAccount | null, linkDigest: string | undefined, credentialSubject: string | undefined): string {
    if (isTreeConfigPolicy(tree.policy)) return this.configurationCaller(tree, account, credentialSubject).subject;
    const execution = this.execution.current;
    return execution?.code ? `execution:${execution.subject}:${execution.code}` : credentialSubject ?? (account ? `account:${account.id}` : linkDigest ? `link:${linkDigest}` : "public");
  }

  /** Only a device of an administering profile may update a tree configuration. */
  private configurationCaller(tree: HostTree, account: HostAccount | null, credentialSubject: string | undefined): { account: HostAccount; subject: string } {
    if (!account || !tree.governs || !this.access.administers(account.profileTree, tree.governs) || credentialSubject?.startsWith("device:") !== true) {
      throw new PermissionDeniedError("An administrator's device is required for configuration updates");
    }
    return { account, subject: credentialSubject };
  }

  /** Ordinary trees: graph and boundary validation, the protocol three-way merge, and community reconciliation. */
  private ordinaryPolicy(
    tree: HostTree,
    request: CandidateUpdate,
    account: HostAccount | null,
    linkDigest: string | undefined,
    credentialSubject: string | undefined,
  ): UpdatePolicy {
    const execution = this.execution.current;
    let effects: ResourceEffect[] = [];
    const checkEffects = async (before: string, after: string, objects: ReadonlyMap<ObjectHash, Uint8Array>) => {
      if (!execution) return;
      if (request.resolves.length || request.trace !== null) throw new PermissionDeniedError("Scoped execution operations/resolutions are not allowed until effect validation is available");
      effects = await resourceEffects(before, after, hash => this.objects.load(hash, objects));
      if (effects.length && (!this.execution.covered(execution) || effects.some(e => !this.execution.granted(tree.id, e.path, e.operation, execution)))) throw new PermissionDeniedError("Execution effects are not allowed");
    };
    const profiles = this.profileReader();
    return {
      subject: this.subjectFor(tree, account, linkDigest, credentialSubject),
      profiles,
      validateCandidate: async (root, objects) => {
        if (execution && !request.ifCurrent) throw new Error("Execution updates require an exact-state guard");
        await checkEffects(tree.ref, root, objects);
        await this.validateReservedBoundaries(tree, root, objects);
        const requiredType = this.requiredProfileType(tree.id, tree.canonicalPath);
        const administering = this.administeringGroup(tree.id);
        if (requiredType || tree.canonicalPath === "/" || administering) {
          const facts = await this.candidateProfile(tree.id, root, objects, profiles);
          if (requiredType) checkProfileType(facts, requiredType);
          if (tree.canonicalPath === "/") this.validateCommunityReservations(facts);
          if (administering) checkAdministeringGroup(facts);
        }
      },
      validateAccepted: async (remoteTree, root, objects) => {
        await checkEffects(remoteTree.ref, root, objects);
        if (root === request.candidate) return;
        await this.validateGraph(root, objects, remoteTree.ref);
        await this.validateReservedBoundaries(remoteTree, root, objects);
        if (remoteTree.canonicalPath === "/" || this.administeringGroup(remoteTree.id)) {
          const facts = await this.candidateProfile(remoteTree.id, root, objects, profiles);
          if (remoteTree.canonicalPath === "/") this.validateCommunityReservations(facts);
          if (this.administeringGroup(remoteTree.id)) checkAdministeringGroup(facts);
        }
      },
      prepareCommit: async () => ({
        withinTransaction: () => {
          if (execution && (!this.execution.covered(execution) || effects.some(e => !this.execution.granted(tree.id, e.path, e.operation, execution)))) throw new PermissionDeniedError("Execution permission is not allowed");
        },
      }),
    };
  }

  /** Whether a group profile tree administers any tree, and so must keep a member. */
  private administeringGroup(tree: string): boolean {
    return this.rootProfileType(tree) === "group" && this.db.query("SELECT 1 FROM tree_admins WHERE profile_tree = ? LIMIT 1").get(tree) !== null;
  }

  /**
   * A tree configuration (`tree-config-v1`): authorization through the
   * administering profiles and their devices on every transition, the
   * restrictive YAML merge, and the derived index, credential revocations,
   * and mount boundaries committed with the accepted update.
   */
  private treeConfigPolicy(
    tree: HostTree,
    request: CandidateUpdate,
    baseRoot: ObjectHash,
    caller: HostAccount | null,
    credential: string | undefined,
    proposed: ReadonlyMap<ObjectHash, Uint8Array> = new Map(),
  ): UpdatePolicy {
    const { account, subject: credentialSubject } = this.configurationCaller(tree, caller, credential);
    const deviceID = credentialSubject.slice("device:".length);
    const governed = tree.governs!;
    const kind = this.treeConfigKind(governed);
    // A person's own configuration governs itself: its devices.yaml names the
    // devices that may edit it. Every other configuration is edited from an
    // administrator device of an administering person.
    const own = kind === "person" && governed === account.profileTree;
    const graphAt = (root: ObjectHash, objects?: ReadonlyMap<ObjectHash, Uint8Array>, accepted = false) =>
      this.configGraphAt(root, kind, governed, objects, accepted);
    let candidateGraph: TreeConfigValues;
    let currentGraph: TreeConfigValues;
    let nextGraph: TreeConfigValues;
    const authorize = async (current: TreeConfigValues, next: TreeConfigValues, changesFrom: TreeConfigValues) => {
      if (own) authorizePersonConfigTransition(current, next, deviceID, changesFrom);
      else if (!await this.isAdministratorDevice(account, deviceID)) throw new PermissionDeniedError("Only an administrator device may edit a tree configuration");
      this.checkMountAdditions(governed, account, { ...current.mounts, ...changesFrom.mounts }, next.mounts);
    };
    return {
      subject: credentialSubject,
      // A configuration tree holds only its YAML files, never `_index.md`.
      profiles: this.profileReader(),
      rejection: { kind: "tree-configuration", message: "The tree configuration contains incompatible same-field edits" },
      validateCandidate: async (root, objects) => {
        candidateGraph = await graphAt(root, objects);
        const baseGraph = await graphAt(baseRoot, undefined, true);
        const current = this.currentUpdate(tree.id);
        if (!current) throw new ServerFaultError("Tree configuration has no accepted update");
        const acceptedGraph = await graphAt(current.root, undefined, true);
        if (request.resolves.length && own && !acceptedGraph.devices?.[deviceID]?.administrator) throw new PermissionDeniedError("Only an administrator may resolve policy conflicts");
        await authorize(acceptedGraph, candidateGraph, baseGraph);
      },
      // Unreadable inputs reject the update as a whole-root policy conflict.
      merge: (base, candidate, current, load) => mergeTreeConfigTrees(kind, base, candidate, current, load)
        .catch(() => ({ root: candidate, objects: new Map(), conflicts: [{ path: "/", reason: "tree-configuration" as const }], unresolvedDirectories: ["/"] })),
      validateAccepted: async (remoteTree, root, objects) => {
        currentGraph = await graphAt(remoteTree.ref, undefined, true);
        nextGraph = root === request.candidate ? candidateGraph : await graphAt(root, objects);
        await authorize(currentGraph, nextGraph, currentGraph);
      },
      prepareCommit: async (_remoteTree, _root, now) => {
        const content = this.get(governed);
        const rewrite = content?.status === "active" ? await this.prepareMountRewrite(content, currentGraph.mounts, nextGraph.mounts) : null;
        const prepared = rewrite ? await this.prepareParentAdvance(rewrite) : null;
        let boundaryUpdate: AcceptedUpdate | null = null;
        return {
          withinTransaction: () => {
            this.indexTreeConfig(governed, kind, currentGraph, nextGraph);
            if (prepared) boundaryUpdate = this.advanceParent(prepared, now, credentialSubject);
          },
          afterCommit: () => {
            if (boundaryUpdate) this.notifyAccepted(boundaryUpdate);
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
    const record = this.observations.get(update.id);
    if (record) this.notifyObservation(record);
  }

  async object(hash: ObjectHash): Promise<Uint8Array> {
    return this.objects.read(hash);
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

  /** Verify SQLite, the row invariants `assertHostData` names, and every
   * object reachable from retained accepted history.
   * This walks all retained history, so concurrent callers share one run. */
  verifyIntegrity(): Promise<void> {
    this.integrityRun ??= this.auditIntegrity().finally(() => { this.integrityRun = null; });
    return this.integrityRun;
  }

  private async auditIntegrity(): Promise<void> {
    this.verifyDatabase();
    assertHostData(this.db);
    // The same closure the object collector keeps: every object it names is
    // present and hash-consistent.
    await retainedObjects(this.db, this.objects);
    // Each row agrees with its entry, and each chain stays within its tree.
    const rows = this.db.query("SELECT ordinal, tree_id, root, previous_ordinal, conflicted, entry FROM accepted_updates ORDER BY ordinal").all() as Array<{
      ordinal: number; tree_id: string; root: ObjectHash; previous_ordinal: number | null; conflicted: number; entry: ObjectHash;
    }>;
    const byOrdinal = new Map(rows.map((row) => [row.ordinal, row]));
    const checked = new Set<ObjectHash>();
    for (const row of rows) {
      const entry = await this.history.entry(row.entry);
      if (entry.tree !== row.tree_id || entry.root !== row.root || (entry.decisions.length > 0) !== Boolean(row.conflicted))
        throw new Error(`Accepted update ${row.ordinal} does not match its log entry`);
      const previous = row.previous_ordinal === null ? null : byOrdinal.get(row.previous_ordinal);
      if (previous && entry.previous !== previous.entry)
        throw new Error(`Accepted update ${row.ordinal} does not follow its predecessor's log entry`);
      for (let at: ObjectHash | null = row.entry; at && !checked.has(at);) {
        checked.add(at);
        const value = await this.history.entry(at);
        if (value.tree !== row.tree_id) throw new Error("Log entry chain crosses trees");
        at = value.previous;
      }
    }
  }

  /** The object route is gated on tree read access only. Objects are
   * content-addressed and shared across trees, so a caller who can read any
   * tree may fetch any retained object whose hash they know; the route does not
   * prove reachability from that tree's roots or alternatives. */
  isReadableObject(treeID: string, account: HostAccount | null, linkDigest?: string): boolean {
    const tree = this.get(treeID);
    return tree !== null && this.canRead(account, tree, linkDigest);
  }

  /** Retained object bytes, or null when no object has this hash. */
  async retainedObject(hash: ObjectHash): Promise<Uint8Array | null> {
    try { return await this.objects.read(hash); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  /**
   * A tree's first accepted update. The community root takes the boundary
   * `/`; any other tree that is mounted is attached to its parent's content in
   * the same transaction, and takes its canonical path from the mounts.
   */
  private async insertTree(
    snapshot: TreeSnapshot,
    options: {
      root?: boolean;
      id?: string;
      subject?: string;
      requestDigest?: ObjectHash;
      change?: string;
      profiles?: ProfileReader;
      withinTransaction?: (treeID: string) => void;
    },
  ): Promise<HostTree> {
    await this.validateGraph(snapshot.root, snapshot.objects);
    await this.objects.store([...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
    const id = options.id ?? generateArborID("tr");
    if (this.db.query("SELECT 1 FROM trees WHERE id = ?").get(id)) throw new Error(`TreeID already exists: ${id}`);
    const mount = options.root ? null : this.mountOf(id);
    const parent = mount ? this.get(mount.parent) : null;
    // Attaching a fresh tree is the single-addition boundary rewrite; a plain
    // entry already at that name is replaced by the nested-tree entry.
    const attachment = parent?.status === "active" && parent.policy === "ordinary"
      ? await this.prepareParentAdvance(await this.prepareBoundaryRewrite(parent.id, [], [{ path: mountBelow("/", mount!.path), tree: id }], { replaceEntries: true }))
      : null;
    const staged = new Map(snapshot.objects);
    const entry = await this.internalEntry(id, null, snapshot.root, options.change ?? `initial:${id}`, staged);
    const initialChanges = await this.entryChanges(null, snapshot.root);
    const profile = await this.profileUpdate(id, snapshot.root, initialChanges, staged, options.profiles ?? this.profileReader());
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run("INSERT INTO trees (id, ref) VALUES (?, ?)", [id, snapshot.root]);
      if (options.root) this.db.run("INSERT INTO boundaries (path, tree_id, parent_tree) VALUES ('/', ?, NULL)", [id]);
      this.acceptedStore.insert({
        tree: id,
        root: snapshot.root,
        previousRoot: null,
        acceptedAt: now,
        subject: options.subject ?? null,
        requestDigest: options.requestDigest,
        change: options.change,
        entryChanges: initialChanges,
        entry,
      });
      this.applyProfileUpdate(id, options.root === true, profile);
      options.withinTransaction?.(id);
      if (attachment) this.advanceParent(attachment, now, options.subject ?? null);
      this.recomputeBoundaries();
    })();
    if (attachment) this.notifyAccepted(this.currentUpdate(attachment.tree)!);
    return this.get(id)!;
  }

  /** The log entry of an acceptance canopyd makes itself: a tree's first
   * root, pairing, account configuration, a boundary rewrite. When decisions
   * are open after `from`, the sidecar carries them onto the new root, which
   * it shows as given; otherwise there is nothing to decide. Stores `staged`
   * and the entry durably, before the caller's transaction. */
  private async internalEntry(
    tree: string,
    from: AcceptedUpdate | null,
    root: ObjectHash,
    change: string,
    staged: Map<ObjectHash, Uint8Array>,
  ): Promise<{ hash: ObjectHash; conflicted: boolean }> {
    let previous: ObjectHash | null = null, decisions: LogDecision[] = [], evidence: unknown;
    if (from) {
      const head = await this.history.entryFor(from);
      previous = head.hash;
      if (head.entry.decisions.length) {
        const rules = this.rules();
        const { answer, objects } = await this.mergeTool.ask({
          base: head.hash, head: head.hash,
          candidate: { root, change, trace: null, resolves: [] },
          rules: { ...rules, config: { ...(rules.config as object), conflictProjection: "incoming" } },
        }, staged);
        if (answer.root !== root) throw new ServerFaultError("The merge sidecar did not accept canopyd's own root");
        for (const [hash, bytes] of objects) staged.set(hash, bytes);
        decisions = answer.decisions;
        evidence = answer.evidence;
      }
    }
    return this.history.write({
      format: LOG_ENTRY_FORMAT, tree, previous, root, change, trace: null, resolves: [], decisions,
      ...(evidence !== undefined && evidence !== null ? { evidence } : {}),
    }, [...staged].map(([hash, bytes]) => ({ hash, bytes })));
  }

  /** Everything a server-side rewrite of a canonical parent's boundaries needs
   * before its transaction: the stored objects, the entry changes, and a log
   * entry after the parent's current update. */
  private async prepareParentAdvance(rewrite: { parent: HostTree; nextRoot: ObjectHash; generated: Map<ObjectHash, Uint8Array> }) {
    const from = this.currentUpdate(rewrite.parent.id);
    if (!from || from.root !== rewrite.parent.ref) throw new RefConflictError(this.get(rewrite.parent.id)?.ref ?? null);
    const staged = new Map(rewrite.generated);
    const entry = await this.internalEntry(rewrite.parent.id, from, rewrite.nextRoot, `boundary:${crypto.randomUUID()}`, staged);
    const changes = await this.entryChanges(rewrite.parent.ref, rewrite.nextRoot);
    const profile = await this.profileUpdate(rewrite.parent.id, rewrite.nextRoot, changes, staged);
    const community = rewrite.parent.canonicalPath === "/";
    return { tree: rewrite.parent.id, previousRoot: rewrite.parent.ref, root: rewrite.nextRoot, expectedUpdate: from.id, entryChanges: changes, entry, profile, community };
  }

  /** Advance a canonical parent inside the caller's transaction, only from the
   * update its log entry follows. */
  private advanceParent(prepared: Awaited<ReturnType<HostDaemon["prepareParentAdvance"]>>, acceptedAt: number, subject: string | null): AcceptedUpdate {
    const { expectedUpdate, profile, community, ...input } = prepared;
    const accepted = this.acceptedStore.current(input.tree)?.id === expectedUpdate
      ? this.acceptedStore.advance({ ...input, acceptedAt, subject })
      : null;
    if (!accepted) throw new RefConflictError(this.get(input.tree)?.ref ?? null);
    this.applyProfileUpdate(input.tree, community, profile);
    return accepted;
  }

  /** Regenerate a parent's directories for removed and added nested-tree
   * entries, at paths below the parent's own root. */
  private async prepareBoundaryRewrite(
    parentTreeID: string,
    removals: BoundaryEdit[],
    additions: BoundaryEdit[],
    options: BoundaryRewriteOptions = {},
  ): Promise<{ parent: HostTree; nextRoot: ObjectHash; generated: Map<ObjectHash, Uint8Array> }> {
    const parent = this.get(parentTreeID);
    if (!parent || parent.policy !== "ordinary") throw new Error(`Unknown parent tree: ${parentTreeID}`);
    const rewrite = await rewriteBoundaries(
      { ref: parent.ref, canonicalPath: "/" },
      removals,
      additions,
      (hash, generated) => this.objects.load(hash, generated),
      options,
    );
    return { parent, ...rewrite };
  }

  /** The content rewrite a change of a tree's mounts makes: an active child's
   * entry leaves its old name and appears at its new one. Null when nothing
   * changes. */
  private async prepareMountRewrite(parent: HostTree, before: Record<string, string>, after: Record<string, string>) {
    const active = (tree: string) => this.get(tree)?.status === "active";
    const removals: BoundaryEdit[] = [];
    const additions: BoundaryEdit[] = [];
    for (const [path, child] of Object.entries(before)) {
      if (after[path] !== child && active(child)) removals.push({ path: mountBelow("/", path), tree: child });
    }
    for (const [path, child] of Object.entries(after)) {
      if (before[path] !== child && active(child)) additions.push({ path: mountBelow("/", path), tree: child });
    }
    if (!removals.length && !additions.length) return null;
    const rewrite = await this.prepareBoundaryRewrite(parent.id, removals, additions);
    return rewrite.nextRoot === parent.ref ? null : rewrite;
  }

  private async validateReservedBoundaries(
    parent: HostTree,
    root: ObjectHash,
    proposed: ReadonlyMap<ObjectHash, Uint8Array>,
  ): Promise<void> {
    const children = this.db.query(`
      SELECT m.path, m.tree_id FROM mounts m JOIN trees t ON t.id = m.tree_id
      WHERE m.parent_tree = ? AND t.status = 'active' ORDER BY length(m.path)
    `).all(parent.id) as Array<{ path: string; tree_id: string }>;
    for (const child of children) {
      const segments = child.path.split("/");
      let hash = root;
      let valid = true;
      for (const [index, segment] of segments.entries()) {
        const object = decodeProtocolDirectory(await this.objects.load(hash, proposed));
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
      if (!valid) throw new ReservedBoundaryConflictError(parent.canonicalPath ? mountBelow(parent.canonicalPath, child.path) : child.path, child.tree_id);
    }
  }


  /**
   * The two profile invariants the server enforces: an account's profile tree
   * keeps `type: person` and the community root keeps `type: group`. Every
   * other tree's `type:` is authored data the server does not validate.
   */
  private requiredProfileType(treeID: string, canonicalPath: string | null): "person" | "group" | null {
    if (canonicalPath === "/") return "group";
    if (this.accounts.account(treeID)) return "person";
    return null;
  }

  /** Whether a group root lists this person: by Profile TreeID, or by handle
   * for a legacy scalar `/~handle` member locator. */
  private isProfileMember(group: string, profileTree: string, handle: string | undefined): boolean {
    const profile = this.rootProfile(group);
    return profile.profiles.has(profileTree) || (handle !== undefined && profile.legacyHandles.has(handle));
  }

  /** Current-Canopy allocation policy: the community's member handles reserve /~handle. */
  private communityReservations(): ReadonlyMap<string, { profileTree?: string; inviteDigest?: string }> {
    return this.rootProfile(this.community().id).reservations;
  }

  /** A fresh set of profile reads for one accept (`ProfileReader`). */
  private profileReader(): ProfileReader {
    const reads = new Map<ObjectHash, Promise<RootProfileRead>>();
    return (root, objects) => {
      let read = reads.get(root);
      if (!read) {
        phaseTimer()?.count("profile-parse", 1);
        read = readRootProfile(root, (hash) => this.objects.load(hash, objects));
        reads.set(root, read);
      }
      return read;
    };
  }

  /** The type and members `root` would give `tree`, for validation: the
   * stored facts when its `_index.md` is the head's, which reads only the
   * root directory, otherwise one parse shared with the rest of the accept. */
  private async candidateProfile(
    tree: string,
    root: ObjectHash,
    objects: ReadonlyMap<ObjectHash, Uint8Array>,
    profiles: ProfileReader,
  ): Promise<RootProfileFacts> {
    const stored = this.treeProfile(tree).stored;
    if (stored && await rootIndexHash(root, (hash) => this.objects.load(hash, objects)) === stored.indexHash) return stored.facts;
    return (await profiles(root, objects)).facts;
  }

  /** The profile write an update of `tree` to `root` makes, decided from its
   * entry changes: recomputed only when they touch the root `_index.md` or the
   * avatar file the stored row declares. Runs before the accept transaction. */
  private async profileUpdate(
    tree: string,
    root: ObjectHash,
    changes: EntryChanges,
    objects: ReadonlyMap<ObjectHash, Uint8Array>,
    profiles: ProfileReader = this.profileReader(),
  ): Promise<ProfileUpdate> {
    if (!profileChanged(this.treeProfile(tree).stored, changes)) return undefined;
    return storedProfileOf(await profiles(root, objects));
  }

  /** Write a profile update inside its accept transaction. When the community's
   * members change, its accounts are reconciled in the same transaction. */
  private applyProfileUpdate(tree: string, community: boolean, update: ProfileUpdate): void {
    if (update === undefined) return;
    const before = readStoredProfile(this.db, tree);
    writeStoredProfile(this.db, tree, update);
    this.treeProfiles.delete(tree);
    if (community && stableJSONString(before?.facts.members ?? []) !== stableJSONString(update?.facts.members ?? [])) {
      this.reconcileCommunityAccounts(update?.facts ?? null);
    }
  }

  /**
   * Authorization reads each tree's stored profile facts (`profile_facts`,
   * written with the accepted head), so it never reparses mutable filesystem
   * state or treats display names as identity. A tree without a row declares
   * no profile type. Only committed rows are cached: a row read inside a
   * transaction may yet roll back.
   */
  private treeProfile(tree: string): TreeProfile {
    const cached = this.treeProfiles.get(tree);
    if (cached) return cached;
    const stored = readStoredProfile(this.db, tree);
    const members = stored?.facts.members ?? [];
    const value: TreeProfile = {
      stored,
      profile: stored ? {
        type: stored.facts.type,
        members,
        reservations: memberReservations(members),
        profiles: memberProfiles(members),
        legacyHandles: new Set(members.flatMap((member) => legacyMemberHandle(member) ?? [])),
      } : NO_PROFILE,
    };
    if (!this.db.inTransaction) this.treeProfiles.set(tree, value);
    return value;
  }

  private rootProfile(tree: string): RootProfile {
    return this.treeProfile(tree).profile;
  }

  /** The tree head's `type: person` or `type: group`, or null when it declares neither. */
  rootProfileType(tree: string | HostTree): "person" | "group" | null {
    return this.rootProfile(idOf(tree)).type;
  }

  /**
   * Whether a tree other than the ~name account's own profile holds /~name:
   * the community root's `mounts.yaml`, or a member mount of another profile.
   * A person may then neither reserve nor claim that name.
   */
  private nameHeldByTree(name: string): boolean {
    const root = this.boundary("/")?.id;
    if (!root) return false;
    const owner = this.accountByHandle(name)?.id ?? null;
    return this.db.query(`
      SELECT 1 FROM mounts WHERE parent_tree = ? AND (path = ? OR substr(path, 1, ?) = ?) AND (member = 0 OR ? IS NULL OR tree_id IS NOT ?)
    `).get(root, `~${name}`, name.length + 2, `~${name}/`, owner, owner) !== null;
  }

  /** A community update may not reserve a handle whose /~name a tree already holds. */
  private validateCommunityReservations(facts: RootProfileFacts): void {
    const current = this.communityReservations();
    for (const handle of memberReservations(facts.members).keys()) {
      if (!current.has(handle) && this.nameHeldByTree(handle)) {
        throw new Error(`~${handle} is already the address of a tree on this Canopy`);
      }
    }
  }

  /** Enable exactly the accounts the accepted community root lists; callers run this inside their transaction. */
  private reconcileCommunityAccounts(community: RootProfileFacts | null): void {
    const members = [...memberReservations(community?.members ?? [])].map(([handle, reservation]) => ({
      handle,
      profileTree: reservation.profileTree ?? null,
      legacy: !reservation.profileTree && !reservation.inviteDigest,
    }));
    this.db.run(`UPDATE accounts SET enabled = EXISTS (
      SELECT 1 FROM json_each(?) AS member
      WHERE json_extract(member.value, '$.handle') = accounts.handle
      AND (json_extract(member.value, '$.profileTree') = accounts.id
        OR json_extract(member.value, '$.legacy') = 1)
    )`, [JSON.stringify(members)]);
  }

  private async validateGraph(root: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array>, acceptedBasis?: ObjectHash): Promise<void> {
    // acceptedBasis comes from the server's current tree, never from worker or
    // client assertions. A staged proof is only inherited once that root has
    // actually become accepted (and therefore durable).
    const collection = async (directory: ReturnType<typeof decodeProtocolDirectory>, load: (hash: string) => Promise<Uint8Array>) => {
      const source = directory.childrenSource!;
      const loadFile = async (name: string) => {
        const target = directory.entries.find(entry => entry.name === name)?.file;
        if (!target) throw Error(`Missing collection-file entry: ${name}`);
        return load(target);
      };
      decodeProtocolCollectionFile(source, await loadFile(source.source), await loadFile(source.schemaSource), this.wireSchemas);
    };
    let basis = acceptedBasis ? this.validatedGraphs.get(acceptedBasis) : undefined;
    if (acceptedBasis && !basis)
      basis = await validateGraphChange(acceptedBasis, hash => this.objects.read(hash), new Map(), collection);
    // An object the candidate takes from the store outside its accepted basis
    // is one no client sent; freshen it so a concurrent object collection
    // cannot remove it before the accepted row names it.
    const load = async (hash: ObjectHash) => {
      const bytes = await this.objects.read(hash);
      await this.objects.freshen([hash]);
      return bytes;
    };
    const result = await validateGraphChange(root, load, proposed, collection, basis);
    this.validatedGraphs.delete(root);
    this.validatedGraphs.set(root, result);
    while (this.validatedGraphs.size > 8 || [...this.validatedGraphs.values()].reduce((n, graph) => n + graph.objects.size, 0) > 200_000)
      this.validatedGraphs.delete(this.validatedGraphs.keys().next().value!);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.mergeTool[Symbol.asyncDispose]();
    this.wireSchemas.clear();
    this.db.close();
    this.observationListeners.clear();
  }
}

/** The stored token digest of a `sha256:<hex>` device credential digest. */
function deviceTokenDigest(credentialDigest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(credentialDigest)) throw new Error("Device credential digest is invalid");
  return credentialDigest.slice("sha256:".length);
}

/** A group that administers a tree keeps at least one member. */
function checkAdministeringGroup(facts: RootProfileFacts): void {
  if (facts.type === "group" && !memberProfiles(facts.members).size) {
    throw new Error("A group that administers a tree must keep at least one member");
  }
}

/** An account profile keeps `type: person` and the community root `type: group`. */
function checkProfileType(facts: RootProfileFacts, kind: "person" | "group"): void {
  if (facts.type !== kind) throw new Error(`Profile root must declare type: ${kind} in its _index.md`);
}

function idOf(tree: string | HostTree): string {
  return typeof tree === "string" ? tree : tree.id;
}

/** Immutable object cache size; `ARBOR_OBJECT_CACHE_MB` overrides the 256 MB default. */
function objectCacheBytes(): number {
  return megabytes("ARBOR_OBJECT_CACHE_MB", 256);
}

function megabytes(variable: string, fallback: number): number {
  const configured = Number(process.env[variable]);
  return (Number.isFinite(configured) && configured >= 0 ? configured : fallback) * 1024 * 1024;
}
