import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { NodeWriteRequest } from "@arbor/core";
import { PathEscapeError } from "@arbor/core";
import { RevisionConflictError, Workspace } from "./workspace.ts";

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

function routePath(pathname: string, prefix: string): string {
  return decodeURIComponent(pathname.slice(prefix.length)) || "/";
}

export async function serveWorkspace(root: string, options: { port?: number; hostname?: string } = {}) {
  const workspace = await Workspace.open(root);
  const renderRoot = join(import.meta.dir, "../../render/dist");
  const server = Bun.serve({
    port: options.port ?? 4317,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (request.method === "GET" && url.pathname.startsWith("/v/tree")) return json(await workspace.node(routePath(url.pathname, "/v/tree")));
        if (request.method === "GET" && url.pathname.startsWith("/v/collection")) {
          const cursor = Number(url.searchParams.get("cursor") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 100);
          return json(await workspace.collection(routePath(url.pathname, "/v/collection"), cursor, limit, url.searchParams.get("table") ?? undefined));
        }
        if (request.method === "GET" && url.pathname === "/v/search") return json(workspace.search(url.searchParams.get("q") ?? ""));
        if (request.method === "GET" && url.pathname === "/v/events") {
          return new Response(workspace.events.stream(request.signal), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
        }
        if (request.method === "PUT" && url.pathname.startsWith("/v/node")) {
          return json(await workspace.write(routePath(url.pathname, "/v/node"), await request.json() as NodeWriteRequest));
        }
        if (request.method === "DELETE" && url.pathname.startsWith("/v/node")) return json(await workspace.delete(routePath(url.pathname, "/v/node")));
        if (request.method === "POST" && url.pathname === "/v/restore") return json(await workspace.restore((await request.json() as { path: string }).path));
        if (request.method === "POST" && url.pathname === "/v/assets") {
          const bytes = new Uint8Array(await request.arrayBuffer());
          return json(await workspace.addAsset(url.searchParams.get("directory") ?? "/", request.headers.get("x-filename") ?? "asset.bin", bytes));
        }
        if (request.method === "GET" && url.pathname === "/v/recovery") return json(await workspace.recovery(url.searchParams.get("path") ?? "/"));
        if (request.method === "POST" && url.pathname === "/v/recovery/restore") {
          const input = await request.json() as { path: string; hash: string };
          return json(await workspace.restoreBlock(input.path, input.hash));
        }
        if (request.method === "GET" && (url.pathname.startsWith("/Assets/") || url.pathname.startsWith("/render/Assets/"))) {
          const assetPath = url.pathname.replace(/^\/render/, "");
          const node = await workspace.node(assetPath);
          if (node.kind !== "file") return json({ error: "Asset not found" }, 404);
          const absolute = join(workspace.root, assetPath);
          return new Response(await readFile(absolute), { headers: { "content-type": MIME[extname(absolute)] ?? "application/octet-stream" } });
        }
        if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
        let assetPath = url.pathname === "/" || url.pathname.startsWith("/render/") ? "index.html" : url.pathname.slice(1);
        let absolute = join(renderRoot, assetPath);
        if (!existsSync(absolute)) absolute = join(renderRoot, "index.html");
        if (!existsSync(absolute)) return new Response("TreeHopper web is not built. Run `bun run build:web`.", { status: 503 });
        return new Response(await readFile(absolute), { headers: { "content-type": MIME[extname(absolute)] ?? "application/octet-stream" } });
      } catch (error) {
        if (error instanceof RevisionConflictError) return json({ error: error.message, current: error.current }, 409);
        if (error instanceof PathEscapeError) return json({ error: error.message }, 400);
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    },
  });
  return { workspace, server, url: `http://${server.hostname}:${server.port}` };
}
