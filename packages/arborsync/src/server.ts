import { syncHandler } from "./sync-http.ts";
import { errorResponse, assertSameOrigin } from "./http.ts";
import { accountHandler } from "./account-http.ts";
import { LocalAccountService } from "./account-service.ts";
import { browserHandler } from "./browser-http.ts";
import { LocalFileService } from "./local-files.ts";
import { realpath } from "node:fs/promises";
import { PathEscapeError } from "@overstory/protocol";
import { ResyncRequiredError } from "./events.ts";
import { ArborSyncDaemon } from "./service.ts";
import { ProtocolError, type Workspace } from "./workspace.ts";

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
  const accounts = accountHandler(new LocalAccountService({
    trees: service.trees, events: service.events,
  }));
  const sync = syncHandler(service, { instanceID, runtimeKind: options.runtimeKind ?? (workspace ? "foreground" : "persistent") });
  const browser = browserHandler(new LocalFileService(service.trees));
  const server = Bun.serve({
    port: options.port ?? 4317,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request, server) {
      const url = new URL(request.url);
      try {
        assertSameOrigin(request, url);
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
