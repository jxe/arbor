import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  ArbordErrorCode,
  ArbordErrorEnvelope,
  MutationRequest,
  NodeRef,
} from "@arbor/core";
import { PathEscapeError } from "@arbor/core";
import { FsConflictError, type FsImportEntry } from "@arbor/fs";
import { ResyncRequiredError } from "./events.ts";
import { ArborService, fsErrorCode } from "./service.ts";
import { ProtocolError, RevisionConflictError } from "./workspace.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function errorResponse(
  code: ArbordErrorCode,
  message: string,
  status: number,
  details: Partial<ArbordErrorEnvelope["error"]> = {},
): Response {
  return json({ error: { code, message, retryable: false, ...details } } satisfies ArbordErrorEnvelope, status);
}

function assertSameOrigin(request: Request, url: URL): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    throw new ProtocolError("unsafe-path", "Cross-origin workspace mutations are not allowed", 400, { path: url.pathname });
  }
}

function queryRef(url: URL): NodeRef {
  const path = url.searchParams.get("path");
  const pageID = url.searchParams.get("pageID");
  if (Boolean(path) === Boolean(pageID)) {
    throw new ProtocolError("invalid-reference", "Supply exactly one of path or pageID", 400);
  }
  const tree = url.searchParams.get("tree");
  const scope = tree !== null ? { tree } : {};
  return path !== null
    ? { ...scope, path }
    : { ...scope, pageID: pageID!, ...(url.searchParams.has("pathHint") ? { pathHint: url.searchParams.get("pathHint")! } : {}) };
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
    operation.op === "writeMarkdown" || operation.op === "restoreRecovery"
    || operation.op === "ensureDocumentIdentity"
  ).length;
  if (contentCount > 0 && (contentCount !== 1 || input.operations.length !== 1)) {
    throw new ProtocolError(
      "unsupported-operation",
      "A content mutation contains exactly one operation and cannot be mixed with structural operations",
      422,
    );
  }
  const systemCount = input.operations.filter((operation) =>
    operation.op === "configureServer" || operation.op === "promoteTree"
    || operation.op === "placeTree" || operation.op === "setTreePublication"
  ).length;
  if (systemCount > 0 && (systemCount !== 1 || input.operations.length !== 1)) {
    throw new ProtocolError(
      "unsupported-operation",
      "A system mutation contains exactly one operation and cannot be mixed with workspace operations",
      422,
    );
  }
  return input as MutationRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateRef(value: unknown, field: string): asserts value is NodeRef {
  if (!isRecord(value)) {
    throw new ProtocolError("invalid-reference", `${field} must be a node reference`, 400);
  }
  const hasPath = Object.prototype.hasOwnProperty.call(value, "path");
  const hasPageID = Object.prototype.hasOwnProperty.call(value, "pageID");
  if (
    hasPath === hasPageID
    || (hasPath && (typeof value.path !== "string" || !value.path))
    || (hasPageID && (typeof value.pageID !== "string" || !value.pageID))
    || (value.pathHint !== undefined && typeof value.pathHint !== "string")
    || (value.tree !== undefined && (typeof value.tree !== "string" || !value.tree))
  ) {
    throw new ProtocolError("invalid-reference", `${field} must contain exactly one non-empty path or pageID`, 400);
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

const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "quote",
  "codeBlock",
  "image",
  "divider",
  "mathBlock",
  "footnoteDefinition",
  "toggle",
  "standaloneLink",
  // Accepted input alias for standaloneLink, normalized on decode.
  "childPage",
  "rawMarkdown",
]);

function normalizeBlockAliases(value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const block of value) {
    if (!isRecord(block)) continue;
    if (block.type === "childPage") block.type = "standaloneLink";
    normalizeBlockAliases(block.children);
  }
}

function validateBlocks(value: unknown, field: string): void {
  if (!Array.isArray(value)) {
    throw new ProtocolError("invalid-reference", `${field} must be a block array`, 400);
  }
  value.forEach((block, index) => {
    const name = `${field}[${index}]`;
    if (
      !isRecord(block)
      || typeof block.id !== "string"
      || !block.id
      || typeof block.type !== "string"
      || !BLOCK_TYPES.has(block.type)
      || (block.content !== undefined && typeof block.content !== "string")
      || (block.source !== undefined && typeof block.source !== "string")
      || (block.sourceHash !== undefined && typeof block.sourceHash !== "string")
    ) {
      throw new ProtocolError("invalid-reference", `${name} is not a valid Arbor block`, 400);
    }
    if (block.props !== undefined) {
      if (
        !isRecord(block.props)
        || Object.values(block.props).some((item) =>
          typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean"
        )
      ) {
        throw new ProtocolError("invalid-reference", `${name}.props contains an invalid value`, 400);
      }
    }
    validateBlocks(block.children, `${name}.children`);
  });
}

function validateOperation(value: unknown): void {
  if (!isRecord(value) || typeof value.op !== "string" || !value.op) {
    throw new ProtocolError("invalid-reference", "Every operation requires an op discriminator", 400);
  }
  switch (value.op) {
    case "writeMarkdown":
      validateRef(value.ref, "writeMarkdown.ref");
      if (typeof value.baseContentRevision !== "string") {
        throw new ProtocolError("invalid-reference", "writeMarkdown requires baseContentRevision and blocks", 400);
      }
      validateBlocks(value.blocks, "writeMarkdown.blocks");
      normalizeBlockAliases(value.blocks);
      if (value.frontmatterPatch !== undefined && !isRecord(value.frontmatterPatch)) {
        throw new ProtocolError("invalid-reference", "frontmatterPatch must be an object", 400);
      }
      return;
    case "createDirectory":
      if (typeof value.path !== "string" || !value.path) {
        throw new ProtocolError("invalid-reference", "createDirectory requires path", 400);
      }
      return;
    case "createMarkdown":
      if (
        typeof value.path !== "string"
        || !value.path
        || (value.blocks !== undefined && !Array.isArray(value.blocks))
      ) {
        throw new ProtocolError("invalid-reference", "createMarkdown requires path and optional blocks", 400);
      }
      if (value.blocks !== undefined) {
        validateBlocks(value.blocks, "createMarkdown.blocks");
        normalizeBlockAliases(value.blocks);
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
      if (value.placement !== undefined && value.placement !== "natural" && value.placement !== "authored") {
        throw new ProtocolError("invalid-reference", "move.placement must be \"natural\" or \"authored\"", 400);
      }
      optionalString(value.beforePath, "move.beforePath");
      optionalString(value.beforeBlockID, "move.beforeBlockID");
      optionalString(value.baseDirectoryRevision, "move.baseDirectoryRevision");
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
    case "configureServer":
      if (typeof value.origin !== "string" || typeof value.ownerToken !== "string" || !value.ownerToken) {
        throw new ProtocolError("invalid-reference", "configureServer requires origin and ownerToken", 400);
      }
      try { new URL(value.origin); } catch {
        throw new ProtocolError("invalid-reference", "configureServer origin must be a URL", 400);
      }
      return;
    case "promoteTree":
      if (typeof value.path !== "string" || !value.path.startsWith("/") || typeof value.slug !== "string" || !value.slug) {
        throw new ProtocolError("invalid-reference", "promoteTree requires an absolute path and slug", 400);
      }
      return;
    case "placeTree":
      if (
        typeof value.tree !== "string"
        || !value.tree.startsWith("tr_")
        || typeof value.path !== "string"
        || !value.path.startsWith("/")
        || (value.endpoint !== undefined && typeof value.endpoint !== "string")
        || (value.canonical !== undefined && typeof value.canonical !== "string")
      ) {
        throw new ProtocolError("invalid-reference", "placeTree requires a TreeID and absolute path", 400);
      }
      return;
    case "setTreePublication":
      if (
        typeof value.tree !== "string"
        || !value.tree.startsWith("tr_")
        || !["private", "public-read", "public-write"].includes(String(value.publication))
      ) {
        throw new ProtocolError("invalid-reference", "setTreePublication requires a TreeID and publication mode", 400);
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

export async function serveArbor(
  startPath: string,
  options: {
    port?: number;
    hostname?: string;
    faultInjector?: (stage: string) => void | Promise<void>;
  } = {},
) {
  const service = await ArborService.open(startPath, { faultInjector: options.faultInjector });
  const workspace = service.session;
  const renderRoot = join(import.meta.dir, "../../render/dist");
  const server = Bun.serve({
    port: options.port ?? 4317,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      try {
        assertSameOrigin(request, url);

        if (request.method === "GET" && url.pathname === "/v1/node") {
          return json(await service.snapshot(queryRef(url)));
        }
        if (request.method === "GET" && url.pathname === "/v1/children") {
          return json(await service.children(queryRef(url), url.searchParams.get("cursor")));
        }
        if (request.method === "GET" && url.pathname === "/v1/search") {
          return json(await service.searchPage(
            url.searchParams.get("tree") ?? undefined,
            url.searchParams.get("q") ?? "",
            url.searchParams.get("cursor"),
          ));
        }
        if (request.method === "GET" && url.pathname === "/v1/backlinks") {
          return json(await service.backlinksPage(queryRef(url), url.searchParams.get("cursor")));
        }
        if (request.method === "GET" && url.pathname === "/v1/collection") {
          return json(await service.collectionPage(queryRef(url), url.searchParams.get("cursor"), url.searchParams.get("table") ?? undefined));
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
            throw new ProtocolError("invalid-reference", "after and Last-Event-ID disagree", 400);
          }
          const after = query ?? header;
          service.events.validate(after);
          return new Response(service.events.stream(after, request.signal), {
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
          });
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
          const etag = `"${surface.revision}"`;
          const contentType = MIME[extname(surface.path)]
            ?? (raw ? "text/markdown; charset=utf-8" : "application/octet-stream");
          const baseHeaders: Record<string, string> = {
            "content-type": contentType,
            etag,
            "accept-ranges": "bytes",
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
        const index = join(renderRoot, "index.html");
        if (!existsSync(index)) return new Response("TreeHopper web is not built. Run `bun run build:web`.", { status: 503 });
        return new Response(await readFile(index), { headers: { "content-type": MIME[".html"] ?? "text/html" } });
      } catch (error) {
        if (error instanceof ProtocolError) {
          return errorResponse(error.code, error.message, error.status, { retryable: error.details.retryable ?? false, ...error.details });
        }
        if (error instanceof ResyncRequiredError) {
          return errorResponse("resync-required", error.message, 409, { retryable: true });
        }
        if (error instanceof RevisionConflictError) {
          const current = await workspace.snapshot({ path: error.current.path });
          return errorResponse("stale-content-revision", error.message, 409, { path: error.current.path, current });
        }
        if (error instanceof FsConflictError) {
          const mapped = fsErrorCode(error);
          const current = error.details.current
            ? await workspace.snapshot({ path: error.details.current.node.path }).catch(() => undefined)
            : undefined;
          return errorResponse(mapped.code, error.message, mapped.status, {
            path: error.details.path,
            retryable: mapped.retryable ?? false,
            current,
          });
        }
        if (error instanceof PathEscapeError) return errorResponse("unsafe-path", error.message, 400);
        return errorResponse("internal-error", "Arbord could not complete the request", 500, {
          retryable: true,
        });
      }
    },
  });
  const start = await realpath(startPath).catch(() => workspace.root);
  return { service, workspace, server, start, url: `http://${server.hostname}:${server.port}` };
}

/** Deprecated alias: the daemon serves the whole filesystem; the path is a starting location. */
export const serveWorkspace = serveArbor;
