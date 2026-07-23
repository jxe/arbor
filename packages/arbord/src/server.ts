import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { NodeWriteRequest } from "@arbor/core";
import { PathEscapeError } from "@arbor/core";
import { FsConflictError, type FsImportEntry, type FsMutation, type FsMutationRequest } from "@arbor/fs";
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

function assertSameOrigin(request: Request, url: URL): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    throw new FsConflictError({ code: "unsafe-path", path: url.pathname }, "Cross-origin filesystem mutations are not allowed");
  }
}

function decodeMutationRequest(value: unknown): FsMutationRequest {
  if (!value || typeof value !== "object" || !Array.isArray((value as { operations?: unknown }).operations)) {
    throw new FsConflictError({ code: "unsupported-entry", path: "/" }, "Expected an operations array");
  }
  const operations = (value as { operations: unknown[] }).operations.map((rawOperation) => {
    if (!rawOperation || typeof rawOperation !== "object" || typeof (rawOperation as { op?: unknown }).op !== "string") {
      throw new FsConflictError({ code: "unsupported-entry", path: "/" }, "Each mutation operation must be an object with an op");
    }
    const operation = rawOperation as FsMutation & { bytes?: unknown };
    if (operation.op !== "createFile") return operation as FsMutation;
    const raw = operation.bytes;
    if (!Array.isArray(raw) || !raw.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      throw new FsConflictError({ code: "unsupported-entry", path: operation.path }, "createFile bytes must be a byte array");
    }
    return { ...operation, bytes: new Uint8Array(raw) } as FsMutation;
  });
  return { operations };
}

async function decodeImport(request: Request): Promise<{ destination: string; entries: FsImportEntry[] }> {
  const form = await request.formData();
  const destination = String(form.get("destination") ?? "/");
  const rawManifest = form.get("manifest");
  if (typeof rawManifest !== "string") {
    throw new FsConflictError({ code: "unsupported-entry", path: destination }, "Import manifest is required");
  }
  let manifest: Array<{ path: string; kind: "file" | "directory"; field?: string }>;
  try { manifest = JSON.parse(rawManifest) as typeof manifest; }
  catch { throw new FsConflictError({ code: "unsupported-entry", path: destination }, "Import manifest is not valid JSON"); }
  if (!Array.isArray(manifest)) {
    throw new FsConflictError({ code: "unsupported-entry", path: destination }, "Import manifest must be an array");
  }
  const entries: FsImportEntry[] = [];
  for (const item of manifest) {
    if (!item || typeof item.path !== "string" || (item.kind !== "file" && item.kind !== "directory")) {
      throw new FsConflictError({ code: "unsupported-entry", path: destination }, "Import manifest contains an unsupported entry");
    }
    if (item.kind === "directory") {
      entries.push({ path: item.path, kind: "directory" });
      continue;
    }
    const file = item.field ? form.get(item.field) : null;
    if (!(file instanceof File)) {
      throw new FsConflictError({ code: "unsupported-entry", path: item.path }, `Missing imported file bytes for ${item.path}`);
    }
    entries.push({ path: item.path, kind: "file", bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  return { destination, entries };
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
        assertSameOrigin(request, url);
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
        if (request.method === "POST" && url.pathname === "/v/fs/mutate") {
          return json(await workspace.mutate(decodeMutationRequest(await request.json())));
        }
        if (request.method === "POST" && url.pathname === "/v/fs/import") {
          const input = await decodeImport(request);
          return json(await workspace.import(input.destination, input.entries));
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
        if (error instanceof FsConflictError) return json({ error: error.message, conflict: error.details }, 409);
        if (error instanceof PathEscapeError) return json({ error: error.message }, 400);
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    },
  });
  return { workspace, server, url: `http://${server.hostname}:${server.port}` };
}
