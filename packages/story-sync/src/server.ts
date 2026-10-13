import { syncHandler } from "./sync-http.ts";
import { errorResponse, assertCaller, assertSameOrigin, isCaller } from "./http.ts";
import { accountHandler } from "./account-http.ts";
import { LocalAccountService } from "./account-service.ts";
import { browserHandler, webPlaceholder } from "./browser-http.ts";
import { LocalFileService } from "./local-files.ts";
import { realpath } from "node:fs/promises";
import {
  PathEscapeError,
  STORY_SYNC_DEFAULT_PORT,
  STORY_SYNC_PORT_RANGE,
  ensureStorySyncAccess,
  recordStorySyncOrigin,
  storySyncAuthorization,
} from "@ovst/protocol";
import { ResyncRequiredError } from "./events.ts";
import { StorySyncDaemon } from "./service.ts";
import { ProtocolError, type Workspace } from "./workspace.ts";

export interface StorySyncServerOptions {
  port?: number;
  hostname?: string;
  instanceID?: string;
  runtimeKind?: "persistent" | "foreground" | "cloud";
  /** Fallback reconciliation interval; protocol watches normally drive synchronization. */
  syncIntervalMs?: number;
}

/**
 * Whether the Story Sync answering at `origin` accepts `token`: true for this
 * data home's own, false for another user's (or anything else that refuses it).
 */
async function answersToToken(origin: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/v1/status`, {
      headers: { authorization: storySyncAuthorization({ token }) },
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    return (await response.json() as { access?: unknown }).access === "token";
  } catch {
    return false;
  }
}

/**
 * Listen on `port`, or, when another user's Story Sync holds it, on the next
 * free port within the range (data-home.md). A port held by this data home's
 * own Story Sync stays an error: one data home has one daemon.
 */
async function listen(port: number, token: string, serve: (port: number) => ReturnType<typeof Bun.serve>): Promise<ReturnType<typeof Bun.serve>> {
  const last = port === 0 ? 0 : port + STORY_SYNC_PORT_RANGE - 1;
  for (let candidate = port; ; candidate += 1) {
    try {
      return serve(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || candidate >= last) throw error;
      if (await answersToToken(`http://127.0.0.1:${candidate}`, token)) {
        throw new Error(`This data home's Story Sync is already listening on port ${candidate}`);
      }
      console.error(`[story-sync] port ${candidate} is held by another user's Story Sync or another program; trying ${candidate + 1}`);
    }
  }
}

async function startStorySyncServer(
  service: StorySyncDaemon,
  workspace: Workspace | undefined,
  options: {
    port?: number;
    hostname?: string;
    instanceID?: string;
    runtimeKind?: "persistent" | "foreground" | "cloud";
  } = {},
) {
  const instanceID = options.instanceID ?? crypto.randomUUID();
  const accounts = accountHandler(new LocalAccountService({
    trees: service.trees, events: service.events,
  }));
  const sync = syncHandler(service, { instanceID, runtimeKind: options.runtimeKind ?? (workspace ? "foreground" : "persistent") });
  const browser = browserHandler(new LocalFileService(service.trees));
  const { token } = await ensureStorySyncAccess();
  const server = await listen(options.port ?? STORY_SYNC_DEFAULT_PORT, token, (port) => Bun.serve({
    port,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request, server) {
      const url = new URL(request.url);
      try {
        assertSameOrigin(request, url);
        // A browser cannot send the token yet, so outside /v1/ it sees only the notice, never a file.
        if (!url.pathname.startsWith("/v1/") && (request.method === "GET" || request.method === "HEAD") && !isCaller(request, token)) {
          return webPlaceholder();
        }
        assertCaller(request, url, token);
        const accountResponse = await accounts(request, url);
        if (accountResponse) return accountResponse;

        const syncResponse = await sync(request, url, server);
        if (syncResponse) return syncResponse;
        return await browser(request, url);
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
          `[story-sync] Unhandled ${request.method} ${url.pathname}`,
          error instanceof Error ? error.stack ?? error.message : error,
        );
        return errorResponse("internal-error", "Story Sync could not complete the request", 500, {
          retryable: true,
        });
      }
    },
  }));
  const url = `http://${server.hostname}:${server.port}`;
  // Clients find the data home's Story Sync through this record.
  await recordStorySyncOrigin(url).catch((error) => {
    server.stop(true);
    throw error;
  });
  return { server, url, token };
}

export async function serveStorySync(
  startPath: string,
  options: StorySyncServerOptions = {},
) {
  const service = await StorySyncDaemon.open(
    startPath,
    {},
    { ...(options.syncIntervalMs !== undefined ? { syncIntervalMs: options.syncIntervalMs } : {}) },
  );
  const workspace = service.session;
  try {
    const running = await startStorySyncServer(service, workspace, options);
    const start = await realpath(startPath).catch(() => workspace.root);
    return { mode: "workspace" as const, service, workspace, ...running, start };
  } catch (error) {
    await service[Symbol.asyncDispose]();
    throw error;
  }
}

/** Serve the control surface (placements, accounts, bootstrap) without inventing a local workspace. */
export async function serveStorySyncControl(options: StorySyncServerOptions = {}) {
  // Remote browsing must not invent a filesystem session, but it still owns
  // background reconciliation for the user's explicitly tracked placements.
  const service = await StorySyncDaemon.openControl({ autoSync: true });
  try {
    return { mode: "control" as const, service, ...await startStorySyncServer(service, undefined, options) };
  } catch (error) {
    await service[Symbol.asyncDispose]();
    throw error;
  }
}
