import type {
  ArborSyncErrorEnvelope,
  ArborSyncErrorValue,
  BacklinksPage,
  ChildrenPage,
  ContentMutationRequest,
  ContentRevision,
  ContentWorkspaceOperation,
  DirectoryRevision,
  LogicalPath,
  LocalTreeDescriptor,
  LocatorResolution,
  MutationReceipt,
  MutationEffect,
  MutationRequest,
  NodeRef,
  NodeResponse,
  NodeSummary,
  PageID,
  RecoveryPage,
  SearchPage,
  SnapshotEnvelope,
  StructuralMutationRequest,
  StructuralWorkspaceOperation,
  TreeRef,
  WorkspaceEvent,
} from "@arbor/core";
import { pageIDStableKey } from "@arbor/core/node-key";

export type {
  ArborBlock,
  ArborSyncErrorCode,
  ArborSyncErrorEnvelope,
  ArborSyncErrorValue,
  BacklinkEntry,
  BacklinksPage,
  ChildrenPage,
  ContentMutationRequest,
  ContentRevision,
  ContentWorkspaceOperation,
  DirectoryRevision,
  EventCursor,
  MutationEffect,
  MutationReceipt,
  MutationRequest,
  NodeRef,
  PageID,
  RecoveryEntry,
  RecoveryPage,
  SearchPage,
  TreeDescriptor,
  TreeID,
  StructuralMutationRequest,
  StructuralWorkspaceOperation,
  TreeRef,
  WorkspaceEvent,
  WorkspaceOperation,
} from "@arbor/core";

/** A canonical node sample plus endpoint placement context when available. */
export type NodeSnapshot = NodeResponse;

export class ArborSyncError extends Error {
  readonly payload: ArborSyncErrorEnvelope;
  constructor(
    public status: number,
    public value: ArborSyncErrorValue,
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

export class ArborSyncTransportError extends Error {
  constructor(message: string, public request: PreparedArborSyncRequest, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArborSyncTransportError";
  }
}

export interface PreparedTransferRequest {
  endpoint: "/v1/assets" | "/v1/imports";
  mutationID: string;
  metadata: unknown;
}

export type PreparedArborSyncRequest = MutationRequest | PreparedTransferRequest;

export interface ArborSyncRESTClientOptions {
  baseURL?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  mutationID?: () => string;
  retryDelay?: (attempt: number) => Promise<void>;
}

export type ObservedNodeUpdate =
  | { kind: "event"; event: WorkspaceEvent }
  | { kind: "resync"; snapshot: NodeResponse };

export interface ObservedNodeView {
  snapshot: NodeResponse;
  updates: AsyncIterable<ObservedNodeUpdate>;
  close(): void;
}

export interface CommunityPairingOffer {
  id: string;
  secret: string;
  confirmationCode: string;
  expiresAt: number;
}

/** Build a canonical node reference, retaining a listed Markdown identity when present. */
export function childRef(child: NodeSummary): NodeRef {
  return child.ref;
}

class AsyncBuffer<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private completed = false;
  private failure: unknown;

  push(value: T): void {
    if (this.completed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  finish(error?: unknown): void {
    if (this.completed) return;
    this.completed = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      if (error !== undefined) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.completed) {
          return this.failure !== undefined
            ? Promise.reject(this.failure)
            : Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

function refQuery(ref: NodeRef): string {
  const query = new URLSearchParams();
  query.set("tree", ref.tree);
  query.set("path", ref.path);
  query.set("stableKey", ref.stableKey ?? "");
  return query.toString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ArborSyncRESTClient {
  private baseURL: string;
  private fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private createMutationID: () => string;
  private retryDelay: (attempt: number) => Promise<void>;
  private authoredMutationIDs: string[] = [];
  private authoredMutationSet = new Set<string>();

  constructor(options: ArborSyncRESTClientOptions = {}) {
    this.baseURL = options.baseURL?.replace(/\/$/, "") ?? "";
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.createMutationID = options.mutationID ?? (() => crypto.randomUUID());
    this.retryDelay = options.retryDelay ?? ((attempt) => delay(attempt === 1 ? 100 : 500));
  }

  prepareContentMutation(
    operation: ContentWorkspaceOperation,
    mutationID = this.createMutationID(),
  ): ContentMutationRequest {
    return { mutationID, operations: [operation] };
  }

  prepareStructuralMutation(
    operations: StructuralWorkspaceOperation[],
    mutationID = this.createMutationID(),
  ): StructuralMutationRequest {
    if (operations.length === 0) throw new TypeError("A structural mutation requires at least one operation");
    return {
      mutationID,
      operations: operations as [StructuralWorkspaceOperation, ...StructuralWorkspaceOperation[]],
    };
  }

  node(ref: NodeRef): Promise<NodeResponse> {
    return this.nodeSnapshot(ref);
  }

  trees(): Promise<SnapshotEnvelope<LocalTreeDescriptor[]>> {
    return this.request("/v1/trees");
  }

  resolve(locator: string): Promise<LocatorResolution> {
    return this.request(`/v1/resolve?locator=${encodeURIComponent(locator)}`);
  }

  async treeID(): Promise<string> {
    return (await this.request<{ id: string }>("/v1/tree-ids", { method: "POST" })).id;
  }

  status(): Promise<{ service: string; version: string; protocolVersion: string; deviceID?: string }> {
    return this.request("/v1/status");
  }

  synchronizeNow(): Promise<{ synchronized: true }> {
    return this.request("/v1/sync", { method: "POST" });
  }

  openSession(path: string): Promise<NodeResponse> {
    return this.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
  }

  async file(ref: NodeRef): Promise<{ bytes: Uint8Array; revision: string }> {
    const response = await this.fetcher(`${this.baseURL}/v1/file?${refQuery(ref)}`);
    if (!response.ok) await this.throwResponse(response);
    const revision = response.headers.get("etag")?.replace(/^"|"$/g, "");
    if (!revision) throw new TypeError("File response omitted its content revision");
    return { bytes: new Uint8Array(await response.arrayBuffer()), revision };
  }

  writeText(ref: NodeRef, baseContentRevision: string, source: string, mutationID?: string): Promise<MutationReceipt> {
    return this.mutateContent({ op: "writeText", ref, baseContentRevision, source }, mutationID);
  }

  writeProperties(
    ref: NodeRef,
    basePropertiesRevision: Extract<ContentWorkspaceOperation, { op: "writeProperties" }>["basePropertiesRevision"],
    properties: Extract<ContentWorkspaceOperation, { op: "writeProperties" }>["properties"],
    mutationID?: string,
  ): Promise<MutationReceipt> {
    return this.mutateContent({ op: "writeProperties", ref, basePropertiesRevision, properties }, mutationID);
  }

  claimProfile(input: { origin: string; handle: string; path: string; displayName?: string }): Promise<MutationReceipt> {
    return this.request("/v1/bootstrap/claims", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }

  createCommunityPairing(): Promise<CommunityPairingOffer> {
    return this.request("/v1/bootstrap/pairings", { method: "POST" });
  }

  forgetLocalAccount(): Promise<{ forgotten: true }> {
    return this.request("/v1/local/forget", { method: "POST" });
  }

  resolveConflict(tree: string, choice: "local" | "draft" | "remote"): Promise<MutationEffect[]> {
    return this.request(`/v1/conflicts/${encodeURIComponent(tree)}/resolve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choice }),
    });
  }

  async openNodeView(ref: NodeRef, signal?: AbortSignal): Promise<ObservedNodeView> {
    const snapshot = await this.nodeSnapshot(ref);
    const observedRef = snapshot.ref;
    const controller = new AbortController();
    const updates = new AsyncBuffer<ObservedNodeUpdate>();
    const close = () => {
      controller.abort();
      updates.finish();
    };
    if (signal?.aborted) close();
    else signal?.addEventListener("abort", close, { once: true });
    void this.pumpNodeView(observedRef, snapshot.observedThrough, updates, controller.signal);
    try {
      return { snapshot, updates, close };
    } catch (error) {
      close();
      throw error;
    }
  }

  private nodeSnapshot(ref: NodeRef): Promise<NodeResponse> {
    return this.request<NodeResponse>(`/v1/node?${refQuery(ref)}`);
  }

  children(ref: NodeRef, cursor?: string | null): Promise<ChildrenPage> {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    return this.request(`/v1/children?${refQuery(ref)}${suffix}`);
  }

  async allChildren(ref: NodeRef): Promise<ChildrenPage["items"]> {
    const result: ChildrenPage["items"] = [];
    let cursor: string | null = null;
    do {
      const page = await this.children(ref, cursor);
      result.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return result;
  }

  search(tree: TreeRef, query: string, cursor?: string | null): Promise<SearchPage> {
    return this.request(`/v1/search?tree=${encodeURIComponent(tree)}&q=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  }

  recovery(ref: NodeRef, options: { recursive?: boolean; cursor?: string | null } = {}): Promise<RecoveryPage> {
    const query = new URLSearchParams(refQuery(ref));
    if (options.recursive) query.set("recursive", "true");
    if (options.cursor) query.set("cursor", options.cursor);
    return this.request(`/v1/recovery?${query}`);
  }

  backlinks(ref: NodeRef, cursor?: string | null): Promise<BacklinksPage> {
    const query = new URLSearchParams(refQuery(ref));
    if (cursor) query.set("cursor", cursor);
    return this.request(`/v1/backlinks?${query}`);
  }

  async mutate(request: MutationRequest): Promise<MutationReceipt> {
    this.assertMutationDomain(request);
    this.rememberAuthored(request.mutationID);
    return this.retryMutation(
      request,
      () => this.request("/v1/mutations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
      }),
    );
  }

  isOwnMutation(mutationID: string): boolean {
    return this.authoredMutationSet.has(mutationID);
  }

  mutateContent(operation: ContentWorkspaceOperation, mutationID?: string): Promise<MutationReceipt> {
    return this.mutate(this.prepareContentMutation(operation, mutationID));
  }

  mutateStructural(operations: StructuralWorkspaceOperation[], mutationID?: string): Promise<MutationReceipt> {
    return this.mutate(this.prepareStructuralMutation(operations, mutationID));
  }


  /** Ensure the referenced document has an `id` identity property. */
  async ensureDocumentIdentity(
    ref: NodeRef,
    baseContentRevision: ContentRevision,
  ): Promise<{ pageID: PageID; contentRevision: ContentRevision }> {
    const receipt = await this.mutateContent({ op: "ensureDocumentIdentity", ref, baseContentRevision });
    const effect = receipt.effects[0];
    if (!effect?.pageID || !effect.contentRevision) {
      throw new TypeError("ensureDocumentIdentity receipt is missing the resulting identity");
    }
    return { pageID: effect.pageID, contentRevision: effect.contentRevision };
  }

  move(refs: NodeRef[], destination: NodeRef, mutationID?: string): Promise<MutationReceipt> {
    return this.mutateStructural([{ op: "move", refs, destination }], mutationID);
  }

  async asset(
    directory: NodeRef,
    file: File,
    mutationID = this.createMutationID(),
  ): Promise<{ receipt: MutationReceipt; path: string; markdownPath: string }> {
    const form = new FormData();
    const metadata = { mutationID, directory, filename: file.name };
    form.set("metadata", JSON.stringify(metadata));
    form.set("file", file, file.name);
    this.rememberAuthored(mutationID);
    return this.retryMutation(
      { endpoint: "/v1/assets", mutationID, metadata },
      () => this.request("/v1/assets", { method: "POST", body: form }),
    );
  }

  async import(
    destination: NodeRef,
    entries: Array<{ path: string; kind: "file" | "directory"; file?: File }>,
    mutationID = this.createMutationID(),
  ): Promise<MutationReceipt> {
    const form = new FormData();
    const manifest = entries.map((entry, index) => {
      if (entry.kind === "directory") return { path: entry.path, kind: entry.kind };
      if (!entry.file) throw new Error(`Missing imported file: ${entry.path}`);
      const field = `file-${index}`;
      form.set(field, entry.file, entry.file.name);
      return { path: entry.path, kind: entry.kind, field };
    });
    const metadata = { mutationID, destination, entries: manifest };
    form.set("metadata", JSON.stringify(metadata));
    this.rememberAuthored(mutationID);
    return this.retryMutation(
      { endpoint: "/v1/imports", mutationID, metadata },
      () => this.request("/v1/imports", { method: "POST", body: form }),
    );
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
        let buffer = "";
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = this.parseEvent(frame);
            if (event) {
              cursor = event.cursor;
              yield event;
            }
            boundary = buffer.indexOf("\n\n");
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

  private async pumpNodeView(
    ref: NodeRef,
    initialCursor: string,
    updates: AsyncBuffer<ObservedNodeUpdate>,
    signal: AbortSignal,
  ): Promise<void> {
    let cursor = initialCursor;
    while (!signal.aborted) {
      try {
        for await (const event of this.observe(cursor, signal)) {
          cursor = event.cursor;
          updates.push({ kind: "event", event });
        }
        if (!signal.aborted) updates.finish();
        return;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ArborSyncError && error.value.error === "resync-required") {
          try {
            const snapshot = await this.node(ref);
            cursor = snapshot.observedThrough;
            updates.push({ kind: "resync", snapshot });
            continue;
          } catch (reloadError) {
            updates.finish(reloadError);
            return;
          }
        }
        updates.finish(error);
        return;
      }
    }
  }

  private assertMutationDomain(request: MutationRequest): void {
    if (!request.mutationID || request.operations.length === 0) {
      throw new TypeError("A mutation requires a non-empty mutation ID and operations array");
    }
    const contentCount = request.operations.filter((operation) =>
      operation.op === "writeProperties" || operation.op === "writeMarkdown" || operation.op === "writeText" || operation.op === "restoreRecovery"
      || operation.op === "ensureDocumentIdentity"
    ).length;
    if (contentCount > 0 && (contentCount !== 1 || request.operations.length !== 1)) {
      throw new TypeError("A content mutation contains exactly one operation and cannot be mixed with structural operations");
    }
  }

  private parseEvent(frame: string): WorkspaceEvent | null {
    const lines = frame.split("\n");
    if (lines.every((line) => !line || line.startsWith(":"))) return null;
    const id = lines.find((line) => line.startsWith("id:"))?.slice(3).trimStart();
    const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trimStart();
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
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
    if (typeof event.change.path !== "string" || typeof event.change.origin !== "string") {
      throw new TypeError("Malformed Arbor workspace change");
    }
    return event;
  }

  private rememberAuthored(mutationID: string): void {
    if (this.authoredMutationSet.has(mutationID)) return;
    this.authoredMutationSet.add(mutationID);
    this.authoredMutationIDs.push(mutationID);
    if (this.authoredMutationIDs.length > 1_024) {
      this.authoredMutationSet.delete(this.authoredMutationIDs.shift()!);
    }
  }

  private async retryMutation<T>(
    prepared: PreparedArborSyncRequest,
    send: () => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await send();
      } catch (error) {
        if (error instanceof ArborSyncError && error.status !== 500) throw error;
        lastError = error;
        if (attempt < 2) await this.retryDelay(attempt + 1);
      }
    }
    throw new ArborSyncTransportError("The mutation outcome is ambiguous after transport retries", prepared, {
      cause: lastError,
    });
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
    let envelope: ArborSyncErrorEnvelope;
    try { envelope = await response.json() as ArborSyncErrorEnvelope; }
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
