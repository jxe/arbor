import { encodeSSEFrame } from "@arbor/core";
import { currentDeviceID } from "@arbor/stores";
import { ResyncRequiredError } from "./events.ts";
import type { ArborSyncDaemon } from "./service.ts";
import { OBJECT_HASH_PATTERN } from "./object-cache.ts";
import { ProtocolError } from "@arbor/core";
import { json, errorResponse } from "./http.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localContentUnavailable(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EDEADLK";
}

type SyncHTTPService = Pick<ArborSyncDaemon,
  "events" | "synchronizeNow" | "moveLocalPlacement" | "treeList" | "bootstrapTree" |
  "objectBytes" | "treeConflictWorkspace" | "resolveReviewedTreeConflict" | "resolveLocator">;

export function syncHandler(service: SyncHTTPService, options: {
  instanceID: string;
  runtimeKind: "persistent" | "foreground" | "cloud";
}) {
  const { instanceID } = options;
  return async (request: Request, url: URL, server: { timeout(request: Request, seconds: number): void }): Promise<Response | undefined> => {
    if (request.method === "GET" && url.pathname === "/v1/status") {
      const deviceID = await currentDeviceID();
      return json({
        service: "arborsync",
        version: "0.1.0",
        protocolVersion: "v1",
        instanceID,
        runtimeKind: options.runtimeKind,
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
      try {
        return json(await service.bootstrapTree(tree));
      } catch (error) {
        if (localContentUnavailable(error)) {
          throw new ProtocolError(
            "internal-error",
            "Arbor Sync could not read local file content while opening the tree. One or more files may be unavailable cloud placeholders; make them available locally, then reconnect.",
            500,
            { tree, retryable: true, kind: "local-content-unavailable", reason: error.code } as ProtocolError["details"],
          );
        }
        throw error;
      }
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
          "content-type": "application/octet-stream",
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
    if (request.method === "GET" && url.pathname === "/v1/resolve") {
      const locator = url.searchParams.get("locator");
      if (!locator) throw new ProtocolError("invalid-request", "resolve requires locator", 400);
      return json(await service.resolveLocator(locator));
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
    return undefined;
  };
}
