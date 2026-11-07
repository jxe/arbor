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
} from "@ovst/protocol";
import { parseSSEStream, reconnectingStream, type ParsedSSEFrame } from "@ovst/protocol/sse";
import { ProtocolClient, readStorySyncAccess, storySyncAuthorization } from "@ovst/protocol";

export type {
  OverstoryErrorCode,
  OverstoryError,
  EventCursor,
  LocalTreeDescriptor,
  LocatorResolution,
  TreeDescriptor,
  TreeRef,
  WorkspaceEvent,
} from "@ovst/protocol";

/**
 * The `story` command's client of the daemon's loopback surface: status,
 * trees, accounts, resolution, synchronization, placement moves, and the
 * working-tree loopback services (bootstrap, credential, objects) and
 * observation that the disposable-daemon tests drive through it. It is CLI
 * code, not a shared package (Native 011): the Mac app has its own Swift
 * client, and Web 025's `LocalHost` writes a browser-safe one against the
 * same reduced surface.
 */

export interface StorySyncStatus {
  service: string;
  version: string;
  protocolVersion: string;
  instanceID: string;
  runtimeKind: "persistent" | "foreground" | "cloud";
}

export class StorySyncError extends Error {
  readonly payload: OverstoryError;
  constructor(
    public status: number,
    public value: OverstoryError,
  ) {
    super(value.message);
    this.name = "StorySyncError";
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

export interface StorySyncRESTClientOptions {
  baseURL?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** The caller token; read from `dataHome`'s token file (the selected data home by default) when omitted. */
  token?: string;
  dataHome?: string;
}

// Account and identity values are the shared vocabulary in @ovst/protocol:
// Story Sync reports exactly what the protocol and the data-home stores use.
export type { LocalAccountSummary, ProfileIdentity } from "@ovst/protocol";

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

export class StorySyncRESTClient {
  private baseURL: string;
  private token: Promise<string | undefined> | undefined;
  private readonly options: StorySyncRESTClientOptions;
  private fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  constructor(options: StorySyncRESTClientOptions = {}) {
    this.baseURL = options.baseURL?.replace(/\/$/, "") ?? "";
    const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.options = options;
    // Story Sync answers only callers holding its data home's token (data-home.md).
    this.fetcher = async (input, init) => {
      const value = await this.callerToken();
      const headers = new Headers(init?.headers);
      if (value) headers.set("authorization", storySyncAuthorization({ token: value }));
      return fetcher(input, { ...init, headers });
    };
  }

  private callerToken(): Promise<string | undefined> {
    this.token ??= this.options.token !== undefined
      ? Promise.resolve(this.options.token)
      : readStorySyncAccess(this.options.dataHome).then((access) => access?.token);
    return this.token;
  }

  /**
   * The standard Overstory reads of the trees placed here, through Story Sync
   * (descriptor, snapshot, path read, objects, entry metadata, watch): the
   * ordinary protocol client, with this data home's token as its credential.
   */
  async reads(): Promise<ProtocolClient> {
    return new ProtocolClient(this.baseURL, await this.callerToken());
  }

  trees(): Promise<SnapshotEnvelope<LocalTreeDescriptor[]>> {
    return this.request("/v1/trees");
  }

  /** Report an agent's status, result or hook to Story Sync (Agents 001); null when the folder is not placed. */
  async agentReport(body: { session?: string; cwd: string; agent?: string; status?: string; at?: string; done?: string; hook?: unknown }): Promise<{ session: string; tree: string } | null> {
    const result = await this.request<{ session: string; tree: string } | { ignored: string }>("/v1/agents/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return "ignored" in result ? null : result;
  }

  /**
   * A session of the device for a configuration tree's account (or the only
   * connected account when omitted); with `origin`, the session at that host,
   * the home's or a placement account's.
   */
  credential(configurationTree?: string, origin?: string): Promise<TreeCredential> {
    const parameters = new URLSearchParams({
      ...(configurationTree ? { configurationTree } : {}),
      ...(origin ? { origin } : {}),
    }).toString();
    return this.request(`/v1/credential${parameters ? `?${parameters}` : ""}`);
  }

  resolve(locator: string): Promise<LocatorResolution> {
    return this.request(`/v1/resolve?locator=${encodeURIComponent(locator)}`);
  }

  status(): Promise<StorySyncStatus> {
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

  /** The claimed host accounts of this data home and the local person identity, if one exists. */
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
      fatal: (error) => error instanceof StorySyncError,
    });
  }

  private parseEvent(frame: ParsedSSEFrame): WorkspaceEvent | null {
    const { id, event: eventName, data } = frame;
    if (!data) return null;
    const decoded = JSON.parse(data) as { cursor?: unknown; tree?: unknown; kind?: unknown; change?: unknown };
    if (!id || !eventName || id !== decoded.cursor || eventName !== decoded.kind || !decoded.change) {
      throw new TypeError("Malformed Story observation event");
    }
    if (eventName === "resync-required") {
      throw new StorySyncError(409, {
        error: "resync-required",
        message: "The observation cursor is no longer retained",
        retryable: true,
        ...(typeof decoded.tree === "string" ? { tree: decoded.tree as TreeRef } : {}),
      });
    }
    const event = decoded as WorkspaceEvent;
    if (typeof event.change.ref?.path !== "string" || typeof event.change.origin !== "string") {
      throw new TypeError("Malformed Story workspace change");
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
    throw new StorySyncError(response.status, {
      error: envelope.error,
      message: envelope.message,
      retryable: envelope.retryable,
      ...(envelope.tree !== undefined ? { tree: envelope.tree } : {}),
      ...(envelope.path !== undefined ? { path: envelope.path } : {}),
      ...(envelope.details !== undefined ? { details: envelope.details } : {}),
    });
  }
}
