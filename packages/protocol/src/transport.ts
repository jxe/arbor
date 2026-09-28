import { decodeAcceptedWatchChange, decodeDecisionPage, type DecisionPage } from "./updates/accepted-contract.ts";
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
  type PublishedDeviceKeys,
  type DeviceSessionChallenge,
} from "./index.ts";
import {
  type ObjectHash,
  type TreeSnapshot,
} from "./objects.ts";
import {
  WIRE_CONTENT_TYPE,
  decodeUpdateConflictJSON,
  decodeUpdateResponseJSON,
  decodeWireBody,
  encodeCandidateUpdateJSON,
  encodeUpdateRequestJSON,
  encodeWireBody,
  wireEncodingOf,
  type WireEncoding,
} from "./updates/json.ts";
import { updateRequestDigests } from "./updates/intent.ts";
import { CONFIGURATION_PARAMETER, parseTreeReference, treeConfigurationID } from "./config/tree-config.ts";
import { decodeSnapshotBundle } from "./snapshots.ts";


/** Three missed keepalives. */
const WATCH_IDLE_TIMEOUT_MS = 60_000;

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

/**
 * A profile's placement root on a placement host (accounts §1.3): the
 * ordinary tree the claim declares where the host allocates the account, as
 * the parent of the person's trees there.
 */
export interface RemotePlacementRoot {
  id: TreeID;
  /** The canonical path the host mounts it at (canopyd: `/~handle`). */
  path: string;
  /** Its descriptor once its first snapshot activated it; null until then. */
  tree: RemoteTreeDescriptor | null;
}

/**
 * The account descriptor a placement host returns (accounts §1.3). It has no
 * `configuration`: the profile's configuration lives only at `homeHost`.
 */
export interface RemotePlacementAccountDescriptor extends Omit<RemoteAccountDescriptor, "configuration"> {
  /** The origin of the profile's home host, whose device keys this host reads. */
  homeHost: string;
  placementRoot: RemotePlacementRoot;
}

export interface RemoteAccountSnapshot {
  account: RemoteAccountDescriptor;
  observedThrough: EventCursor;
}

export interface RemotePlacementAccountSnapshot {
  account: RemotePlacementAccountDescriptor;
  observedThrough: EventCursor;
}

/** Whether an account descriptor is a placement host's. */
export function isPlacementAccountDescriptor(
  account: RemoteAccountDescriptor | RemotePlacementAccountDescriptor,
): account is RemotePlacementAccountDescriptor {
  return typeof (account as { homeHost?: unknown }).homeHost === "string";
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
  /** The configuration tree's activation element: its complete first snapshot (accounts §1.2). */
  configuration: CandidateUpdate;
}

/**
 * The activation element of a tree's first snapshot: snapshot semantics
 * (`trace: null`), no resolutions, every object complete and no deltas. A
 * claim carries its configuration in this shape, and `declareTree` sends it.
 */
export function activationElement(snapshot: TreeSnapshot, change: string = crypto.randomUUID()): CandidateUpdate {
  return {
    change,
    trace: null,
    candidate: snapshot.root,
    resolves: [],
    objects: [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
    deltas: [],
  };
}

/** A device a claim or pairing adds: its DeviceID, label and public `key`. */
export interface DeviceEnrollment { id: string; label: string; key: string }

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
  const change = decodeAcceptedWatchChange<RemoteTreeDescriptor>(value, tree);
  const requestDigest = (value as { requestDigest?: unknown }).requestDigest;
  if (requestDigest !== undefined && (typeof requestDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(requestDigest))) {
    throw new Error("Malformed tree.update request digest");
  }
  return {
    kind: "tree.update",
    cursor,
    tree,
    descriptor: change.descriptor,
    transitions: change.transitions,
    ...(requestDigest ? { requestDigest: requestDigest as ObjectHash } : {}),
  };
}

/**
 * An HTTP failure. `code`, `retryable` and `details` come from the host's
 * error envelope when it sent one; classify by them, never by the message.
 */
export class ProtocolHTTPError extends Error {
  readonly code?: string;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;

  constructor(readonly status: number, message: string, envelope: Partial<OverstoryError> = {}) {
    super(message);
    this.name = "ProtocolHTTPError";
    if (typeof envelope.error === "string") this.code = envelope.error;
    if (typeof envelope.retryable === "boolean") this.retryable = envelope.retryable;
    if (envelope.details && typeof envelope.details === "object") this.details = envelope.details as Record<string, unknown>;
  }
}

/** The error a non-2xx response stands for, from its body text. */
function httpError(response: Response, body: string): ProtocolHTTPError {
  let envelope: Partial<OverstoryError> = {};
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") envelope = parsed as Partial<OverstoryError>;
  } catch {}
  return new ProtocolHTTPError(
    response.status,
    `${response.url}: ${envelope.error ?? response.status} ${envelope.message ?? (body || response.statusText)}`,
    envelope,
  );
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
  private readonly watchIdleTimeoutMs: number;
  /** How requests that carry objects travel unless a call says otherwise (tree operations §4.4). */
  readonly encoding: WireEncoding;

  constructor(
    readonly origin: string,
    private accountToken?: string,
    options: { timeoutMs?: number; watchIdleTimeoutMs?: number; encoding?: WireEncoding } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.watchIdleTimeoutMs = options.watchIdleTimeoutMs ?? WATCH_IDLE_TIMEOUT_MS;
    this.encoding = options.encoding ?? "cbor";
  }

  private headers(json = false): HeadersInit {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.accountToken ? { authorization: `Bearer ${this.accountToken}` } : {}),
    };
  }

  private async checked(response: Response): Promise<Response> {
    if (response.ok) return response;
    throw httpError(response, await response.text());
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

  /** The account at its home host. A placement host's descriptor is refused: read it with `placementAccount()`. */
  async account(): Promise<RemoteAccountSnapshot> {
    const snapshot = await this.anyAccount();
    if (isPlacementAccountDescriptor(snapshot.account)) {
      throw new Error(`${this.origin} is a placement host for this profile; its home host is ${snapshot.account.homeHost}`);
    }
    return snapshot as RemoteAccountSnapshot;
  }

  /** The account at a placement host (accounts §1.3). */
  async placementAccount(): Promise<RemotePlacementAccountSnapshot> {
    const snapshot = await this.anyAccount();
    if (!isPlacementAccountDescriptor(snapshot.account)) throw new Error(`${this.origin} is this profile's home host, not a placement host`);
    return snapshot as RemotePlacementAccountSnapshot;
  }

  /** The account descriptor as the host sent it, home or placement. */
  async anyAccount(): Promise<RemoteAccountSnapshot | RemotePlacementAccountSnapshot> {
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

  async joinAccount(input: ExistingProfileAccountRequest, options: { encoding?: WireEncoding } = {}): Promise<AccountClaimResult> {
    const encoding = options.encoding ?? this.encoding;
    const response = await this.checked(await this.request("/.arbor/accounts", {
      method: "PUT",
      headers: { "content-type": WIRE_CONTENT_TYPE[encoding] },
      body: encodeWireBody({
        account: input.account,
        profileTree: input.profileTree,
        configurationTree: input.configurationTree,
        challenge: input.challenge,
        publicKey: input.publicKey,
        signature: input.signature,
        ...(input.inviteCode ? { inviteCode: input.inviteCode } : {}),
        device: input.device,
        configuration: encodeCandidateUpdateJSON(input.configuration, encoding),
      }, encoding) as Uint8Array<ArrayBuffer>,
    }));
    return response.json();
  }

  /** A profile's key devices, as its home host publishes them for placement hosts (accounts §5.4). */
  async publishedDeviceKeys(profileTree: TreeID): Promise<PublishedDeviceKeys> {
    const response = await this.checked(await this.request(`/.arbor/profiles/${encodeURIComponent(profileTree)}/device-keys`, {}));
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
    const response = await this.checked(await this.request(`/.well-known/arbor${encodedCanonicalPath(path)}`, {
      headers: this.headers(),
    }));
    return response.json();
  }

  /**
   * The configuration of the tree whose canonical root is `path`
   * (`/~joe/todos;arbor-config`). Hosts answer only the tree's
   * administrators; anyone else gets the 404 of an unreadable tree.
   */
  async resolveConfiguration(path: string): Promise<LocatorResolution> {
    const response = await this.checked(await this.request(`/.well-known/arbor${encodedCanonicalPath(path) || "/"};arbor-config`, {
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
      ...activationElement(snapshot, options.change),
      resolves: options.resolves ?? [],
      ...(options.ifCurrent !== undefined ? { ifCurrent: options.ifCurrent } : {}),
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

  /**
   * Submit one append-only string of candidate generations against a
   * confirmed watchpoint. `encoding` chooses how the request and its success
   * response travel; either carries the same request and digests.
   */
  async submitUpdates(tree: string, request: UpdateRequest, options: { encoding?: WireEncoding } = {}): Promise<UpdateResponse> {
    const encoding = options.encoding ?? this.encoding;
    // A `tr_x;arbor-config` reference is answered under the configuration's TreeID.
    const reference = /^tr_[a-z2-7]+;arbor-config$/.test(tree) ? parseTreeReference(tree) : null;
    const expected = updateRequestDigests(reference ? treeConfigurationID(reference.tree) : tree, request);
    const response = await this.request(`/.arbor/trees/${encodeURIComponent(tree)}/updates`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": WIRE_CONTENT_TYPE[encoding], accept: WIRE_CONTENT_TYPE[encoding] },
      body: encodeWireBody(encodeUpdateRequestJSON(request, encoding), encoding) as Uint8Array<ArrayBuffer>,
    });
    if (!response.ok) {
      const body = await response.text();
      const error = httpError(response, body);
      if (error.status === 422 && error.code === "unsupported-operation" && error.retryable === false) {
        throw new ProtocolUnsupportedOperation(JSON.parse(body) as OverstoryError);
      }
      if (error.status === 409 && error.code === "conflict") {
        let conflict: UpdateConflictResult;
        // A conflict without the update details (a boundary conflict among them)
        // is still a refusal: it keeps its code rather than failing to decode.
        try { conflict = decodeUpdateConflictJSON(JSON.parse(body)); } catch { throw error; }
        if (conflict.details.failedIndex >= expected.length
          || conflict.details.completed.some((item, index) => item.requestDigest !== expected[index])) {
          throw new Error("Server conflict update-string identity mismatch");
        }
        throw new ProtocolUpdateConflict(conflict);
      }
      // Any other refusal (a 409 `resync-required` among them) keeps its code.
      throw error;
    }
    // Error envelopes are JSON on every route; a success answers in the encoding its Content-Type names.
    const answered = wireEncodingOf(response.headers.get("content-type"));
    const result = decodeUpdateResponseJSON(decodeWireBody(new Uint8Array(await response.arrayBuffer()), answered), answered);
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
   * ends when the server closes it or sends `resync-required`; the caller
   * reconnects with a fresh cursor. `onOpen` runs once the host has accepted
   * the stream.
   */
  async *watch(tree: TreeID, after: EventCursor | null, options: { signal?: AbortSignal; onOpen?: () => void } = {}): AsyncGenerator<WatchEvent> {
    const query = after ? `?after=${encodeURIComponent(after)}` : "";
    // The host comments at least every 20 s; a longer silence is a dead
    // connection (a half-open socket, a proxy that dropped it), not an idle tree.
    const idle = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expectBytes = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => idle.abort(), this.watchIdleTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
    };
    expectBytes();
    try {
      const response = await this.checked(await this.request(`/.arbor/trees/${encodeURIComponent(tree)}/watch${query}`, {
        headers: { ...this.headers(), accept: "text/event-stream" },
        signal: options.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal,
      }));
      if (!response.body) throw new Error("Watch response has no body");
      options.onOpen?.();
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { expectBytes(); controller.enqueue(chunk); },
      }));
      yield* this.watchEvents(tree, body);
    } catch (error) {
      if (idle.signal.aborted && !options.signal?.aborted) {
        throw new ProtocolTransportError(`Watch from ${this.origin} went silent`, error);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async *watchEvents(tree: TreeID, body: ReadableStream<Uint8Array>): AsyncGenerator<WatchEvent> {
    for await (const frame of parseSSEStream(body)) {
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

/** A canonical path as URL segments, each encoded once; `/` is empty. */
function encodedCanonicalPath(path: string): string {
  return path === "/" ? "" : `/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}
