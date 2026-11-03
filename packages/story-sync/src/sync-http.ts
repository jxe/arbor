import { STORY_VERSION } from "./version.ts";
import { encodeCanonicalCBOR, encodeSSEFrame, ProtocolError } from "@ovst/protocol";
import { ResyncRequiredError } from "./events.ts";
import type { StorySyncDaemon } from "./service.ts";
import { OBJECT_HASH_PATTERN } from "./object-cache.ts";
import { json, errorResponse } from "./http.ts";
import { isCloudPlaceholderError } from "./cloud-placeholders.ts";
import { AgentRunError } from "./agent-runs.ts";

type SyncHTTPService = Pick<StorySyncDaemon,
  "events" | "synchronizeNow" | "moveLocalPlacement" | "treeList" | "bootstrapTree" |
  "objectBytes" | "agents" | "runs" | "declinedChanges" | "discardHeldChanges" | "restoreDeclined" | "resendDeclined" | "resolveLocator" | "pauseFolder" | "resumeFolder" | "pendingUpdate">;

export function syncHandler(service: SyncHTTPService, options: {
  instanceID: string;
  runtimeKind: "persistent" | "foreground" | "cloud";
}) {
  const { instanceID } = options;
  return async (request: Request, url: URL, server: { timeout(request: Request, seconds: number): void }): Promise<Response | undefined> => {
    if (request.method === "GET" && url.pathname === "/v1/status") {
      return json({
        service: "story-sync",
        version: STORY_VERSION,
        protocolVersion: "v1",
        instanceID,
        runtimeKind: options.runtimeKind,
        // Only a caller holding this data home's token gets this far (data-home.md).
        access: "token",
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
    if (request.method === "POST" && url.pathname === "/v1/agents/report") {
      let body: Record<string, unknown>;
      try {
        const decoded = await request.json() as unknown;
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("not an object");
        body = decoded as Record<string, unknown>;
      } catch {
        throw new ProtocolError("invalid-request", "An agent report must be a JSON object", 400);
      }
      const unknown = Object.keys(body).filter((key) => !["session", "cwd", "agent", "status", "at", "hold", "done", "hook"].includes(key));
      if (unknown.length) throw new ProtocolError("invalid-request", `Unknown agent report fields: ${unknown.join(", ")}`, 400);
      if (body.hold !== undefined && typeof body.hold !== "boolean") throw new ProtocolError("invalid-request", "hold must be a boolean", 400);
      for (const key of ["session", "agent", "status", "at", "done"]) {
        if (body[key] !== undefined && typeof body[key] !== "string") throw new ProtocolError("invalid-request", `${key} must be a string`, 400);
      }
      if (typeof body.cwd !== "string" || !body.cwd.startsWith("/")) throw new ProtocolError("invalid-request", "cwd must be an absolute path", 400);
      const result = await service.agents.report(body as unknown as Parameters<typeof service.agents.report>[0]);
      return json(result ?? { ignored: "not-placed" });
    }
    if (request.method === "GET" && url.pathname === "/v1/agents") {
      return json(service.agents.list());
    }
    if (url.pathname === "/v1/agents/runs" || url.pathname.startsWith("/v1/agents/runs/")) {
      try {
        if (request.method === "GET" && url.pathname === "/v1/agents/runs") return json(service.runs.list());
        if (request.method === "POST" && url.pathname === "/v1/agents/runs") {
          let body: Record<string, unknown>;
          try { body = await request.json() as Record<string, unknown>; } catch { throw new ProtocolError("invalid-request", "A run must be a JSON object", 400); }
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProtocolError("invalid-request", "A run must be a JSON object", 400);
          const unknown = Object.keys(body).filter((key) => !["tree", "page", "task"].includes(key));
          if (unknown.length) throw new ProtocolError("invalid-request", `Unknown run fields: ${unknown.join(", ")}`, 400);
          if (typeof body.tree !== "string" || typeof body.page !== "string" || typeof body.task !== "string" || !body.task.trim()) {
            throw new ProtocolError("invalid-request", "A run needs a tree, a page and the task's text", 400);
          }
          return json(await service.runs.start({ tree: body.tree, page: body.page, task: body.task }), 202);
        }
        const match = /^\/v1\/agents\/runs\/(run_[0-9a-f]+)(?:\/(stop|undo|allow))?$/.exec(url.pathname);
        if (match && request.method === "GET" && !match[2]) {
          const run = service.runs.get(match[1]!);
          if (!run) throw new ProtocolError("not-found", "No such run", 404);
          return json(run);
        }
        if (match && request.method === "POST" && match[2] === "stop") return json(service.runs.stop(match[1]!));
        if (match && request.method === "POST" && match[2] === "undo") return json(await service.runs.undo(match[1]!));
        if (match && request.method === "POST" && match[2] === "allow") {
          const body = await request.json().catch(() => null) as { rule?: unknown } | null;
          if (typeof body?.rule !== "string") throw new ProtocolError("invalid-request", "Allowing a tool needs its rule", 400);
          return json(await service.runs.allow(match[1]!, body.rule));
        }
        throw new ProtocolError("not-found", "No such run route", 404);
      } catch (error) {
        if (!(error instanceof AgentRunError)) throw error;
        const status = error.code === "not-found" || error.code === "not-placed" ? 404 : 409;
        throw new ProtocolError(status === 404 ? "not-found" : "conflict", error.message, status, { kind: error.code } as never);
      }
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
        // Canonical CBOR only, with `spine` as the bundle's bytes; the daemon and
        // its clients are one install, so there is no JSON form. Errors stay JSON.
        return new Response(encodeCanonicalCBOR(await service.bootstrapTree(tree)) as Uint8Array<ArrayBuffer>, {
          headers: { "content-type": "application/cbor", "cache-control": "no-store" },
        });
      } catch (error) {
        if (isCloudPlaceholderError(error)) {
          throw new ProtocolError(
            "internal-error",
            "Story Sync could not read local file content while opening the tree. One or more files may be unavailable cloud placeholders; make them available locally, then reconnect.",
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
      const bytes = await service.objectBytes(tree, hash);
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
    if (request.method === "POST" && url.pathname === "/v1/held/discard") {
      const body = await request.json() as { tree?: unknown };
      if (typeof body.tree !== "string" || !body.tree) throw new ProtocolError("invalid-request", "Discarding held changes requires a tree", 400);
      await service.discardHeldChanges(body.tree);
      return json({ tree: body.tree });
    }
    if (request.method === "GET" && url.pathname === "/v1/declined") {
      const tree = url.searchParams.get("tree");
      if (!tree) throw new ProtocolError("invalid-request", "declined requires explicit tree scope", 400);
      return json({ declined: await service.declinedChanges(tree) });
    }
    if (request.method === "POST" && (url.pathname === "/v1/declined/restore" || url.pathname === "/v1/declined/resend")) {
      const body = await request.json() as { tree?: unknown };
      const restore = url.pathname === "/v1/declined/restore";
      if (typeof body.tree !== "string" || !body.tree) throw new ProtocolError("invalid-request", `${restore ? "Restoring" : "Resending"} declined changes requires a tree`, 400);
      await (restore ? service.restoreDeclined(body.tree) : service.resendDeclined(body.tree));
      return json({ tree: body.tree });
    }
    if (request.method === "POST" && (url.pathname === "/v1/placements/pause" || url.pathname === "/v1/placements/resume")) {
      const body = await request.json() as { tree?: unknown };
      const pause = url.pathname === "/v1/placements/pause";
      if (typeof body.tree !== "string" || !body.tree) throw new ProtocolError("invalid-request", `${pause ? "Pausing" : "Resuming"} a placement requires a tree`, 400);
      return json(pause ? await service.pauseFolder(body.tree) : await service.resumeFolder(body.tree));
    }
    if (request.method === "GET" && url.pathname === "/v1/pending") {
      const tree = url.searchParams.get("tree");
      if (!tree) throw new ProtocolError("invalid-request", "pending requires explicit tree scope", 400);
      return json(await service.pendingUpdate(tree));
    }
    if (request.method === "GET" && url.pathname === "/v1/resolve") {
      const locator = url.searchParams.get("locator");
      if (!locator) throw new ProtocolError("invalid-request", "resolve requires locator", 400);
      return json(await service.resolveLocator(locator));
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      // `after` is the only resume cursor, as on a host's tree watch; `Last-Event-ID` is ignored.
      const after = url.searchParams.get("after");
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
