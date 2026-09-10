import type {
  ArborError,
  LocalTreeDescriptor,
  LocalAccountSummary,
  LocatorResolution,
  MutationReceipt,
  PairingOffer,
  ProfileIdentity,
  SnapshotEnvelope,
  SyncConflictResolution,
  SyncConflictWorkspace,
  TreeRef,
  WorkspaceEvent,
} from "@arbor/core";
import { parseSSEStream, type ParsedSSEFrame } from "@arbor/core/sse";

export type {
  ArborErrorCode,
  ArborError,
  EventCursor,
  LocalTreeDescriptor,
  LocatorResolution,
  TreeDescriptor,
  SyncConflictResolution,
  SyncConflictWorkspace,
  TreeRef,
  WorkspaceEvent,
} from "@arbor/core";

/**
 * The TypeScript client of the daemon's control surface: status, trees,
 * accounts, conflicts, synchronization, placements, bootstrap, credential,
 * objects, pairings, and observation. The node, mutation, admission, asset,
 * and import methods were deleted with the daemon's editor path (Native 022
 * Phase 7); the web editor returns as a working-tree client in Plan B.
 */

export interface ArborSyncStatus {
  service: string;
  version: string;
  protocolVersion: string;
  instanceID: string;
  runtimeKind: "persistent" | "foreground" | "cloud";
  deviceID?: string;
}

export class ArborSyncError extends Error {
  readonly payload: ArborError;
  constructor(
    public status: number,
    public value: ArborError,
  ) {
    super(value.message);
    this.name = "ArborSyncError";
    this.payload = {
      error: value.error,
      message: value.message,
      retryable: value.retryable,
      ...(value.path !== undefined ? { path: value.path } : {}),
      ...(value.tree !== undefined ? { tree: value.tree } : {}),
      ...(value.details !== undefined ? { details: value.details } : {}),
    };
  }
}

export interface ArborSyncRESTClientOptions {
  baseURL?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Accepted for compatibility with older callers; the client no longer retries anything. */
  retryDelay?: (attempt: number) => Promise<void>;
}

// Account, identity, and pairing values are the shared vocabulary in @arbor/core:
// Arbor Sync reports exactly what Canopy's Wire and the data-home stores use.
export type { LocalAccountSummary, PairingOffer, ProfileIdentity } from "@arbor/core";

/** One element of a daemon-stored update string, in the JSON wire shape (`CandidateUpdateJSON` in `@arbor/wire`). */
export interface BootstrapCandidateUpdate {
  candidate: string;
  ifMatch: "bytesHash" | "modelHash";
  onConflict?: "merge" | "reject";
  objects: Array<{ hash: string; bytes: string }>;
  deltas: Array<{ base: string; result: string; instructions: unknown[] }>;
}

/** `GET /v1/bootstrap?tree=`: what a loopback client needs to open a placed tree as its own working tree. */
export interface TreeBootstrap {
  tree: LocalTreeDescriptor;
  /** The daemon's accepted base; `cursor` equals `update` and seeds a Wire watch. */
  accepted: { root: string; update: string; cursor: string };
  /** Base64 sparse CBOR snapshot bundle: every directory object plus every Markdown file object. */
  spine: string;
  /** Every non-Markdown file entry by wire path; objects are fetched on demand through `/v1/objects`. */
  files: Record<string, { size: number; mtime: number }>;
  /** The daemon's stored update string, verbatim, when it still ends at the folder exactly. */
  pending?: { base: string | null; updates: BootstrapCandidateUpdate[]; requestDigests: string[] };
  blocked?: "conflict" | "unsettled";
  observedThrough: string;
}

/** `GET /v1/credential`: the account credential a same-installation client shares with the daemon. */
export interface TreeCredential {
  token: string;
}

export interface LocalPlacementMoveResult {
  tree: string;
  configurationTree: string;
  source: string;
  destination: string;
  check: boolean;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ArborSyncRESTClient {
  private baseURL: string;
  private fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  constructor(options: ArborSyncRESTClientOptions = {}) {
    this.baseURL = options.baseURL?.replace(/\/$/, "") ?? "";
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  }

  trees(): Promise<SnapshotEnvelope<LocalTreeDescriptor[]>> {
    return this.request("/v1/trees");
  }

  /** Verified wire object bytes for a tree; `origin` names the Canopy for an unplaced tree. */
  async object(tree: string, hash: string, origin?: string): Promise<Uint8Array> {
    const query = new URLSearchParams({ tree, ...(origin ? { origin } : {}) });
    const response = await this.fetcher(`${this.baseURL}/v1/objects/${encodeURIComponent(hash)}?${query}`);
    if (!response.ok) await this.throwResponse(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Bootstrap material for a placed tree: accepted base, sparse spine, file map, and any verbatim pending update. */
  bootstrap(tree: string): Promise<TreeBootstrap> {
    return this.request(`/v1/bootstrap?tree=${encodeURIComponent(tree)}`);
  }

  /** The account credential for a configuration tree (or the only connected account when omitted). */
  credential(configurationTree?: string): Promise<TreeCredential> {
    const query = configurationTree ? `?configurationTree=${encodeURIComponent(configurationTree)}` : "";
    return this.request(`/v1/credential${query}`);
  }

  conflict(tree: string): Promise<SyncConflictWorkspace> {
    return this.request(`/v1/conflicts?tree=${encodeURIComponent(tree)}`);
  }

  resolveConflict(
    tree: string,
    identity: string,
    resolutions: Record<string, SyncConflictResolution>,
  ): Promise<{ effects: MutationReceipt["effects"] }> {
    return this.request("/v1/conflicts/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tree, identity, resolutions }),
    });
  }

  resolve(locator: string): Promise<LocatorResolution> {
    return this.request(`/v1/resolve?locator=${encodeURIComponent(locator)}`);
  }

  status(): Promise<ArborSyncStatus> {
    return this.request("/v1/status");
  }

  synchronizeNow(configurationTree?: string): Promise<{ synchronized: true }> {
    return this.request("/v1/sync", {
      method: "POST",
      ...(configurationTree ? {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configurationTree }),
      } : {}),
    });
  }

  movePlacement(source: string, destination: string, check = false): Promise<LocalPlacementMoveResult> {
    return this.request("/v1/placements/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, destination, check }),
    });
  }

  claimAccount(input: { account: string; path: string; displayName?: string }): Promise<MutationReceipt> {
    return this.request("/v1/bootstrap/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }

  /** The claimed Canopy accounts of this data home and the local person identity, if one exists. */
  accounts(): Promise<{ accounts: LocalAccountSummary[]; identity: ProfileIdentity | null }> {
    return this.request("/v1/accounts");
  }

  createProfileIdentity(path: string): Promise<{ identity: ProfileIdentity }> {
    return this.request("/v1/me", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
  }

  createCommunityPairing(configurationTree?: string): Promise<PairingOffer> {
    return this.request("/v1/bootstrap/pairings", {
      method: "POST",
      ...(configurationTree ? {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configurationTree }),
      } : {}),
    });
  }

  forgetLocalAccount(): Promise<{ forgotten: true }> {
    return this.request("/v1/local/forget", { method: "POST" });
  }

  async *observe(after: string, signal?: AbortSignal): AsyncGenerator<WorkspaceEvent> {
    let cursor = after;
    let reconnectAttempt = 0;
    while (!signal?.aborted) {
      try {
        const response = await this.fetcher(`${this.baseURL}/v1/events?after=${encodeURIComponent(cursor)}`, {
          headers: { accept: "text/event-stream" },
          signal,
        });
        if (!response.ok) await this.throwResponse(response);
        if (!response.body) throw new Error("SSE response has no body");
        reconnectAttempt = 0;
        for await (const frame of parseSSEStream(response.body)) {
          const event = this.parseEvent(frame);
          if (event) {
            cursor = event.cursor;
            yield event;
          }
        }
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof ArborSyncError) throw error;
        reconnectAttempt += 1;
        await delay(Math.min(5_000, 250 * (2 ** Math.min(reconnectAttempt - 1, 5))));
      }
    }
  }

  private parseEvent(frame: ParsedSSEFrame): WorkspaceEvent | null {
    const { id, event: eventName, data } = frame;
    if (!data) return null;
    const decoded = JSON.parse(data) as { cursor?: unknown; tree?: unknown; kind?: unknown; change?: unknown };
    if (!id || !eventName || id !== decoded.cursor || eventName !== decoded.kind || !decoded.change) {
      throw new TypeError("Malformed Arbor observation event");
    }
    if (eventName === "resync-required") {
      throw new ArborSyncError(409, {
        error: "resync-required",
        message: "The observation cursor is no longer retained",
        retryable: true,
        ...(typeof decoded.tree === "string" ? { tree: decoded.tree as TreeRef } : {}),
      });
    }
    const event = decoded as WorkspaceEvent;
    if (typeof event.change.ref?.path !== "string" || typeof event.change.origin !== "string") {
      throw new TypeError("Malformed Arbor workspace change");
    }
    return event;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseURL}${path}`, init);
    } catch (error) {
      throw error;
    }
    if (!response.ok) await this.throwResponse(response);
    return await response.json() as T;
  }

  private async throwResponse(response: Response): Promise<never> {
    let envelope: ArborError;
    try { envelope = await response.json() as ArborError; }
    catch {
      envelope = { error: "internal-error", message: response.statusText, retryable: false };
    }
    throw new ArborSyncError(response.status, {
      error: envelope.error,
      message: envelope.message,
      retryable: envelope.retryable,
      ...(envelope.tree !== undefined ? { tree: envelope.tree } : {}),
      ...(envelope.path !== undefined ? { path: envelope.path } : {}),
      ...(envelope.details !== undefined ? { details: envelope.details } : {}),
    });
  }
}
