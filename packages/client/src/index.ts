import type {
  ArbordErrorEnvelope,
  ArbordErrorValue,
  ChildrenPage,
  CollectionResultPage,
  ContentMutationRequest,
  ContentRevision,
  ContentWorkspaceOperation,
  DirectoryRevision,
  LogicalPath,
  MutationReceipt,
  MutationRequest,
  NodeRef,
  NodeSnapshot,
  PageID,
  RecoveryPage,
  SearchPage,
  StructuralMutationRequest,
  StructuralWorkspaceOperation,
  TreeChild,
  WorkspaceEvent,
} from "@arbor/core";
import type { ProjectedDocument } from "@arbor/core";
// Value imports come from the browser-safe deep module; the core index also
// re-exports Node-only path helpers that must stay out of browser bundles.
import { isSyntheticRowBlockID, projectDirectoryDocument } from "@arbor/core/projection";

export type {
  ArborBlock,
  ArbordErrorCode,
  ArbordErrorEnvelope,
  ArbordErrorValue,
  ChildrenPage,
  CollectionResultPage,
  ContentMutationRequest,
  ContentRevision,
  ContentWorkspaceOperation,
  DirectoryRevision,
  EventCursor,
  MutationEffect,
  MutationReceipt,
  MutationRequest,
  ManagedChildRow,
  NodeRef,
  NodeSnapshot,
  PageID,
  ProjectedDocument,
  RecoveryPage,
  SearchPage,
  StructuralMutationRequest,
  StructuralWorkspaceOperation,
  TreeChild,
  WorkspaceEvent,
  WorkspaceOperation,
} from "@arbor/core";

export class ArbordError extends Error {
  readonly payload: { error: ArbordErrorValue; current?: NodeSnapshot };
  constructor(
    public status: number,
    public value: ArbordErrorValue,
  ) {
    super(value.message);
    this.name = "ArbordError";
    this.payload = { error: value, current: value.current };
  }
}

export class ArbordTransportError extends Error {
  constructor(message: string, public request: PreparedArbordRequest, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArbordTransportError";
  }
}

export interface PreparedTransferRequest {
  endpoint: "/v1/assets" | "/v1/imports";
  mutationID: string;
  metadata: unknown;
}

export type PreparedArbordRequest = MutationRequest | PreparedTransferRequest;

export interface ArbordClientOptions {
  baseURL?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  mutationID?: () => string;
  retryDelay?: (attempt: number) => Promise<void>;
}

export type ObservedNodeUpdate =
  | { kind: "event"; event: WorkspaceEvent }
  | { kind: "resync"; snapshot: NodeSnapshot };

export interface ObservedNodeView {
  snapshot: NodeSnapshot;
  updates: AsyncIterable<ObservedNodeUpdate>;
  close(): void;
}

export type ProjectedNodeUpdate =
  | { kind: "event"; event: WorkspaceEvent }
  | { kind: "resync"; snapshot: NodeSnapshot; projection: ProjectedDocument | null };

export interface ProjectedNodeView {
  /** The hydrated raw snapshot. `document` never contains synthetic rows. */
  snapshot: NodeSnapshot;
  /** The derived directory projection; null for non-directory nodes. */
  projection: ProjectedDocument | null;
  updates: AsyncIterable<ProjectedNodeUpdate>;
  close(): void;
}

/**
 * Derive the projected directory document from a hydrated snapshot. Returns
 * null for nodes without a child-bearing surface. Never mutates the snapshot.
 */
export function projectSnapshot(snapshot: NodeSnapshot): ProjectedDocument | null {
  if (snapshot.kind !== "directory" && snapshot.kind !== "collection") return null;
  return projectDirectoryDocument({
    path: snapshot.path,
    document: snapshot.bodyState === "implicit" ? null : snapshot.document ?? null,
    children: snapshot.children ?? [],
  });
}

/** A pageID-bearing reference to a listed child, preferring durable identity. */
export function childRef(child: TreeChild): NodeRef {
  return child.pageID ? { pageID: child.pageID, pathHint: child.path } : { path: child.path };
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
  if ("path" in ref) query.set("path", ref.path);
  else {
    query.set("pageID", ref.pageID);
    if (ref.pathHint !== undefined) query.set("pathHint", ref.pathHint);
  }
  return query.toString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ArbordClient {
  private baseURL: string;
  private fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private createMutationID: () => string;
  private retryDelay: (attempt: number) => Promise<void>;
  private authoredMutationIDs: string[] = [];
  private authoredMutationSet = new Set<string>();

  constructor(options: ArbordClientOptions = {}) {
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

  async node(ref: NodeRef): Promise<NodeSnapshot> {
    return this.hydrateNode(await this.nodeSnapshot(ref));
  }

  /**
   * Open a node with its derived directory projection. The raw view's
   * snapshot/event handoff is preserved: observation starts at the initial
   * snapshot's cursor before children are drained, so child changes during
   * hydration surface as buffered events after the initial projection.
   * Resync updates arrive re-hydrated and re-projected.
   */
  async openProjectedNodeView(ref: NodeRef, signal?: AbortSignal): Promise<ProjectedNodeView> {
    const view = await this.openNodeView(ref, signal);
    const updates = async function* (): AsyncGenerator<ProjectedNodeUpdate> {
      for await (const update of view.updates) {
        if (update.kind === "resync") {
          yield { kind: "resync", snapshot: update.snapshot, projection: projectSnapshot(update.snapshot) };
        } else yield update;
      }
    }();
    return {
      snapshot: view.snapshot,
      projection: projectSnapshot(view.snapshot),
      updates,
      close: view.close,
    };
  }

  async openNodeView(ref: NodeRef, signal?: AbortSignal): Promise<ObservedNodeView> {
    const snapshot = await this.nodeSnapshot(ref);
    const observedRef: NodeRef = snapshot.ref.pageID
      ? { pageID: snapshot.ref.pageID, pathHint: snapshot.path }
      : { path: snapshot.path };
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
      return { snapshot: await this.hydrateNode(snapshot), updates, close };
    } catch (error) {
      close();
      throw error;
    }
  }

  private nodeSnapshot(ref: NodeRef): Promise<NodeSnapshot> {
    return this.request<NodeSnapshot>(`/v1/node?${refQuery(ref)}`);
  }

  private async hydrateNode(snapshot: NodeSnapshot): Promise<NodeSnapshot> {
    if (snapshot.kind === "directory" || snapshot.kind === "collection") {
      snapshot.children = await this.allChildren(snapshot.ref);
    }
    return snapshot;
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

  search(query: string, cursor?: string | null): Promise<SearchPage> {
    return this.request(`/v1/search?q=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  }

  collection(ref: NodeRef, cursor?: string | null, table?: string): Promise<CollectionResultPage> {
    const query = new URLSearchParams(refQuery(ref));
    if (cursor) query.set("cursor", cursor);
    if (table) query.set("table", table);
    return this.request(`/v1/collection?${query}`);
  }

  recovery(ref: NodeRef): Promise<RecoveryPage> {
    return this.request(`/v1/recovery?${refQuery(ref)}`);
  }

  async mutate(request: MutationRequest): Promise<MutationReceipt> {
    this.assertMutationDomain(request);
    this.assertNoSyntheticRowIDs(request);
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

  /**
   * Ensure the referenced document carries a durable PageID, materializing a
   * frontmatter-only `_index.md` for an implicit directory when necessary.
   */
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

  /** A move that lets the node appear naturally, materializing no stored destination row. */
  moveNatural(refs: NodeRef[], destination: NodeRef, mutationID?: string): Promise<MutationReceipt> {
    return this.mutateStructural([{ op: "move", refs, destination, placement: "natural" }], mutationID);
  }

  /** A move that places a stored row in the destination directory document. */
  moveAuthored(
    refs: NodeRef[],
    destination: NodeRef,
    anchor?: { beforePath?: LogicalPath; beforeBlockID?: string; baseDirectoryRevision: DirectoryRevision },
    mutationID?: string,
  ): Promise<MutationReceipt> {
    return this.mutateStructural([{
      op: "move",
      refs,
      destination,
      placement: "authored",
      beforePath: anchor?.beforePath,
      beforeBlockID: anchor?.beforeBlockID,
      baseDirectoryRevision: anchor?.baseDirectoryRevision,
    }], mutationID);
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
        if (error instanceof ArbordError) throw error;
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
        if (error instanceof ArbordError && error.value.code === "resync-required") {
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
      operation.op === "writeMarkdown" || operation.op === "restoreRecovery"
      || operation.op === "ensureDocumentIdentity"
    ).length;
    if (contentCount > 0 && (contentCount !== 1 || request.operations.length !== 1)) {
      throw new TypeError("A content mutation contains exactly one operation and cannot be mixed with structural operations");
    }
  }

  /**
   * Synthetic managed-row IDs (`managed:` prefix) are an editor-only
   * projection artifact and must never cross the wire — neither as anchors
   * nor inside persisted blocks. Anchor on the child's `beforePath` instead.
   */
  private assertNoSyntheticRowIDs(request: MutationRequest): void {
    const blocksContainSynthetic = (blocks: readonly { id: string; children: readonly unknown[] }[]): boolean =>
      blocks.some((block) => isSyntheticRowBlockID(block.id)
        || blocksContainSynthetic(block.children as { id: string; children: readonly unknown[] }[]));
    for (const operation of request.operations) {
      if (operation.op === "move" && operation.beforeBlockID && isSyntheticRowBlockID(operation.beforeBlockID)) {
        throw new TypeError("A synthetic managed-row ID cannot anchor a move; use the child's beforePath");
      }
      if ("blocks" in operation && operation.blocks && blocksContainSynthetic(operation.blocks)) {
        throw new TypeError("Synthetic managed rows are projection artifacts and cannot be persisted");
      }
    }
  }

  private parseEvent(frame: string): WorkspaceEvent | null {
    const lines = frame.split("\n");
    if (lines.every((line) => !line || line.startsWith(":"))) return null;
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return null;
    return JSON.parse(data) as WorkspaceEvent;
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
    prepared: PreparedArbordRequest,
    send: () => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await send();
      } catch (error) {
        if (error instanceof ArbordError && error.status !== 500) throw error;
        lastError = error;
        if (attempt < 2) await this.retryDelay(attempt + 1);
      }
    }
    throw new ArbordTransportError("The mutation outcome is ambiguous after transport retries", prepared, {
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
    let envelope: ArbordErrorEnvelope;
    try { envelope = await response.json() as ArbordErrorEnvelope; }
    catch {
      envelope = { error: { code: "internal-error", message: response.statusText, retryable: false } };
    }
    throw new ArbordError(response.status, envelope.error);
  }
}
