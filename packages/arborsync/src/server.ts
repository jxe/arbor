import { realpath } from "node:fs/promises";
import { extname } from "node:path";
import type { ArborErrorCode, ArborError } from "@arbor/core";
import { PathEscapeError, encodeSSEFrame } from "@arbor/core";
import { currentDeviceID } from "@arbor/stores";
import { ResyncRequiredError } from "./events.ts";
import { ArborSyncDaemon } from "./service.ts";
import { OBJECT_HASH_PATTERN } from "./object-cache.ts";
import { ProtocolError, type Workspace } from "./workspace.ts";

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

/**
 * The page served at every app route until Plan B rebuilds Arbor web on the
 * working tree. Static hosting of tree files at OS-shaped routes stays.
 */
const WEB_PLACEHOLDER = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Arbor</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 36rem; line-height: 1.5;">
<h1>Arbor web is being rebuilt (Plan B)</h1>
<p>The daemon's editor path was removed; the web editor returns as a working-tree client. Use the Arbor app or the CLI in the meantime.</p>
</body>
</html>
`;

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
    throw new ProtocolError("invalid-request", "Cross-origin requests are not allowed", 400, { path: url.pathname });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface ArborSyncServerOptions {
  port?: number;
  hostname?: string;
  instanceID?: string;
  runtimeKind?: "persistent" | "foreground" | "cloud";
  faultInjector?: (stage: string) => void | Promise<void>;
  /** Fallback reconciliation interval; Wire watches normally drive synchronization. */
  syncIntervalMs?: number;
}

function startArborSyncServer(
  service: ArborSyncDaemon,
  workspace: Workspace | undefined,
  options: {
    port?: number;
    hostname?: string;
    instanceID?: string;
    runtimeKind?: "persistent" | "foreground" | "cloud";
  } = {},
) {
  const instanceID = options.instanceID ?? crypto.randomUUID();
  const server = Bun.serve({
    port: options.port ?? 4317,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request, server) {
      const url = new URL(request.url);
      try {
        assertSameOrigin(request, url);

        if (request.method === "GET" && url.pathname === "/v1/status") {
          const deviceID = await currentDeviceID();
          return json({
            service: "arborsync",
            version: "0.1.0",
            protocolVersion: "v1",
            instanceID,
            runtimeKind: options.runtimeKind ?? (workspace ? "foreground" : "persistent"),
            ...(deviceID ? { deviceID } : {}),
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/sync") {
          const source = await request.text();
          let body: { configurationTree?: unknown } = {};
          try {
            const decoded = source ? JSON.parse(source) as unknown : {};
            if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("not an object");
            body = decoded as { configurationTree?: unknown };
          } catch {
            throw new ProtocolError("invalid-request", "Sync body must be a JSON object", 400);
          }
          const unknown = Object.keys(body).filter((key) => key !== "configurationTree");
          if (unknown.length) throw new ProtocolError("invalid-request", `Unknown sync fields: ${unknown.join(", ")}`, 400);
          if (
            body.configurationTree !== undefined
            && (typeof body.configurationTree !== "string" || !/^tr_[a-z2-7]+$/.test(body.configurationTree))
          ) throw new ProtocolError("invalid-request", "configurationTree must be a TreeID", 400);
          server.timeout(request, 0);
          await service.synchronizeNow(body.configurationTree as string | undefined);
          return json({ synchronized: true });
        }
        if (request.method === "POST" && url.pathname === "/v1/placements/move") {
          const body = await request.json() as { source?: unknown; destination?: unknown; check?: unknown };
          if (
            typeof body.source !== "string"
            || typeof body.destination !== "string"
            || (body.check !== undefined && typeof body.check !== "boolean")
          ) throw new ProtocolError("invalid-request", "Placement move requires source and destination paths", 400);
          return json(await service.moveLocalPlacement({
            source: body.source,
            destination: body.destination,
            check: body.check === true,
          }));
        }
        if (request.method === "GET" && url.pathname === "/v1/trees") {
          return json(await service.treeList());
        }
        if (request.method === "GET" && url.pathname === "/v1/bootstrap") {
          const tree = url.searchParams.get("tree");
          if (!tree) throw new ProtocolError("invalid-request", "bootstrap requires explicit tree scope", 400);
          return json(await service.bootstrapTree(tree));
        }
        if (request.method === "GET" && url.pathname === "/v1/credential") {
          // Deliberate loopback exposure (see docs/local-system.md).
          const configurationTree = url.searchParams.get("configurationTree") ?? undefined;
          return json({ token: await service.credentialToken(configurationTree) });
        }
        if (request.method === "GET" && url.pathname.startsWith("/v1/objects/")) {
          const hash = decodeURIComponent(url.pathname.slice("/v1/objects/".length));
          if (!OBJECT_HASH_PATTERN.test(hash)) throw new ProtocolError("invalid-request", "Object hashes are sha256:<64 hex>", 400);
          const tree = url.searchParams.get("tree");
          if (!tree) throw new ProtocolError("invalid-request", "objects requires explicit tree scope", 400);
          const origin = url.searchParams.get("origin") ?? undefined;
          if (origin !== undefined && !/^https?:\/\//.test(origin)) throw new ProtocolError("invalid-request", "origin must be an http(s) URL", 400);
          const bytes = await service.objectBytes(tree, hash, origin);
          if (!bytes) throw new ProtocolError("not-found", `Object is not available: ${hash}`, 404, { tree });
          return new Response(Buffer.from(bytes), {
            headers: {
              "content-type": "application/cbor",
              "content-length": String(bytes.byteLength),
              etag: `"${hash}"`,
              "cache-control": "private, immutable, max-age=31536000",
            },
          });
        }
        if (request.method === "GET" && url.pathname === "/v1/conflicts") {
          const tree = url.searchParams.get("tree");
          if (!tree) throw new ProtocolError("invalid-request", "conflicts requires explicit tree scope", 400);
          return json(await service.treeConflictWorkspace(tree));
        }
        if (request.method === "POST" && url.pathname === "/v1/conflicts/resolve") {
          const body = await request.json() as { tree?: unknown; identity?: unknown; resolutions?: unknown };
          if (typeof body.tree !== "string" || typeof body.identity !== "string" || !isRecord(body.resolutions)) {
            throw new ProtocolError("invalid-request", "Conflict resolution requires tree, identity, and resolutions", 400);
          }
          const resolutions: Record<string, import("@arbor/core").SyncConflictResolution> = {};
          for (const [path, value] of Object.entries(body.resolutions)) {
            if (!isRecord(value) || typeof value.choice !== "string") {
              throw new ProtocolError("invalid-request", `Invalid conflict resolution for ${path}`, 400);
            }
            if (["current", "mine", "both"].includes(value.choice) && Object.keys(value).length === 1) {
              resolutions[path] = { choice: value.choice as "current" | "mine" | "both" };
            } else if (value.choice === "edit" && typeof value.text === "string" && Object.keys(value).every((key) => key === "choice" || key === "text")) {
              resolutions[path] = { choice: "edit", text: value.text };
            } else {
              throw new ProtocolError("invalid-request", `Invalid conflict resolution for ${path}`, 400);
            }
          }
          return json({ effects: await service.resolveReviewedTreeConflict(body.tree, body.identity, resolutions) });
        }
        if (request.method === "GET" && url.pathname === "/v1/accounts") {
          const [accounts, identity] = await Promise.all([service.accountList(), service.profileIdentity()]);
          return json({ accounts, identity });
        }
        if (request.method === "POST" && url.pathname === "/v1/me") {
          const body = await request.json() as { path?: unknown };
          if (typeof body.path !== "string") throw new ProtocolError("invalid-request", "Identity creation requires a profile path", 400);
          return json({ identity: await service.createProfileIdentity(body.path) }, 201);
        }
        if (request.method === "GET" && url.pathname === "/v1/resolve") {
          const locator = url.searchParams.get("locator");
          if (!locator) throw new ProtocolError("invalid-request", "resolve requires locator", 400);
          return json(await service.resolveLocator(locator));
        }
        if (request.method === "POST" && url.pathname === "/v1/bootstrap/accounts") {
          const body = await request.json() as { account?: unknown; path?: unknown; displayName?: unknown };
          if (
            typeof body.account !== "string" || typeof body.path !== "string"
            || (body.displayName !== undefined && typeof body.displayName !== "string")
          ) throw new ProtocolError("invalid-request", "Account bootstrap requires an account locator and local profile path", 400);
          return json(await service.claimCanopyAccount(body.account, body.path, body.displayName as string | undefined), 201);
        }
        if (request.method === "POST" && url.pathname === "/v1/bootstrap/pairings") {
          const body = request.headers.get("content-length") === "0"
            ? {}
            : await request.json().catch(() => ({})) as { configurationTree?: unknown };
          if (body.configurationTree !== undefined && typeof body.configurationTree !== "string") {
            throw new ProtocolError("invalid-request", "configurationTree must be a TreeID", 400);
          }
          return json(await service.createPairingBootstrap(body.configurationTree as string | undefined), 201);
        }
        if (request.method === "POST" && url.pathname === "/v1/local/forget") {
          await service.forgetLocalAccount();
          return json({ forgotten: true });
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
          // Event streams stay open indefinitely; lift Bun's per-connection idle timeout for them.
          server.timeout(request, 0);
          return new Response(service.events.stream(after, request.signal), {
            headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
          });
        }
        if (url.pathname.startsWith("/v/") || url.pathname.startsWith("/v1/")) {
          return errorResponse("unsupported-operation", "Route or method is not part of REST v1", 405);
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          return errorResponse("unsupported-operation", "Method not allowed", 405);
        }
        // The logical route is the file API: an ordinary file's OS-shaped
        // path serves its bytes (with ?raw overriding to a document's stored
        // body), dispatched into the owning root; the /render spelling is
        // accepted so authored relative references keep resolving under the
        // app's route prefix.
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
        return new Response(WEB_PLACEHOLDER, { headers: { "content-type": MIME[".html"] ?? "text/html" } });
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
        if (error instanceof PathEscapeError) return errorResponse("unsafe-path", error.message, 400);
        console.error(
          `[arborsync] Unhandled ${request.method} ${url.pathname}`,
          error instanceof Error ? error.stack ?? error.message : error,
        );
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

/** Serve the control surface (placements, accounts, bootstrap) without inventing a local workspace. */
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
