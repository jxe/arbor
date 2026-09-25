import { canonicalCBORHash } from "./cbor.ts";
import { arrangeSources } from "../updates/source-moves.ts";
import type { JSONValue, NodeRef, NodeSnapshot } from "./node-model.ts";
import type { ContentRevision, DirectoryRevision, EventCursor, Hash, LogicalPath, TreeID, TreeRef } from "./identifiers.ts";



export interface QueryHandleRef {
  tree: TreeID;
  module: LogicalPath;
  export: string;
  version: string;
}

export type MutationHandleRef = QueryHandleRef;

export interface QueryStreamDocumentRef {
  tree: TreeID;
  path: LogicalPath;
  version: string;
}

export interface QueryStreamMount {
  id: string;
  handle: QueryHandleRef;
  input?: unknown;
  knownOutputHash?: Hash;
}

export interface QueryStreamRequest {
  document: QueryStreamDocumentRef;
  queries: QueryStreamMount[];
}

export type QueryStreamEvent =
  | { type: "result"; id: string; observedThrough: EventCursor; outputHash: Hash; value: unknown }
  | { type: "result"; id: string; observedThrough: EventCursor; error: { code: string; message: string; retryable: boolean } }
  | { type: "ready"; queries: Array<{ id: string; observedThrough: EventCursor; outputHash?: Hash }> }
  | { type: "reload"; reason: "source-changed" | "access-changed" };

/** Server-side adapter shared by Local REST and tree-scoped Overstory protocol queries. */
export interface QueryStreamRuntime {
  stream(
    request: QueryStreamRequest,
    context: { signal: AbortSignal; user: { profile: string } | null },
  ): ReadableStream<QueryStreamEvent> | Promise<ReadableStream<QueryStreamEvent>>;
}

export interface MutationCallRequest {
  document: QueryStreamDocumentRef;
  handle: MutationHandleRef;
  mutationID: string;
  input: unknown;
}

export interface MutationResultReceipt<Result = unknown> {
  mutationID: string;
  requestDigest: Hash;
  observedThrough: EventCursor;
  result: Result;
}

/** Transport-neutral callable boundary; React/HTTP adaptation is owned later. */
export interface MutationCallRuntime {
  call(
    request: MutationCallRequest,
    context: { user: { profile: string } | null },
  ): Promise<MutationResultReceipt>;
}

/**
 * The tree dimension of a reference: which scope it resolves in.
 * Values are `"local"` (the degenerate filesystem scope; paths are
 * OS-absolute), `"system"` (the control scope), or a stable shared
 * `TreeID`. The scope is always explicit; there is no omitted-tree default.
 */
export type AccessLevel = "none" | "read" | "write";
export type ReadWriteAccess = Exclude<AccessLevel, "none">;
export type TreeKind = "ordinary" | "account-configuration";

export type AccessSubject =
  | { kind: "everyone" }
  | { kind: "profile"; tree: TreeID }
  | { kind: "link"; digest: Hash };

export interface AccessRule {
  subject: AccessSubject;
  access: ReadWriteAccess;
}

export type SafeAccessSubject =
  | { kind: "everyone" }
  | { kind: "profile"; tree: TreeID; locator?: string }
  | { kind: "link" };

export interface AccessEntry {
  id: string;
  subject: SafeAccessSubject;
  access: ReadWriteAccess;
}


export interface TreeDescriptor {
  id: TreeID;
  kind: TreeKind;
  access: AccessLevel;
  canonical: {
    path: LogicalPath;
    endpoint: string;
    parentTree: TreeID | null;
  } | null;
}

export type CanonicalTreeDescriptor = NonNullable<TreeDescriptor["canonical"]>;

/** Percent-encode a decoded canonical path segment by segment; the root encodes as `""`. */
function encodedCanonicalPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.length ? `/${segments.map(encodeURIComponent).join("/")}` : "";
}

/** The public HTTP URL of a canonical tree: the endpoint's origin followed by its encoded path. */
export function canonicalHTTPURL(canonical: Pick<CanonicalTreeDescriptor, "path" | "endpoint">): string {
  return `${new URL(canonical.endpoint).origin}${encodedCanonicalPath(canonical.path) || "/"}`;
}

/** The `arbor://` locator of a canonical tree: the endpoint's host followed by its encoded path. */
export function canonicalArborLocator(canonical: Pick<CanonicalTreeDescriptor, "path" | "endpoint">): string {
  return `arbor://${new URL(canonical.endpoint).host}${encodedCanonicalPath(canonical.path) || "/"}`;
}

/**
 * A Canopy tree as the authority currently holds it. `root` and `update`
 * name one accepted state; the same two fields on a local descriptor name
 * the accepted base a placement derives from.
 */
export interface RemoteTreeDescriptor extends TreeDescriptor {
  /** Accepted alternatives remain unresolved; this signal is required. */
  conflicted: boolean;
  /** The bytes hash of the current accepted tree state: the wire root. */
  root: Hash;
  update: string;
}

/**
 * A tree as Arbor Sync holds it: the protocol descriptor plus what only a local
 * daemon knows (placement on disk, display name, synchronization state).
 * `root` and `update` are the accepted Canopy base this placement derives
 * from and are absent until the first accepted state is installed.
 */
export interface LocalTreeDescriptor extends TreeDescriptor {
  /** Accepted unresolved state; independent of rejected-edit sync status. */
  conflicted?: boolean;
  /** Account routing identity for hosted and configuration trees. */
  configurationTree?: TreeID;
  root?: Hash;
  update?: string;
  name: string;
  osPath?: string;
  placement: "placed" | "replica" | "remote";
  /** `conflict`: the host refused the folder's changes; they are held until discarded.
   * `paused`: a person paused publishing the folder's changes; accepted updates still arrive. */
  sync?: "idle" | "syncing" | "offline" | "conflict" | "error" | "paused";
  missing?: boolean;
}

/** A one-time device pairing offer; identical on the protocol and through Arbor Sync. */
export interface PairingOffer {
  id: string;
  secret: string;
  confirmationCode: string;
  expiresAt: number;
}

/** One claimed Canopy account of a data home, safe to present: no credential material. */
export interface LocalAccountSummary {
  configurationTree: TreeID;
  /** The Canopy origin from `account.yaml`; null when the configuration is unreadable. */
  canopy: string | null;
  handle: string | null;
  profileTree: TreeID | null;
  deviceID: string | null;
  credentialAvailable: boolean;
  diagnostics: Array<{ code: string; message: string; path: string; severity: string }>;
}

/** The local self-certifying person identity, as stored and as Arbor Sync reports it. */
export interface ProfileIdentity {
  version: 1;
  profileTree: TreeID;
  publicKey: string;
  profilePath: string;
  credential: string;
  keyAvailable: boolean;
}

/** Deployment/placement context carried by local and Canopy node responses. */
export interface NodeResponse extends NodeSnapshot {
  enclosingTree?: LocalTreeDescriptor;
  /** Opaque local admission context returned unchanged by an editor save. */
  admissionBasis?: string;
  /** Credential-scoped protocol request digest for this locally durable editor admission. */
  admissionRequestDigest?: Hash;
  /** Authenticated protocol requests known to be incorporated by this observation. */
  acceptedRequestDigests?: Hash[];
}

export interface BacklinkEntry {
  ref: NodeRef;
  title: string;
  context: string;
}

export interface LocatorResolution {
  ref: NodeRef;
  enclosingTree?: TreeDescriptor;
  historical: boolean;
  observedThrough: EventCursor;
}

export interface SnapshotEnvelope<T> {
  snapshot: T;
  observedThrough: EventCursor;
}

/** One simultaneous UTF-8 byte replacement against an exact source revision. */
export interface SourceEdit {
  /** Verified preserved spans; source offsets are absolute, replacement offsets relative. */
  lineage?: Array<{source: [number, number]; replacement: [number, number]}>;
  copies?: Array<{source: [number, number]; replacement: [number, number]; document?: {path: string; source: string}}>;
  offset: number;
  length: number;
  replacement: string;
  expected?: string;
}

/** Relocation of non-empty source bytes beside `anchor`: stationary bytes, or
 * the whole source of an earlier move. Offsets are UTF-8 bytes of the same
 * source the edits address; `arrangeSources` gives the exact meaning. */
export interface SourceMove {
  source: [number, number];
  anchor: [number, number];
  side: "before" | "after";
}

export class SourceEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceEditError";
  }
}

/** Apply guarded, ordered source edits without ever indexing JavaScript UTF-16. */
export function applySourceEdits(source: string, edits: readonly SourceEdit[]): string {
  const original = new TextEncoder().encode(source);
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  let size = 0;
  for (const [index, edit] of edits.entries()) {
    if (
      !Number.isSafeInteger(edit.offset)
      || !Number.isSafeInteger(edit.length)
      || edit.offset < cursor
      || edit.length < 0
      || edit.offset > original.length
      || edit.length > original.length - edit.offset
    ) {
      throw new SourceEditError(`sourceEdits[${index}] has an invalid or overlapping UTF-8 range`);
    }
    const unchanged = original.subarray(cursor, edit.offset);
    chunks.push(unchanged);
    size += unchanged.length;
    const replaced = original.subarray(edit.offset, edit.offset + edit.length);
    if (edit.expected !== undefined) {
      const expected = new TextEncoder().encode(edit.expected);
      if (expected.length !== replaced.length || expected.some((byte, offset) => byte !== replaced[offset])) {
        throw new SourceEditError(`sourceEdits[${index}] expected bytes do not match the current source`);
      }
    }
    const replacement = new TextEncoder().encode(edit.replacement);
    let outputEnd = 0;
    const preserved: Array<[number, number]> = [];
    for (const part of edit.lineage ?? []) {
      const [start,end] = part.source, [from,to] = part.replacement;
      if (![start,end,from,to].every(Number.isSafeInteger) || start < edit.offset || end < start || end > edit.offset+edit.length ||
          from < outputEnd || to < from || to > replacement.length || end-start !== to-from ||
          preserved.some(([a,b]) => start < b && a < end) ||
          [start,end].some(n => n < original.length && (original[n]! & 0xc0) === 0x80) ||
          [from,to].some(n => n < replacement.length && (replacement[n]! & 0xc0) === 0x80) ||
          original.subarray(start,end).some((byte,i) => byte !== replacement[from+i])) throw new SourceEditError("Invalid preservation lineage");
      try { new TextDecoder("utf-8",{fatal:true}).decode(original.subarray(start,end)); }
      catch { throw new SourceEditError("Preservation lineage splits UTF-8"); }
      preserved.push([start,end]); outputEnd=to;
    }
    let copiedEnd=0;
    for(const part of edit.copies ?? []) {
      const copiedSource = part.document ? new TextEncoder().encode(part.document.source) : original;
      const [start,end]=part.source,[from,to]=part.replacement;
      if(![start,end,from,to].every(Number.isSafeInteger)||start<0||end<=start||end>copiedSource.length||from<copiedEnd||to>replacement.length||end-start!==to-from||
         (edit.lineage??[]).some(p=>from<p.replacement[1]&&p.replacement[0]<to)||
         [start,end].some(n=>n<copiedSource.length&&(copiedSource[n]!&0xc0)===0x80)||
         [from,to].some(n=>n<replacement.length&&(replacement[n]!&0xc0)===0x80)||
         copiedSource.subarray(start,end).some((byte,i)=>byte!==replacement[from+i]))throw new SourceEditError("Invalid explicit source copy");
      copiedEnd=to;
    }
    chunks.push(replacement);
    size += replacement.length;
    cursor = edit.offset + edit.length;
  }
  const tail = original.subarray(cursor);
  chunks.push(tail);
  size += tail.length;
  const result = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result);
  } catch {
    throw new SourceEditError("sourceEdits produce invalid UTF-8");
  }
}

/** Apply one generation: its moves, then its edits, all in `source`'s own
 * coordinates. Without moves this is `applySourceEdits`. */
export function applySourceChange(source: string, edits: readonly SourceEdit[], moves: readonly SourceMove[] = []): string {
  // Edits keep their own checks (order, guards, lineage) whatever moves do.
  const plain = applySourceEdits(source, edits);
  if (!moves.length) return plain;
  if (edits.some(edit => edit.copies?.length)) throw new SourceEditError("A generation with moves states no copies");
  const path = "/source", encoder = new TextEncoder();
  try {
    const arranged = arrangeSources(
      new Map([[path, encoder.encode(source)]]),
      moves.map(move => ({ source: { path, range: move.source }, anchor: { path, range: move.anchor }, side: move.side })),
      edits.map(edit => ({ path, range: [edit.offset, edit.offset + edit.length] as [number, number], text: encoder.encode(edit.replacement) })),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(arranged.get(path)!);
  } catch (error) {
    throw new SourceEditError(error instanceof Error ? error.message : "Invalid source moves");
  }
}

export type ContentWorkspaceOperation =
  | {
    op: "writeProperties";
    ref: NodeRef;
    basePropertiesRevision: string;
    /** Complete candidate property map; omitted keys are deletions. */
    properties: Record<string, JSONValue>;
  }
  | {
    op: "writeText";
    ref: NodeRef;
    baseContentRevision: ContentRevision;
    source: string;
  }
  | {
    op: "writeMarkdown";
    ref: NodeRef;
    baseContentRevision: ContentRevision;
    source: string;
    /** Optional editor provenance; the complete `source` remains authoritative. */
    sourceEdits?: SourceEdit[];
  }
  | {
    op: "ensureDocumentIdentity";
    ref: NodeRef;
    baseContentRevision: ContentRevision;
  };

export type StructuralWorkspaceOperation =
  | { op: "createDirectory"; tree: TreeRef; path: LogicalPath }
  | { op: "createMarkdown"; tree: TreeRef; path: LogicalPath; source?: string }
  | { op: "rename"; ref: NodeRef; name: string }
  | {
    op: "move";
    refs: NodeRef[];
    destination: NodeRef;
  }
  | { op: "copy"; refs: NodeRef[]; destination: NodeRef }
  | { op: "trash"; refs: NodeRef[] }
  | { op: "restore"; refs: NodeRef[] };

export type WorkspaceOperation = ContentWorkspaceOperation | StructuralWorkspaceOperation;

export interface ContentMutationRequest {
  mutationID: string;
  operations: [ContentWorkspaceOperation];
}

export interface StructuralMutationRequest {
  mutationID: string;
  operations: [StructuralWorkspaceOperation, ...StructuralWorkspaceOperation[]];
}

export type MutationRequest = ContentMutationRequest | StructuralMutationRequest;

export type MutationEffectKind = "created" | "updated" | "moved" | "deleted";

export interface MutationEffect {
  kind: MutationEffectKind;
  ref: NodeRef;
  previousPath?: LogicalPath;
  contentRevision?: ContentRevision;
  propertiesRevision?: string;
  /** Exact property names changed when the provider can prove them; omission widens invalidation. */
  changedProperties?: string[];
  directoryRevision?: DirectoryRevision;
}

export interface MutationReceipt {
  mutationID: string;
  observedThrough: EventCursor;
  effects: MutationEffect[];
}

export type WorkspaceEventOrigin = "api" | "external" | "recovery" | "sync";

export interface WorkspaceChange {
  ref: NodeRef;
  previousPath?: LogicalPath;
  contentRevision?: ContentRevision;
  propertiesRevision?: string;
  /** Exact property names changed when the provider can prove them; omission widens invalidation. */
  changedProperties?: string[];
  directoryRevision?: DirectoryRevision;
  origin: WorkspaceEventOrigin;
  mutationID?: string;
  /** Authenticated protocol requests incorporated by this materialized sync transition. */
  acceptedRequestDigests?: Hash[];
}

export type WorkspaceEvent = ObservationEvent<MutationEffectKind | "diagnostic", WorkspaceChange>;

export type OverstoryErrorCode =
  | "invalid-request"
  | "unauthenticated"
  | "permission-denied"
  | "conflict"
  | "not-found"
  | "read-only"
  | "unsupported-operation"
  | "resync-required"
  | "rate-limited"
  | "quota-exceeded"
  | "internal-error"
  | "already-claimed"
  | (string & {});

/** The single error envelope shared by the Overstory protocol and the local REST surface. */
export interface OverstoryError<TDetails = unknown> {
  error: OverstoryErrorCode;
  message: string;
  retryable: boolean;
  tree?: TreeRef;
  path?: LogicalPath;
  details?: TDetails;
}

export interface ObservationEvent<TKind extends string = string, TChange = unknown> {
  cursor: EventCursor;
  tree: TreeRef;
  kind: TKind;
  change: TChange;
}

/**
 * Deterministic JSON text for local equality comparison and private receipts.
 * It is not a wire identity: every hashed identity uses `canonicalCBORHash`.
 */
export function stableJSONString(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSONString).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJSONString(record[key])}`)
    .join(",")}}`;
}

/**
 * Hashes the canonical, semantic identity of a retryable request. Transport
 * details must be removed by the caller before constructing this value.
 */
export function semanticRequestDigest(identity: unknown): Hash {
  return canonicalCBORHash(identity);
}

/** A plain byte replacement over one source: what a lineage-free, copy-free
 * `SourceEdit` states and what an `editSource` operation carries. */
export interface PlainSourceEdit { offset: number; length: number; replacement: string }

/**
 * Composes generations of plain edits into one generation over the original
 * source. Generation `n` is stated over the source generation `n - 1`
 * produced; the result is stated over the source generation 0 started from and
 * produces exactly what the last generation produced. It needs no intermediate
 * bytes: the original is modelled as pieces that are either copied ranges of
 * it or inserted text, and each generation only splits, removes or interleaves
 * pieces. Copied pieces stay in original order, so the composed edits are
 * ascending, non-adjacent and never share an anchor.
 *
 * The same rule runs in `@overstory/working-tree` (`compactTrace`), in the Swift
 * queue and in Canopy's `composeFrames`, and `docs/overstory-spec/conformance/source-admission-queue.json`
 * holds the shared vectors. Only plain edits compose; lineage and copies name
 * the generation they were captured against and are never rebased here.
 */
export function composeSourceEdits(generations: ReadonlyArray<ReadonlyArray<PlainSourceEdit>>): PlainSourceEdit[] {
  type Piece = { copy: [number, number] } | { text: Uint8Array };
  const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const size = (piece: Piece) => "copy" in piece ? piece.copy[1] - piece.copy[0] : piece.text.length;
  // The original's tail is open-ended: no generation may reach past the real end.
  const OPEN = Number.MAX_SAFE_INTEGER;
  let pieces: Piece[] = [{ copy: [0, OPEN] }];
  for (const edits of generations) {
    let cursor = 0;
    for (const edit of edits) {
      if (!Number.isSafeInteger(edit.offset) || !Number.isSafeInteger(edit.length) || edit.offset < cursor || edit.length < 0) throw new SourceEditError("Composed source edits overlap or run backwards");
      cursor = edit.offset + edit.length;
    }
    // Split the pieces at every edit boundary so no piece straddles one.
    const boundaries = [...new Set(edits.flatMap((edit) => [edit.offset, edit.offset + edit.length]))].sort((a, b) => a - b);
    const split: Piece[] = [];
    let position = 0, next = 0;
    for (const piece of pieces) {
      let start = position, remaining = piece;
      while (next < boundaries.length && boundaries[next]! <= start) next++;
      while (next < boundaries.length && boundaries[next]! < start + size(remaining)) {
        const at = boundaries[next]! - start;
        if ("copy" in remaining) {
          split.push({ copy: [remaining.copy[0], remaining.copy[0] + at] });
          remaining = { copy: [remaining.copy[0] + at, remaining.copy[1]] };
        } else {
          split.push({ text: remaining.text.subarray(0, at) });
          remaining = { text: remaining.text.subarray(at) };
        }
        start += at; next++;
      }
      split.push(remaining);
      position += size(piece);
    }
    // Walk the split pieces, dropping what each edit replaces and inserting its text.
    const applied: Piece[] = [];
    let index = 0, skipUntil = 0;
    position = 0;
    const flush = () => {
      while (index < edits.length && edits[index]!.offset === position) {
        const edit = edits[index++]!;
        if (edit.replacement) applied.push({ text: encoder.encode(edit.replacement) });
        skipUntil = Math.max(skipUntil, edit.offset + edit.length);
      }
    };
    for (const piece of split) {
      flush();
      if (position >= skipUntil && size(piece) > 0) applied.push(piece);
      position += size(piece);
    }
    flush();
    if (index < edits.length) throw new SourceEditError("Composed source edit lies past the end of its source");
    pieces = applied;
  }
  // Read the pieces back as edits over the original: every gap between copied
  // ranges, together with the text inserted there, is one edit.
  const composed: PlainSourceEdit[] = [];
  let base = 0;
  const inserted: Uint8Array[] = [];
  const emit = (end: number) => {
    if (end > base || inserted.length) {
      const text = new Uint8Array(inserted.reduce((total, chunk) => total + chunk.length, 0));
      let at = 0;
      for (const chunk of inserted) { text.set(chunk, at); at += chunk.length; }
      composed.push({ offset: base, length: end - base, replacement: decoder.decode(text) });
      inserted.length = 0;
    }
  };
  for (const piece of pieces) {
    if ("text" in piece) { inserted.push(piece.text); continue; }
    emit(piece.copy[0]);
    base = piece.copy[1];
  }
  if (base !== OPEN) throw new SourceEditError("Composed source edits removed the open tail");
  return composed;
}
