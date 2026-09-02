import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import type {
  ArborErrorCode,
  ArborError,
  MutationRequest,
  NodeRef,
  QueryStreamRequest,
  QueryStreamRuntime,
  MutationCallRuntime,
} from "@arbor/core";
import { PathEscapeError, encodeSSEFrame, generateArborID } from "@arbor/core";
import { treeMutationResponse, treeQueryResponse } from "@arbor/data/host";
import { decodeNodeRef } from "@arbor/core/node-model";
import { FsConflictError, type FsImportEntry } from "@arbor/fs";
import { currentDeviceID } from "@arbor/stores";
import { ResyncRequiredError } from "./events.ts";
import { fsErrorCode } from "./fs-errors.ts";
import { ArborSyncDaemon } from "./service.ts";
import { ProtocolError, RevisionConflictError, type Workspace } from "./workspace.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".woff2": "font/woff2",
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function fileResponse(
  request: Request,
  surface: { bytes: Uint8Array; revision: string; path: string },
  options: { raw?: boolean; noStore?: boolean } = {},
): Response {
  const etag = `"${surface.revision}"`;
  const baseHeaders: Record<string, string> = {
    "content-type": MIME[extname(surface.path)]
      ?? (options.raw ? "text/markdown; charset=utf-8" : "application/octet-stream"),
    etag,
    "accept-ranges": "bytes",
    ...(options.noStore ? { "cache-control": "no-store" } : {}),
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }
  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const size = surface.bytes.byteLength;
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...baseHeaders, "content-range": `bytes */${size}` } });
    }
    return new Response(request.method === "HEAD" ? null : Buffer.from(surface.bytes.slice(start, end + 1)), {
      status: 206,
      headers: { ...baseHeaders, "content-range": `bytes ${start}-${end}/${size}` },
    });
  }
  return new Response(request.method === "HEAD" ? null : Buffer.from(surface.bytes), { headers: baseHeaders });
}

function errorResponse(
  code: ArborErrorCode,
  message: string,
  status: number,
  details: Partial<Omit<ArborError, "error" | "message">> = {},
): Response {
  const normalized = (() => {
    switch (code) {
      case "invalid-reference":
      case "unsafe-path":
      case "duplicate-body-representation": return "invalid-request";
      case "credential-unavailable": return "unauthenticated";
      case "not-materialized": return "not-found";
      case "reserved-boundary":
      case "duplicate-page-id":
      case "stale-content-revision":
      case "stale-properties-revision":
      case "stale-directory-revision":
      case "occupied-destination":
      case "mutation-mismatch": return "conflict";
      default: return code;
    }
  })();
  const { retryable = false, tree, path, details: typedDetails } = details;
  const normalizedDetails = normalized === "conflict" && normalized !== code
    ? { kind: "workspace-revision", reason: code, ...(typeof typedDetails === "object" && typedDetails !== null ? typedDetails : {}) }
    : typedDetails;
  return json({
    error: normalized,
    message,
    retryable,
    ...(tree ? { tree } : {}),
    ...(path ? { path } : {}),
    ...(normalizedDetails === undefined ? {} : { details: normalizedDetails }),
  } satisfies ArborError, status);
}

function assertSameOrigin(request: Request, url: URL): void {
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
    throw new ProtocolError("invalid-request", "Arbor Sync accepts only loopback Host headers", 400, { path: url.pathname });
  }
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    throw new ProtocolError("invalid-request", "Cross-origin workspace mutations are not allowed", 400, { path: url.pathname });
  }
}

function queryRef(url: URL): NodeRef {
  const path = url.searchParams.get("path");
  const tree = url.searchParams.get("tree");
  if (!tree) throw new ProtocolError("invalid-request", "An explicit tree scope is required", 400);
  if (path === null) throw new ProtocolError("invalid-reference", "A node reference requires path", 400);
  if (url.searchParams.has("pageID") || url.searchParams.has("pathHint")) {
    throw new ProtocolError("invalid-reference", "PageID and pathHint node references are no longer supported", 400);
  }
  try {
    return decodeNodeRef({ tree, path, stableKey: url.searchParams.get("stableKey") || null });
  } catch (error) {
    throw new ProtocolError("invalid-reference", error instanceof Error ? error.message : "Invalid node reference", 400);
  }
}

function decodeMutation(value: unknown): MutationRequest {
  if (!isRecord(value)) {
    throw new ProtocolError("invalid-reference", "Expected a mutation object", 400);
  }
  const input = value as Partial<MutationRequest>;
  if (
    typeof input.mutationID !== "string"
    || !input.mutationID
    || !Array.isArray(input.operations)
    || input.operations.length === 0
  ) {
    throw new ProtocolError("invalid-reference", "Expected a mutationID and a non-empty operations array", 400);
  }
  for (const operation of input.operations) {
    validateOperation(operation);
  }
  const contentCount = input.operations.filter((operation) =>
    operation.op === "writeProperties" || operation.op === "writeMarkdown" || operation.op === "writeText" || operation.op === "restoreRecovery"
    || operation.op === "ensureDocumentIdentity"
  ).length;
  if (contentCount > 0 && (contentCount !== 1 || input.operations.length !== 1)) {
    throw new ProtocolError(
      "unsupported-operation",
      "A content mutation contains exactly one operation and cannot be mixed with structural operations",
      422,
    );
  }
  return input as MutationRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateRef(value: unknown, field: string): asserts value is NodeRef {
  try {
    decodeNodeRef(value);
  } catch (error) {
    throw new ProtocolError(
      "invalid-reference",
      `${field}: ${error instanceof Error ? error.message : "invalid node reference"}`,
      400,
    );
  }
}


function validateRefs(value: unknown, field: string): asserts value is NodeRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProtocolError("invalid-reference", `${field} must be a non-empty reference array`, 400);
  }
  value.forEach((ref, index) => validateRef(ref, `${field}[${index}]`));
}

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new ProtocolError("invalid-reference", `${field} must be a string when supplied`, 400);
  }
}

function isJSONValue(value: unknown, depth = 0): boolean {
  if (depth > 100) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJSONValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => isJSONValue(item, depth + 1));
}

function validateSourceEdits(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100_000) {
    throw new ProtocolError("invalid-reference", "writeMarkdown.sourceEdits must be a non-empty bounded array", 400);
  }
  let priorEnd = 0;
  let replacementBytes = 0;
  for (const [index, edit] of value.entries()) {
    if (
      !isRecord(edit)
      || !Number.isSafeInteger(edit.offset)
      || !Number.isSafeInteger(edit.length)
      || (edit.offset as number) < priorEnd
      || (edit.length as number) < 0
      || typeof edit.replacement !== "string"
      || (edit.expected !== undefined && typeof edit.expected !== "string")
    ) {
      throw new ProtocolError("invalid-reference", `writeMarkdown.sourceEdits[${index}] is invalid or overlaps`, 400);
    }
    const end = (edit.offset as number) + (edit.length as number);
    if (!Number.isSafeInteger(end)) {
      throw new ProtocolError("invalid-reference", `writeMarkdown.sourceEdits[${index}] range overflows`, 400);
    }
    priorEnd = end;
    replacementBytes += new TextEncoder().encode(edit.replacement).length;
    if (!Number.isSafeInteger(replacementBytes) || replacementBytes > 64 * 1024 * 1024) {
      throw new ProtocolError("invalid-reference", "writeMarkdown.sourceEdits replacement bytes exceed the request quota", 400);
    }
  }
}

function validateOperation(value: unknown): void {
  if (!isRecord(value) || typeof value.op !== "string" || !value.op) {
    throw new ProtocolError("invalid-reference", "Every operation requires an op discriminator", 400);
  }
  switch (value.op) {
    case "writeProperties":
      validateRef(value.ref, "writeProperties.ref");
      if (typeof value.basePropertiesRevision !== "string" || !value.basePropertiesRevision || !isRecord(value.properties) || !isJSONValue(value.properties)) {
        throw new ProtocolError("invalid-request", "writeProperties requires basePropertiesRevision and a complete JSON property map", 400);
      }
      return;
    case "writeText":
      validateRef(value.ref, "writeText.ref");
      if (typeof value.baseContentRevision !== "string" || typeof value.source !== "string") {
        throw new ProtocolError("invalid-request", "writeText requires baseContentRevision and source", 400);
      }
      return;
    case "writeMarkdown":
      validateRef(value.ref, "writeMarkdown.ref");
      if (typeof value.baseContentRevision !== "string" || typeof value.source !== "string") {
        throw new ProtocolError("invalid-reference", "writeMarkdown requires baseContentRevision and source", 400);
      }
      if ("blocks" in value || "frontmatterPatch" in value) {
        throw new ProtocolError("invalid-reference", "writeMarkdown accepts exact source, not blocks or frontmatterPatch", 400);
      }
      validateSourceEdits(value.sourceEdits);
      return;
    case "createDirectory":
      if (typeof value.tree !== "string" || !value.tree || typeof value.path !== "string" || !value.path) {
        throw new ProtocolError("invalid-reference", "createDirectory requires path", 400);
      }
      return;
    case "createMarkdown":
      if (
        typeof value.tree !== "string"
        || !value.tree
        || typeof value.path !== "string"
        || !value.path
        || (value.source !== undefined && typeof value.source !== "string")
        || "blocks" in value
      ) {
        throw new ProtocolError("invalid-reference", "createMarkdown requires path and optional source", 400);
      }
      return;
    case "rename":
      validateRef(value.ref, "rename.ref");
      if (typeof value.name !== "string" || !value.name) {
        throw new ProtocolError("invalid-reference", "rename requires a non-empty name", 400);
      }
      return;
    case "move":
      validateRefs(value.refs, "move.refs");
      validateRef(value.destination, "move.destination");
      if ("placement" in value || "beforePath" in value || "beforeBlockID" in value || "baseDirectoryRevision" in value) {
        throw new ProtocolError("invalid-reference", "move ordering is authored by a separate Markdown source write", 400);
      }
      return;
    case "copy":
      validateRefs(value.refs, "copy.refs");
      validateRef(value.destination, "copy.destination");
      return;
    case "trash":
    case "restore":
      validateRefs(value.refs, `${value.op}.refs`);
      return;
    case "restoreRecovery":
      validateRef(value.ref, "restoreRecovery.ref");
      if (typeof value.hash !== "string" || !value.hash) {
        throw new ProtocolError("invalid-reference", "restoreRecovery requires a recovery hash", 400);
      }
      optionalString(value.baseContentRevision, "restoreRecovery.baseContentRevision");
      return;
    case "ensureDocumentIdentity":
      validateRef(value.ref, "ensureDocumentIdentity.ref");
      if (typeof value.baseContentRevision !== "string") {
        throw new ProtocolError("invalid-reference", "ensureDocumentIdentity requires baseContentRevision", 400);
      }
      return;
    default:
      throw new ProtocolError("unsupported-operation", `Unsupported operation: ${value.op}`, 422);
  }
}

async function decodeAsset(request: Request): Promise<{
  mutationID: string;
  directory: NodeRef;
  filename: string;
  bytes: Uint8Array;
}> {
  const form = await request.formData();
  const rawMetadata = form.get("metadata");
  const file = form.get("file");
  if (typeof rawMetadata !== "string" || !(file instanceof File)) {
    throw new ProtocolError("invalid-reference", "Asset metadata and file are required", 400);
  }
  let metadata: { mutationID?: unknown; directory?: unknown; filename?: unknown };
  try { metadata = JSON.parse(rawMetadata) as typeof metadata; }
  catch { throw new ProtocolError("invalid-reference", "Asset metadata is not valid JSON", 400); }
  if (
    typeof metadata.mutationID !== "string"
    || !metadata.mutationID
    || !metadata.directory
    || typeof metadata.directory !== "object"
  ) throw new ProtocolError("invalid-reference", "Asset metadata is incomplete", 400);
  validateRef(metadata.directory, "asset.directory");
  return {
    mutationID: metadata.mutationID,
    directory: metadata.directory as NodeRef,
    filename: typeof metadata.filename === "string" && metadata.filename ? metadata.filename : file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

async function decodeImport(request: Request): Promise<{
  mutationID: string;
  destination: NodeRef;
  entries: FsImportEntry[];
}> {
  const form = await request.formData();
  const rawMetadata = form.get("metadata");
  if (typeof rawMetadata !== "string") {
    throw new ProtocolError("invalid-reference", "Import metadata is required", 400);
  }
  let metadata: {
    mutationID?: unknown;
    destination?: unknown;
    entries?: Array<{ path?: unknown; kind?: unknown; field?: unknown }>;
  };
  try { metadata = JSON.parse(rawMetadata) as typeof metadata; }
  catch { throw new ProtocolError("invalid-reference", "Import metadata is not valid JSON", 400); }
  if (
    typeof metadata.mutationID !== "string"
    || !metadata.mutationID
    || !metadata.destination
    || typeof metadata.destination !== "object"
    || !Array.isArray(metadata.entries)
  ) throw new ProtocolError("invalid-reference", "Import metadata is incomplete", 400);
  validateRef(metadata.destination, "import.destination");
  const entries: FsImportEntry[] = [];
  for (const item of metadata.entries) {
    if (typeof item.path !== "string" || (item.kind !== "file" && item.kind !== "directory")) {
      throw new ProtocolError("invalid-reference", "Import entry is invalid", 400);
    }
    if (item.kind === "directory") {
      entries.push({ path: item.path, kind: "directory" });
      continue;
    }
    const file = typeof item.field === "string" ? form.get(item.field) : null;
    if (!(file instanceof File)) throw new ProtocolError("invalid-reference", `Missing bytes for ${item.path}`, 400);
    entries.push({ path: item.path, kind: "file", bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  return { mutationID: metadata.mutationID, destination: metadata.destination as NodeRef, entries };
}

export interface ArborSyncServerOptions {
  port?: number;
  hostname?: string;
  faultInjector?: (stage: string) => void | Promise<void>;
  queryRuntime?: QueryStreamRuntime;
  mutationRuntime?: MutationCallRuntime;
  queryUser?: { profile: string } | null;
  /** Fallback reconciliation interval; Wire watches normally drive synchronization. */
  syncIntervalMs?: number;
}

function startArborSyncServer(
  service: ArborSyncDaemon,
  workspace: Workspace | undefined,
  options: {
    port?: number;
    hostname?: string;
    queryRuntime?: QueryStreamRuntime;
    mutationRuntime?: MutationCallRuntime;
    queryUser?: { profile: string } | null;
  } = {},
) {
  const renderRoot = join(import.meta.dir, "../../render/dist");
  const server = Bun.serve({
    port: options.port ?? 4317,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      try {
        assertSameOrigin(request, url);

        if (request.method === "GET" && url.pathname === "/v1/status") {
          const deviceID = await currentDeviceID();
          return json({ service: "arborsync", version: "0.1.0", protocolVersion: "v1", ...(deviceID ? { deviceID } : {}) });
        }
        if (request.method === "POST" && url.pathname === "/v1/sync") {
          await service.synchronizeNow();
          return json({ synchronized: true });
        }
        if (request.method === "POST" && url.pathname === "/v1/sessions") {
          const body = await request.json() as { path?: unknown };
          if (typeof body.path !== "string" || !isAbsolute(body.path)) {
            throw new ProtocolError("invalid-request", "A local session requires an absolute path", 400);
          }
          return json(await service.openSession(body.path), 201);
        }
        if (request.method === "POST" && url.pathname === "/v1/tree-ids") {
          return json({ id: generateArborID("tr") }, 201);
        }
        if (request.method === "GET" && url.pathname === "/v1/trees") {
          return json(await service.treeList());
        }
        if (request.method === "GET" && url.pathname === "/v1/resolve") {
          const locator = url.searchParams.get("locator");
          if (!locator) throw new ProtocolError("invalid-request", "resolve requires locator", 400);
          return json(await service.resolveLocator(locator));
        }
        if (request.method === "POST" && url.pathname === "/v1/bootstrap/claims") {
          const body = await request.json() as { origin?: unknown; handle?: unknown; path?: unknown; displayName?: unknown };
          if (
            typeof body.origin !== "string" || typeof body.handle !== "string" || typeof body.path !== "string"
            || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.handle)
            || (body.displayName !== undefined && typeof body.displayName !== "string")
          ) throw new ProtocolError("invalid-request", "Claim bootstrap requires origin, handle, and path", 400);
          return json(await service.claimProfileBootstrap(body.origin, body.handle, body.path, body.displayName as string | undefined), 201);
        }
        if (request.method === "POST" && url.pathname === "/v1/bootstrap/pairings") {
          return json(await service.createPairingBootstrap(), 201);
        }
        if (request.method === "POST" && url.pathname === "/v1/local/forget") {
          await service.forgetLocalAccount();
          return json({ forgotten: true });
        }
        const conflictResolution = /^\/v1\/conflicts\/([^/]+)\/resolve$/.exec(url.pathname);
        if (conflictResolution && request.method === "POST") {
          const body = await request.json() as { choice?: unknown };
          if (!["local", "draft", "remote"].includes(String(body.choice))) {
            throw new ProtocolError("invalid-request", "Conflict resolution requires local, draft, or remote", 400);
          }
          return json(await service.resolveTreeConflict(decodeURIComponent(conflictResolution[1]!), body.choice as "local" | "draft" | "remote"));
        }
        if (request.method === "GET" && url.pathname === "/v1/node") {
          return json(await service.snapshot(queryRef(url)));
        }
        if (request.method === "GET" && url.pathname === "/v1/file") {
          return fileResponse(request, await service.file(queryRef(url)), { noStore: true });
        }
        if (request.method === "GET" && url.pathname === "/v1/children") {
          return json(await service.children(queryRef(url), url.searchParams.get("cursor")));
        }
        if (request.method === "GET" && url.pathname === "/v1/search") {
          const tree = url.searchParams.get("tree");
          if (!tree) throw new ProtocolError("invalid-request", "search requires explicit tree scope", 400);
          return json(await service.searchPage(
            tree,
            url.searchParams.get("q") ?? "",
            url.searchParams.get("cursor"),
          ));
        }
        if (request.method === "GET" && url.pathname === "/v1/backlinks") {
          return json(await service.backlinksPage(queryRef(url), url.searchParams.get("cursor")));
        }
        if (request.method === "GET" && url.pathname === "/v1/recovery") {
          return json(await service.recoveryPage(
            queryRef(url),
            url.searchParams.get("recursive") === "true",
            url.searchParams.get("cursor"),
          ));
        }
        if (request.method === "GET" && url.pathname === "/v1/events") {
          const query = url.searchParams.get("after");
          const header = request.headers.get("last-event-id");
          if (query && header && query !== header) {
            throw new ProtocolError("invalid-request", "after and Last-Event-ID disagree", 400);
          }
          const after = query ?? header;
          try {
            service.events.validate(after);
          } catch (error) {
            if (!(error instanceof ResyncRequiredError)) throw error;
            const cursor = service.events.currentCursor();
            const event = { cursor, tree: "system", kind: "resync-required", change: { after } };
            return new Response(encodeSSEFrame({ id: cursor, event: "resync-required", data: event }), {
              headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
            });
          }
          return new Response(service.events.stream(after, request.signal), {
            headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
          });
        }
        const queryRoute = /^\/\.arbor\/trees\/([^/]+)\/queries$/.exec(url.pathname);
        if (request.method === "QUERY" && queryRoute) {
          if (!options.queryRuntime) return errorResponse("unsupported-operation", "No query runtime is active", 422);
          const treeID = decodeURIComponent(queryRoute[1]!);
          return treeQueryResponse(options.queryRuntime, request, treeID, options.queryUser ?? null);
        }
        const mutateRoute = /^\/\.arbor\/trees\/([^/]+)\/mutate$/.exec(url.pathname);
        if (request.method === "POST" && mutateRoute) {
          if (!options.mutationRuntime) return errorResponse("unsupported-operation", "No mutation runtime is active", 422);
          const treeID = decodeURIComponent(mutateRoute[1]!);
          return treeMutationResponse(options.mutationRuntime, request, treeID, options.queryUser ?? null);
        }
        if (request.method === "POST" && url.pathname === "/v1/mutations") {
          return json(await service.executeMutation(decodeMutation(await request.json())));
        }
        if (request.method === "POST" && url.pathname === "/v1/assets") {
          const input = await decodeAsset(request);
          return json(await service.assetV1(input.mutationID, input.directory, input.filename, input.bytes));
        }
        if (request.method === "POST" && url.pathname === "/v1/imports") {
          const input = await decodeImport(request);
          return json(await service.importV1(input.mutationID, input.destination, input.entries));
        }

        if (url.pathname.startsWith("/v/") || url.pathname.startsWith("/v1/")) {
          return errorResponse("unsupported-operation", "Route or method is not part of REST v1", 405);
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          return errorResponse("unsupported-operation", "Method not allowed", 405);
        }
        const isAppRoute = url.pathname === "/" || url.pathname === "/render" || url.pathname.startsWith("/render/");
        if (!isAppRoute) {
          const bundled = join(renderRoot, url.pathname.slice(1));
          if (existsSync(bundled)) {
            return new Response(await readFile(bundled), { headers: { "content-type": MIME[extname(bundled)] ?? "application/octet-stream" } });
          }
        }
        // The logical route is the file API: an ordinary file's OS-shaped
        // path serves its bytes (with ?raw overriding to a document's stored
        // body), dispatched into the owning root or the local filesystem;
        // the /render spelling is accepted so authored relative references
        // keep resolving under the app's route prefix.
        const logicalPath = url.pathname.replace(/^\/render(?=\/|$)/, "") || "/";
        const raw = url.searchParams.has("raw");
        let surface = await service.fileSurface(decodeURIComponent(logicalPath), raw).catch(() => null);
        if (!surface) {
          // Tree-rooted authored spellings (assets) resolve against the
          // origin in the DOM; the referring document's scope supplies the
          // enclosing tree.
          const referer = request.headers.get("referer");
          const refererPath = referer ? new URL(referer).pathname.replace(/^\/render(?=\/|$)/, "") : null;
          if (refererPath?.startsWith("/")) {
            surface = await service.fileSurfaceInScopeOf(
              decodeURIComponent(refererPath),
              decodeURIComponent(logicalPath),
              raw,
            );
          }
        }
        if (surface) {
          return fileResponse(request, surface, { raw });
        }
        const index = join(renderRoot, "index.html");
        if (!existsSync(index)) return new Response("Arbor web is not built. Run `bun run build:web`.", { status: 503 });
        return new Response(await readFile(index), { headers: { "content-type": MIME[".html"] ?? "text/html" } });
      } catch (error) {
        if (error instanceof ProtocolError) {
          const { retryable = false, tree, path, ...typedDetails } = error.details;
          return errorResponse(error.code, error.message, error.status, {
            retryable,
            tree,
            path,
            ...(Object.keys(typedDetails).length ? { details: typedDetails } : {}),
          });
        }
        if (error instanceof ResyncRequiredError) {
          return errorResponse("resync-required", error.message, 409, { retryable: true });
        }
        if (error instanceof RevisionConflictError) {
          const current = workspace ? await workspace.snapshot({ tree: workspace.tree, path: error.current.path, stableKey: null }) : undefined;
          return errorResponse("stale-content-revision", error.message, 409, {
            tree: workspace?.tree,
            path: error.current.path,
            details: { kind: "workspace-revision", current },
          });
        }
        if (error instanceof FsConflictError) {
          const mapped = fsErrorCode(error);
          const current = workspace && error.details.current
            ? await workspace.snapshot({ tree: workspace.tree, path: error.details.current.node.path, stableKey: null }).catch(() => undefined)
            : undefined;
          return errorResponse(mapped.code, error.message, mapped.status, {
            path: error.details.path,
            retryable: mapped.retryable ?? false,
            tree: workspace?.tree,
            details: { kind: "workspace-revision", current },
          });
        }
        if (error instanceof PathEscapeError) return errorResponse("unsafe-path", error.message, 400);
        return errorResponse("internal-error", "Arbor Sync could not complete the request", 500, {
          retryable: true,
        });
      }
    },
  });
  return { server, url: `http://${server.hostname}:${server.port}` };
}

export async function serveArborSync(
  startPath: string,
  options: ArborSyncServerOptions = {},
) {
  const service = await ArborSyncDaemon.open(
    startPath,
    { faultInjector: options.faultInjector },
    { ...(options.syncIntervalMs !== undefined ? { syncIntervalMs: options.syncIntervalMs } : {}) },
  );
  const workspace = service.session;
  try {
    const running = startArborSyncServer(service, workspace, options);
    const start = await realpath(startPath).catch(() => workspace.root);
    return { mode: "workspace" as const, service, workspace, ...running, start };
  } catch (error) {
    await service[Symbol.asyncDispose]();
    throw error;
  }
}

/** Serve Arbor web's remote/account surfaces without inventing a local workspace. */
export async function serveArborSyncControl(options: Omit<ArborSyncServerOptions, "faultInjector"> = {}) {
  // Remote browsing must not invent a filesystem session, but it still owns
  // background reconciliation for the user's explicitly tracked placements.
  const service = await ArborSyncDaemon.openControl({ autoSync: true });
  try {
    return { mode: "control" as const, service, ...startArborSyncServer(service, undefined, options) };
  } catch (error) {
    await service[Symbol.asyncDispose]();
    throw error;
  }
}
