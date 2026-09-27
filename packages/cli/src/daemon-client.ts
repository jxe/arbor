import type {
  OverstoryError,
  LocalTreeDescriptor,
  LocalAccountSummary,
  LocatorResolution,
  ProfileIdentity,
  SnapshotEnvelope,
  TreeRef,
  UpdateRequestJSON,
  WorkspaceEvent,
} from "@overstory/protocol";
import { parseSSEStream, reconnectingStream, type ParsedSSEFrame } from "@overstory/protocol/sse";
import { decodeCanonicalCBOR } from "@overstory/protocol/cbor";

export type {
  OverstoryErrorCode,
  OverstoryError,
  EventCursor,
  LocalTreeDescriptor,
  LocatorResolution,
  TreeDescriptor,
  TreeRef,
  WorkspaceEvent,
} from "@overstory/protocol";

/**
 * The `arbor` command's client of the daemon's loopback surface: status,
 * trees, accounts, resolution, synchronization, placement moves, and the
 * working-tree loopback services (bootstrap, credential, objects) and
 * observation that the disposable-daemon tests drive through it. It is CLI
 * code, not a shared package (Native 011): the Mac app has its own Swift
 * client, and Web 025's `LocalHost` writes a browser-safe one against the
 * same reduced surface.
 */

export interface ArborSyncStatus {
  service: string;
  version: string;
  protocolVersion: string;
  instanceID: string;
  runtimeKind: "persistent" | "foreground" | "cloud";
}

export class ArborSyncError extends Error {
  readonly payload: OverstoryError;
  constructor(
    public status: number,
    public value: OverstoryError,
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
}

// Account and identity values are the shared vocabulary in @overstory/protocol:
// Arbor Sync reports exactly what the protocol and the data-home stores use.
export type { LocalAccountSummary, ProfileIdentity } from "@overstory/protocol";

/** `GET /v1/bootstrap?tree=`: what a loopback client needs to open a placed tree as its own working tree. */
export type BootstrapTreeDescriptor = Pick<
  LocalTreeDescriptor,
  "id" | "configurationTree" | "kind" | "access" | "canonical" | "name" | "osPath" | "placement"
>;

export interface TreeBootstrap {
  /** Placement and routing metadata only; daemon synchronization state is deliberately excluded. */
  tree: BootstrapTreeDescriptor;
  /** The daemon's accepted base; `cursor` equals `update` and seeds a protocol watch. */
  accepted: { root: string; update: string; cursor: string | null };
  /** The sparse CBOR snapshot bundle's bytes: every directory object plus every Markdown file object. */
  spine: Uint8Array;
  observedThrough: string;
}

/** `GET /v1/credential`: a session of the account's device, which a same-installation client shares with the daemon. */
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

/** `GET /v1/pending?tree=`: the request a placed folder would publish next, exactly as it would be sent. */
export interface PendingUpdate {
  tree: string;
  paused: boolean;
  /** The accepted base the request names; null with `request` when nothing is pending. */
  base: { root: string; update: string } | null;
  request: UpdateRequestJSON | null;
}

/** `GET /v1/declined?tree=`: a placed folder's declined work, kept on disk while the rest syncs. */
export interface DeclinedChanges {
  tree: string;
  /** Why the host declined, as it said. */
  detail?: string;
  /** The entries the declined request changed that the folder has not yet brought back to the accepted state. */
  paths: string[];
  /** Where that work is on disk now, including content moved out of a declined path. */
  points: string[];
  since: string;
  request: { digest: string; base: { root: string; update: string }; candidate: string };
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

  /** Bootstrap material for a placed tree: accepted base and sparse spine, answered as canonical CBOR. */
  async bootstrap(tree: string): Promise<TreeBootstrap> {
    const response = await this.fetcher(`${this.baseURL}/v1/bootstrap?tree=${encodeURIComponent(tree)}`, { headers: { accept: "application/cbor" } });
    if (!response.ok) await this.throwResponse(response);
    const value = decodeCanonicalCBOR(new Uint8Array(await response.arrayBuffer())) as TreeBootstrap;
    if (!(value?.spine instanceof Uint8Array)) throw new Error("Bootstrap spine must be a CBOR byte string");
    return value;
  }

  /** A session of the device for a configuration tree's account (or the only connected account when omitted). */
  credential(configurationTree?: string): Promise<TreeCredential> {
    const query = configurationTree ? `?configurationTree=${encodeURIComponent(configurationTree)}` : "";
    return this.request(`/v1/credential${query}`);
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

  /** Stop publishing a placed folder's changes until resumed. */
  pauseFolder(tree: string): Promise<{ tree: string; paused: boolean }> {
    return this.request("/v1/placements/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tree }),
    });
  }

  /** Publish a paused folder's changes again. */
  resumeFolder(tree: string): Promise<{ tree: string; paused: boolean }> {
    return this.request("/v1/placements/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tree }),
    });
  }

  /** A placed folder's declined work, or null when nothing is declined. */
  async declined(tree: string): Promise<DeclinedChanges | null> {
    return (await this.request<{ declined: DeclinedChanges | null }>(`/v1/declined?tree=${encodeURIComponent(tree)}`)).declined;
  }

  /** Put the host's state back at a folder's declined paths; its other changes are kept. */
  restoreDeclined(tree: string): Promise<{ tree: string }> {
    return this.request("/v1/declined/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tree }),
    });
  }

  /** Publish a folder's declined paths again as the folder holds them now. */
  resendDeclined(tree: string): Promise<{ tree: string }> {
    return this.request("/v1/declined/resend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tree }),
    });
  }

  /** What a placed folder would publish next, without sending it. */
  pending(tree: string): Promise<PendingUpdate> {
    return this.request(`/v1/pending?tree=${encodeURIComponent(tree)}`);
  }

  /** The claimed Canopy accounts of this data home and the local person identity, if one exists. */
  accounts(): Promise<{ accounts: LocalAccountSummary[]; identity: ProfileIdentity | null }> {
    return this.request("/v1/accounts");
  }

  async *observe(after: string, signal?: AbortSignal): AsyncGenerator<WorkspaceEvent> {
    let cursor = after;
    const client = this;
    async function* connect(): AsyncGenerator<WorkspaceEvent> {
      const response = await client.fetcher(`${client.baseURL}/v1/events?after=${encodeURIComponent(cursor)}`, {
        headers: { accept: "text/event-stream" },
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) await client.throwResponse(response);
      if (!response.body) throw new Error("SSE response has no body");
      for await (const frame of parseSSEStream(response.body)) {
        const event = client.parseEvent(frame);
        if (event) {
          cursor = event.cursor;
          yield event;
        }
      }
    }
    yield* reconnectingStream(connect, {
      ...(signal ? { signal } : {}),
      fatal: (error) => error instanceof ArborSyncError,
    });
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
    const response = await this.fetcher(`${this.baseURL}${path}`, init);
    if (!response.ok) await this.throwResponse(response);
    return await response.json() as T;
  }

  private async throwResponse(response: Response): Promise<never> {
    let envelope: OverstoryError;
    try { envelope = await response.json() as OverstoryError; }
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
