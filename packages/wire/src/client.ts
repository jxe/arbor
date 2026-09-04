import type {
  AcceptedTransition,
  UpdateConflictResult,
  IfMatch,
  OnConflict,
  UpdateRequest,
  UpdateResult,
  ObjectDelta,
  ServerDevice,
  PairingOffer,
} from "./updates/types.ts";
import {
  parseSSEStream,
  type AccessEntry,
  type ArborError,
  type EventCursor,
  type LocatorResolution,
  type RemoteTreeDescriptor,
  type SnapshotEnvelope,
  type TreeID,
  type AccountChallenge,
} from "@arbor/core";
import {
  type ObjectHash,
  type TreeSnapshot,
} from "./objects.ts";
import {
  decodeAcceptedTransitionJSON,
  decodeTreeSnapshotJSON,
  decodeUpdateConflictJSON,
  decodeUpdateResultJSON,
  encodeTreeSnapshotJSON,
  verifyTreeSnapshotGraph,
  encodeUpdateRequestJSON,
} from "./updates/json.ts";
import { updateRequestDigest } from "./updates/intent.ts";

export type { RemoteTreeDescriptor } from "@arbor/core";

export interface CurrentTree {
  tree: RemoteTreeDescriptor;
  observedThrough: EventCursor;
}

export interface CurrentTreeSnapshot {
  tree: RemoteTreeDescriptor;
  snapshot: TreeSnapshot;
  observedThrough: EventCursor;
}

export class WireUpdateConflict extends Error {
  constructor(readonly result: UpdateConflictResult) {
    super("Server could not safely accept the candidate update");
    this.name = "WireUpdateConflict";
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
  device: { id: string; label: string; credentialDigest: `sha256:${string}` };
  configuration: TreeSnapshot;
}

export interface PairingClaimResult {
  device: ServerDevice;
  confirmationCode: string;
}

export type RemoteAccessEntry = AccessEntry;

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
  | { kind: "resync-required"; cursor: EventCursor; tree: TreeID; reason?: string }
  | { kind: string; cursor: EventCursor; tree: TreeID; change: unknown };

function decodeTreeRefChange(tree: TreeID, cursor: EventCursor, value: unknown): Extract<WatchEvent, { kind: "tree.update" }> {
  if (!value || typeof value !== "object") throw new Error("Malformed tree.update change");
  const change = value as { descriptor?: RemoteTreeDescriptor; transitions?: unknown; requestDigest?: unknown };
  const descriptor = change.descriptor;
  if (!descriptor || descriptor.id !== tree || !Array.isArray(change.transitions) || !change.transitions.length) {
    throw new Error("Malformed tree.update change");
  }
  const transitions = change.transitions.map(decodeAcceptedTransitionJSON);
  let previous: AcceptedTransition | undefined;
  for (const transition of transitions) {
    if (transition.update.tree !== tree) throw new Error("Watch transition names another tree");
    if (previous && transition.update.previousRoot !== previous.update.root) {
      throw new Error("Watch transitions are not contiguous");
    }
    previous = transition;
  }
  const final = transitions.at(-1)!;
  if (final.update.id !== descriptor.update || final.update.root !== descriptor.root || final.update.id !== cursor) {
    throw new Error("Watch descriptor does not end at its final transition");
  }
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

export class WireTransportError extends TypeError {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "WireTransportError";
    this.cause = cause;
  }
}

export class WireClient {
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
    let envelope: ArborError | undefined;
    try { envelope = JSON.parse(body) as ArborError; } catch {}
    throw new Error(`${response.url}: ${envelope?.error ?? response.status} ${envelope?.message ?? (body || response.statusText)}`);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`${this.origin}${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new WireTransportError(`Could not reach Arbor server at ${this.origin}`, error);
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
    device: { id: string; label: string; credentialDigest: `sha256:${string}` },
    placements: Record<TreeID, { server: string; path?: string }> = {},
  ): Promise<PairingClaimResult> {
    const response = await this.checked(await this.request(`/.arbor/pairings/${encodeURIComponent(id)}/claim`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, device, placements }),
    }));
    return response.json();
  }

  async createAccountChallenge(input: {
    account: string;
    profileTree: TreeID;
    configurationTree: TreeID;
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
        device: input.device,
        configuration: encodeTreeSnapshotJSON(input.configuration),
      }),
    }));
    return response.json();
  }

  async list(): Promise<SnapshotEnvelope<RemoteTreeDescriptor[]>> {
    const response = await this.checked(await this.request("/.arbor/trees", { headers: this.headers() }));
    return response.json();
  }

  /** The tree resource itself: its current descriptor and the cursor to watch after. */
  async descriptor(tree: string): Promise<CurrentTree> {
    const response = await this.checked(await this.request(`/.arbor/trees/${encodeURIComponent(tree)}`, { headers: this.headers() }));
    const value = await response.json() as { tree: RemoteTreeDescriptor; observedThrough: EventCursor };
    if (value.tree?.id !== tree || typeof value.tree.root !== "string" || !value.tree.update) throw new Error("Tree descriptor does not match its tree");
    return { tree: value.tree, observedThrough: value.observedThrough };
  }

  async currentSnapshot(tree: string): Promise<CurrentTreeSnapshot> {
    const response = await this.checked(await this.request(
      `/.arbor/trees/${encodeURIComponent(tree)}/snapshot`,
      { headers: this.headers() },
    ));
    const value = await response.json() as {
      tree: RemoteTreeDescriptor;
      root: ObjectHash;
      objects: Array<{ hash: ObjectHash; bytes: string }>;
      observedThrough: EventCursor;
    };
    const snapshot = verifyTreeSnapshotGraph(decodeTreeSnapshotJSON({ root: value.root, objects: value.objects }));
    if (value.tree.id !== tree || value.tree.root !== snapshot.root || !value.tree.update) {
      throw new Error("Current snapshot descriptor does not match its graph");
    }
    return { tree: value.tree, snapshot, observedThrough: value.observedThrough };
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
    options: { deltas?: ObjectDelta[]; ifMatch?: IfMatch; onConflict?: OnConflict } = {},
  ): Promise<UpdateResult> {
    const request: UpdateRequest = {
      base,
      candidate: snapshot.root,
      ifMatch: options.ifMatch ?? (base === null ? "bytesHash" : "modelHash"),
      ...(options.onConflict !== undefined ? { onConflict: options.onConflict } : {}),
      objects: [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
      deltas: options.deltas ?? [],
    };
    const response = await this.request(`/.arbor/trees/${encodeURIComponent(tree)}/updates`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(encodeUpdateRequestJSON(request)),
    });
    if (response.status === 409) {
      const body = await response.json() as { error?: unknown; message?: unknown };
      if (body.error === "conflict") throw new WireUpdateConflict(decodeUpdateConflictJSON(body));
      throw new Error(`${response.url}: ${typeof body.error === "string" ? body.error : "update rejected"}${typeof body.message === "string" ? `: ${body.message}` : ""}`);
    }
    const result = decodeUpdateResultJSON(await (await this.checked(response)).json());
    if (result.requestDigest !== updateRequestDigest(tree, request)) {
      throw new Error("Server response request digest mismatch");
    }
    return result;
  }

  async access(tree: string): Promise<SnapshotEnvelope<RemoteAccessEntry[]>> {
    const response = await this.checked(await this.request(
      `/.arbor/trees/${encodeURIComponent(tree)}/access`,
      { headers: this.headers() },
    ));
    return response.json();
  }

  /**
   * Follow one tree's accepted transitions and other observations strictly
   * after `after`. The stream ends when the server closes it or sends
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
        yield { kind: decoded.kind, cursor: decoded.cursor, tree, change: decoded.change };
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
