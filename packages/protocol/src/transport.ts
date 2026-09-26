import { decodeDecisionPage, type DecisionPage } from "./updates/accepted-contract.ts";
import { decodeAcceptedWatchChange } from "./updates/accepted-contract.ts";
import type {
  AcceptedTransition,
  UpdateConflictResult,
  CandidateUpdate,
  UpdateRequest,
  UpdateResponse,
  UpdateResult,
  ObjectDelta,
  ServerDevice,
} from "./updates/types.ts";
import {
  parseSSEStream,
  type AccessEntry,
  type OverstoryError,
  type EventCursor,
  type LocatorResolution,
  type RemoteTreeDescriptor,
  type SnapshotEnvelope,
  type TreeID,
  type AccountChallenge,
  type PairingOffer,
  type DeviceSession,
  type DeviceSessionChallenge,
  type PendingProfileReset,
  type ProfileResetChallenge,
  type ProfileResetDevice,
} from "./index.ts";
import {
  type ObjectHash,
  type TreeSnapshot,
} from "./objects.ts";
import {
  decodeAcceptedTransitionJSON,
  decodeUpdateConflictJSON,
  decodeUpdateResponseJSON,
  encodeTreeSnapshotJSON,
  encodeUpdateRequestJSON,
} from "./updates/json.ts";
import { updateRequestDigests } from "./updates/intent.ts";
import { CONFIGURATION_PARAMETER, parseTreeReference, treeConfigurationID } from "./config/tree-config.ts";
import { decodeSnapshotBundle } from "./snapshots.ts";


export interface CurrentTree {
  tree: RemoteTreeDescriptor;
  observedThrough: EventCursor;
}

export class ProtocolUpdateConflict extends Error {
  constructor(readonly result: UpdateConflictResult) {
    super("Server could not safely accept the candidate update");
    this.name = "ProtocolUpdateConflict";
  }
}

export class ProtocolUnsupportedOperation extends Error {
  readonly retryable = false;
  constructor(readonly result: OverstoryError) {
    super(result.message);
    this.name = "ProtocolUnsupportedOperation";
  }
}

export interface RemoteAccountDescriptor {
  id: string;
  /** Optional Canopy-specific presentation hint; never account identity. */
  handle?: string;
  profileTree: string | null;
  profileURL: string | null;
  community: RemoteTreeDescriptor;
  configuration: RemoteTreeDescriptor;
  writableProfiles: RemoteTreeDescriptor[];
  device?: { id: string; label: string };
}

export interface RemoteAccountSnapshot {
  account: RemoteAccountDescriptor;
  observedThrough: EventCursor;
}

export interface AccountClaimResult {
  account: RemoteAccountDescriptor;
  configuration: RemoteTreeDescriptor;
}

export interface ExistingProfileAccountRequest {
  account: string;
  profileTree: TreeID;
  configurationTree: TreeID;
  challenge: AccountChallenge;
  publicKey: string;
  signature: string;
  inviteCode?: string;
  device: DeviceEnrollment;
  configuration: TreeSnapshot;
}

/** A device a claim or pairing adds: a key device sends its public `key`, a
 * digest device only its credential's digest. */
export type DeviceEnrollment =
  | { id: string; label: string; credentialDigest: `sha256:${string}` }
  | { id: string; label: string; key: string };

export interface PairingClaimResult {
  device: ServerDevice;
  confirmationCode: string;
}

export type RemoteAccessEntry = AccessEntry;

export interface RemoteDirectoryEntry {
  profile: TreeID;
  kind: "person" | "group" | "unknown";
  handle?: string;
  locator?: string;
  displayName?: string;
  description?: string;
  avatar?: { tree: TreeID; path: string; hash: ObjectHash };
  sources: Array<"community" | `group:${TreeID}` | "access">;
}

/** One decoded frame of a tree watch. `tree.update` carries a verified, contiguous transition batch. */
export type WatchEvent =
  | {
    kind: "tree.update";
    cursor: EventCursor;
    tree: TreeID;
    descriptor: RemoteTreeDescriptor;
    transitions: AcceptedTransition[];
    requestDigest?: ObjectHash;
  }
  | { kind: "resync-required"; cursor: EventCursor; tree: TreeID; reason?: string };

function decodeTreeRefChange(tree: TreeID, cursor: EventCursor, value: unknown): Extract<WatchEvent, { kind: "tree.update" }> {
  if (!value || typeof value !== "object") throw new Error("Malformed tree.update change");
  const change = value as { descriptor?: RemoteTreeDescriptor; transitions?: unknown; requestDigest?: unknown };
  const descriptor = change.descriptor;
  if (!descriptor || descriptor.id !== tree || !Array.isArray(change.transitions) || !change.transitions.length) {
    throw new Error("Malformed tree.update change");
  }
  decodeAcceptedWatchChange(change, tree);
  const transitions = change.transitions.map(decodeAcceptedTransitionJSON);
  const requestDigest = change.requestDigest;
  if (requestDigest !== undefined && (typeof requestDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(requestDigest))) {
    throw new Error("Malformed tree.update request digest");
  }
  return {
    kind: "tree.update",
    cursor,
    tree,
    descriptor,
    transitions,
    ...(requestDigest ? { requestDigest: requestDigest as ObjectHash } : {}),
  };
}

/** HTTP failure with machine-readable status; the message retains existing diagnostics. */
export class ProtocolHTTPError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ProtocolHTTPError";
  }
}

export class ProtocolTransportError extends TypeError {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "ProtocolTransportError";
    this.cause = cause;
  }
}

export class ProtocolClient {
  private readonly timeoutMs: number;

  constructor(
    readonly origin: string,
    private accountToken?: string,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  private headers(json = false): HeadersInit {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.accountToken ? { authorization: `Bearer ${this.accountToken}` } : {}),
    };
  }

  private async checked(response: Response): Promise<Response> {
    if (response.ok) return response;
    const body = await response.text();
    let envelope: OverstoryError | undefined;
    try { envelope = JSON.parse(body) as OverstoryError; } catch {}
    throw new ProtocolHTTPError(response.status, `${response.url}: ${envelope?.error ?? response.status} ${envelope?.message ?? (body || response.statusText)}`);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`${this.origin}${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ProtocolTransportError(`Could not reach Arbor server at ${this.origin}`, error);
    }
  }

  async account(): Promise<RemoteAccountSnapshot> {
    const response = await this.checked(await this.request("/.arbor/account", { headers: this.headers() }));
    return response.json();
  }

  async createPairing(): Promise<PairingOffer> {
    const response = await this.checked(await this.request("/.arbor/pairings", {
      method: "POST",
      headers: this.headers(true),
      body: "{}",
    }));
    return response.json();
  }

  async claimPairing(
    id: string,
    secret: string,
    device: DeviceEnrollment,
  ): Promise<PairingClaimResult> {
    const response = await this.checked(await this.request(`/.arbor/pairings/${encodeURIComponent(id)}/claim`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, device }),
    }));
    return response.json();
  }

  async createAccountChallenge(input: {
    account?: string;
    profileTree: TreeID;
    configurationTree: TreeID;
    inviteCode?: string;
  }): Promise<AccountChallenge> {
    const response = await this.checked(await this.request("/.arbor/account-challenges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
    return response.json();
  }

  async joinAccount(input: ExistingProfileAccountRequest): Promise<AccountClaimResult> {
    const response = await this.checked(await this.request("/.arbor/accounts", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: input.account,
        profileTree: input.profileTree,
        configurationTree: input.configurationTree,
        challenge: input.challenge,
        publicKey: input.publicKey,
        signature: input.signature,
        ...(input.inviteCode ? { inviteCode: input.inviteCode } : {}),
        device: input.device,
        configuration: encodeTreeSnapshotJSON(input.configuration),
      }),
    }));
    return response.json();
  }

  async createDeviceSessionChallenge(input: { profileTree: TreeID; device: string }): Promise<DeviceSessionChallenge> {
    const response = await this.checked(await this.request("/.arbor/device-sessions/challenges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
    return response.json();
  }

  /** Exchange a signed challenge for a session token at this host. */
  async openDeviceSession(challenge: DeviceSessionChallenge, signature: string): Promise<DeviceSession> {
    const response = await this.checked(await this.request("/.arbor/device-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge, signature }),
    }));
    return response.json();
  }

  async createProfileResetChallenge(input: { profileTree: TreeID; device: ProfileResetDevice }): Promise<ProfileResetChallenge> {
    const response = await this.checked(await this.request("/.arbor/profile-resets/challenges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
    return response.json();
  }

  /** Record a pending reset signed by the profile key. */
  async requestProfileReset(input: { challenge: ProfileResetChallenge; publicKey: string; signature: string }): Promise<PendingProfileReset> {
    const response = await this.checked(await this.request(`/.arbor/profile-resets/${encodeURIComponent(input.challenge.profileTree)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
    return (await response.json() as { reset: PendingProfileReset }).reset;
  }

  async pendingProfileReset(profileTree: TreeID): Promise<PendingProfileReset | null> {
    const response = await this.checked(await this.request(`/.arbor/profile-resets/${encodeURIComponent(profileTree)}`, { headers: this.headers() }));
    return (await response.json() as { reset: PendingProfileReset | null }).reset;
  }

  async cancelProfileReset(profileTree: TreeID): Promise<void> {
    await this.checked(await this.request(`/.arbor/profile-resets/${encodeURIComponent(profileTree)}`, { method: "DELETE", headers: this.headers() }));
  }

  async list(): Promise<SnapshotEnvelope<RemoteTreeDescriptor[]>> {
    const response = await this.checked(await this.request("/.arbor/trees", { headers: this.headers() }));
    return response.json();
  }

  async directory(): Promise<SnapshotEnvelope<RemoteDirectoryEntry[]>> {
    const response = await this.checked(await this.request("/.arbor/directory", { headers: this.headers() }));
    return response.json();
  }

  /** The tree resource itself: its current descriptor and the cursor to watch after. */
  async descriptor(tree: string): Promise<CurrentTree> {
    const response = await this.checked(await this.request(`/.arbor/trees/${encodeURIComponent(tree)}`, { headers: this.headers() }));
    const value = await response.json() as { tree: RemoteTreeDescriptor; observedThrough: EventCursor };
    if (value.tree?.id !== tree || typeof value.tree.root !== "string" || !value.tree.update || typeof value.tree.conflicted !== "boolean" || typeof value.observedThrough !== "string" || !value.observedThrough) throw new Error("Tree descriptor does not match its tree");
    return { tree: value.tree, observedThrough: value.observedThrough };
  }

  async conflicts(tree: string, state: string, root: string, options: { after?: string; conflict?: string } = {}): Promise<DecisionPage> {
    if (options.after !== undefined && options.conflict !== undefined) throw new Error("Conflicting inspection options");
    const query = new URLSearchParams({ state, ...options });
    const response = await this.checked(await this.request(`/.arbor/trees/${encodeURIComponent(tree)}/conflicts?${query}`, { headers: this.headers() }));
    return decodeDecisionPage(await response.json(), { tree, state, root });
  }

  async snapshot(tree: string, root: string): Promise<TreeSnapshot> {
    if (!/^sha256:[a-f0-9]{64}$/.test(root)) throw new Error("Snapshot root hash is invalid");
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expectProgress = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    };
    expectProgress();
    try {
      const response = await this.checked(await this.request(
        `/.arbor/trees/${encodeURIComponent(tree)}/snapshots/${root}`,
        {
          headers: { ...this.headers(), accept: "application/cbor" },
          signal: controller.signal,
        },
      ));
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/cbor")) {
        throw new Error("Snapshot response is not application/cbor");
      }
      if (!response.body) throw new Error("Snapshot response has no body");
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = response.body.getReader();
      while (true) {
        expectProgress();
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
        length += chunk.value.byteLength;
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return decodeSnapshotBundle(root, bytes);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProtocolTransportError(`Snapshot transfer from ${this.origin} stopped making progress`, error);
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }


  async resolve(path: string): Promise<LocatorResolution> {
    const canonical = path === "/" ? "" : `/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
    const response = await this.checked(await this.request(`/.well-known/arbor${canonical}`, {
      headers: this.headers(),
    }));
    return response.json();
  }

  /**
   * Submit a complete candidate against the accepted update it was derived
   * from. A null base activates a reserved tree with its initial snapshot; the
   * response then carries the first accepted update.
   */
  async submitUpdate(
    tree: string,
    base: string | null,
    snapshot: TreeSnapshot,
    options: { change?: string; deltas?: ObjectDelta[]; ifCurrent?: string; resolves?: CandidateUpdate["resolves"] } = {},
  ): Promise<UpdateResult> {
    const update: CandidateUpdate = {
      change: options.change ?? crypto.randomUUID(),
      trace: null,
      candidate: snapshot.root,
      resolves: options.resolves ?? [],
      ...(options.ifCurrent !== undefined ? { ifCurrent: options.ifCurrent } : {}),
      objects: [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
      deltas: options.deltas ?? [],
    };
    return (await this.submitUpdates(tree, { base, updates: [update] })).results[0]!;
  }

  /**
   * Declare a tree: the first snapshot of its configuration, addressed as
   * `tr_x;arbor-config`. The tree stays awaiting initialization until an
   * administrator submits its own first snapshot with a null base.
   */
  async declareTree(tree: string, configuration: TreeSnapshot, options: { change?: string } = {}): Promise<UpdateResult> {
    return this.submitUpdate(`${tree};${CONFIGURATION_PARAMETER}`, null, configuration, options);
  }

  /** A tree's accepted configuration, which only its administrators may read. */
  async treeConfiguration(tree: string): Promise<{ tree: CurrentTree["tree"]; snapshot: TreeSnapshot }> {
    const id = treeConfigurationID(tree);
    const current = await this.descriptor(id);
    return { tree: current.tree, snapshot: await this.snapshot(id, current.tree.root) };
  }

  /** Submit one append-only string of candidate generations against a confirmed watchpoint. */
  async submitUpdates(tree: string, request: UpdateRequest): Promise<UpdateResponse> {
    // A `tr_x;arbor-config` reference is answered under the configuration's TreeID.
    const reference = /^tr_[a-z2-7]+;arbor-config$/.test(tree) ? parseTreeReference(tree) : null;
    const expected = updateRequestDigests(reference ? treeConfigurationID(reference.tree) : tree, request);
    const response = await this.request(`/.arbor/trees/${encodeURIComponent(tree)}/updates`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(encodeUpdateRequestJSON(request)),
    });
    if (response.status === 422) {
      const body = await response.clone().json() as OverstoryError;
      if (body.error === "unsupported-operation" && body.retryable === false) throw new ProtocolUnsupportedOperation(body);
    }
    if (response.status === 409) {
      const body = await response.json() as { error?: unknown; message?: unknown };
      if (body.error === "conflict") {
        const conflict = decodeUpdateConflictJSON(body);
        if (conflict.details.failedIndex >= expected.length
          || conflict.details.completed.some((item, index) => item.requestDigest !== expected[index])) {
          throw new Error("Server conflict update-string identity mismatch");
        }
        throw new ProtocolUpdateConflict(conflict);
      }
      throw new Error(`${response.url}: ${typeof body.error === "string" ? body.error : "update rejected"}${typeof body.message === "string" ? `: ${body.message}` : ""}`);
    }
    const result = decodeUpdateResponseJSON(await (await this.checked(response)).json());
    if (result.results.length !== expected.length
      || result.results.some((item, index) => item.requestDigest !== expected[index])) {
      throw new Error("Server response update-string identity mismatch");
    }
    return result;
  }

  async access(tree: string): Promise<SnapshotEnvelope<RemoteAccessEntry[]> & { policy?: import("./index.ts").SafeResourceAccessRule[] }> {
    const response = await this.checked(await this.request(
      `/.arbor/trees/${encodeURIComponent(tree)}/access`,
      { headers: this.headers() },
    ));
    return response.json();
  }

  /**
   * Follow one tree's accepted transitions strictly after `after`. The stream
   * ends when the server closes it or sends
   * `resync-required`; the caller reconnects with a fresh cursor.
   */
  async *watch(tree: TreeID, after: EventCursor | null, options: { signal?: AbortSignal } = {}): AsyncGenerator<WatchEvent> {
    const query = after ? `?after=${encodeURIComponent(after)}` : "";
    const response = await this.checked(await this.request(`/.arbor/trees/${encodeURIComponent(tree)}/watch${query}`, {
      headers: { ...this.headers(), accept: "text/event-stream" },
      signal: options.signal ?? new AbortController().signal,
    }));
    if (!response.body) throw new Error("Watch response has no body");
    for await (const frame of parseSSEStream(response.body)) {
      if (!frame.data) continue;
      const decoded = JSON.parse(frame.data) as { cursor?: unknown; tree?: unknown; kind?: unknown; change?: unknown };
      if (typeof decoded.cursor !== "string" || typeof decoded.kind !== "string" || decoded.tree !== tree
        || frame.id !== decoded.cursor || frame.event !== decoded.kind) {
        throw new Error("Malformed Arbor watch event");
      }
      if (decoded.kind === "tree.update") {
        yield decodeTreeRefChange(tree, decoded.cursor, decoded.change);
      } else if (decoded.kind === "resync-required") {
        const reason = (decoded.change as { reason?: unknown } | null)?.reason;
        yield { kind: "resync-required", cursor: decoded.cursor, tree, ...(typeof reason === "string" ? { reason } : {}) };
        return;
      } else {
        throw new Error("Malformed Arbor watch event: unsupported kind");
      }
    }
  }

  async object(tree: TreeID, hash: string): Promise<Uint8Array> {
    const response = await this.checked(await this.request(`/.arbor/trees/${encodeURIComponent(tree)}/objects/${hash}`, {
      headers: this.headers(),
    }));
    return new Uint8Array(await response.arrayBuffer());
  }

}
