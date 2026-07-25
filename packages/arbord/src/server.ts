import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
import { ProtocolError, RevisionConflictError, Workspace } from "./workspace.ts";

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
  return path !== null
    ? { path }
    : { pageID: pageID!, ...(url.searchParams.has("pathHint") ? { pathHint: url.searchParams.get("pathHint")! } : {}) };
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
  "childPage",
  "rawMarkdown",
]);

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
      if (value.blocks !== undefined) validateBlocks(value.blocks, "createMarkdown.blocks");
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

function fsErrorCode(error: FsConflictError): { code: ArbordErrorCode; status: number; retryable?: boolean } {
  switch (error.details.code) {
    case "stale-revision": return { code: "stale-content-revision", status: 409 };
    case "missing-insertion-anchor": return { code: "missing-insertion-anchor", status: 409 };
    case "occupied-destination": return { code: "occupied-destination", status: 409 };
    case "duplicate-body": return { code: "duplicate-body-representation", status: 409 };
    case "unsafe-path":
    case "recursive-move": return { code: "unsafe-path", status: 400 };
    case "not-found": return { code: "not-found", status: 404 };
    case "read-only": return { code: "read-only", status: 422 };
    case "offline": return { code: "not-materialized", status: 409, retryable: true };
    default: return { code: "invalid-reference", status: 400 };
  }
}

export async function serveWorkspace(
  root: string,
  options: {
    port?: number;
    hostname?: string;
    faultInjector?: (stage: string) => void | Promise<void>;
  } = {},
) {
  const workspace = await Workspace.open(root, { faultInjector: options.faultInjector });
  const renderRoot = join(import.meta.dir, "../../render/dist");
  const server = Bun.serve({
    port: options.port ?? 4317,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      try {
        assertSameOrigin(request, url);

        if (request.method === "GET" && url.pathname === "/v1/node") {
          return json(await workspace.snapshot(queryRef(url)));
        }
        if (request.method === "GET" && url.pathname === "/v1/children") {
          return json(await workspace.children(queryRef(url), url.searchParams.get("cursor")));
        }
        if (request.method === "GET" && url.pathname === "/v1/search") {
          return json(await workspace.searchPage(url.searchParams.get("q") ?? "", url.searchParams.get("cursor")));
        }
        if (request.method === "GET" && url.pathname === "/v1/collection") {
          return json(await workspace.collectionPage(queryRef(url), url.searchParams.get("cursor"), url.searchParams.get("table") ?? undefined));
        }
        if (request.method === "GET" && url.pathname === "/v1/recovery") {
          return json(await workspace.recoveryPage(queryRef(url)));
        }
        if (request.method === "GET" && url.pathname === "/v1/events") {
          const query = url.searchParams.get("after");
          const header = request.headers.get("last-event-id");
          if (query && header && query !== header) {
            throw new ProtocolError("invalid-reference", "after and Last-Event-ID disagree", 400);
          }
          const after = query ?? header;
          workspace.events.validate(after);
          return new Response(workspace.events.stream(after, request.signal), {
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/mutations") {
          const result = await workspace.executeMutation(decodeMutation(await request.json()));
          await workspace.protocolFault("protocol:response-delivery");
          return json(result);
        }
        if (request.method === "POST" && url.pathname === "/v1/assets") {
          const input = await decodeAsset(request);
          const result = await workspace.assetV1(input.mutationID, input.directory, input.filename, input.bytes);
          await workspace.protocolFault("protocol:response-delivery");
          return json(result);
        }
        if (request.method === "POST" && url.pathname === "/v1/imports") {
          const input = await decodeImport(request);
          const result = await workspace.importV1(input.mutationID, input.destination, input.entries);
          await workspace.protocolFault("protocol:response-delivery");
          return json(result);
        }

        if (request.method === "GET" && (url.pathname.startsWith("/Assets/") || url.pathname.startsWith("/render/Assets/"))) {
          const assetPath = url.pathname.replace(/^\/render/, "");
          const node = await workspace.node(assetPath);
          if (node.kind !== "file") return errorResponse("not-found", "Asset not found", 404, { path: assetPath });
          const absolute = join(workspace.root, assetPath);
          return new Response(await readFile(absolute), { headers: { "content-type": MIME[extname(absolute)] ?? "application/octet-stream" } });
        }
        if (url.pathname.startsWith("/v/") || url.pathname.startsWith("/v1/")) {
          return errorResponse("unsupported-operation", "Route or method is not part of REST v1", 405);
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          return errorResponse("unsupported-operation", "Method not allowed", 405);
        }
        const assetPath = url.pathname === "/" || url.pathname.startsWith("/render/") ? "index.html" : url.pathname.slice(1);
        let absolute = join(renderRoot, assetPath);
        if (!existsSync(absolute)) absolute = join(renderRoot, "index.html");
        if (!existsSync(absolute)) return new Response("TreeHopper web is not built. Run `bun run build:web`.", { status: 503 });
        return new Response(await readFile(absolute), { headers: { "content-type": MIME[extname(absolute)] ?? "application/octet-stream" } });
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
  return { workspace, server, url: `http://${server.hostname}:${server.port}` };
}
