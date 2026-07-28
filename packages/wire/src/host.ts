import { resolve } from "node:path";
import { RefConflictError, WireAuthority, type AuthorityTree, type PublicationMode } from "./authority.ts";
import { WireClient, type RemoteTreeDescriptor } from "./client.ts";
import { decodeWireObject, type ObjectHash } from "./objects.ts";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function descriptor(origin: string, tree: AuthorityTree): RemoteTreeDescriptor {
  return {
    id: tree.id,
    slug: tree.slug,
    ref: tree.ref,
    publication: tree.publication,
    httpURL: `${origin}/${tree.slug}`,
    arborURL: `arbor://${new URL(origin).host}/${tree.slug}`,
  };
}

function owner(request: Request, token: string): boolean {
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function escapeHTML(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function html(value: string, status = 200): Response {
  return new Response(value, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}

export async function serveWireHost(options: {
  dataRoot: string;
  ownerToken: string;
  publicOrigin: string;
  port?: number;
  hostname?: string;
}) {
  const authority = await WireAuthority.open(resolve(options.dataRoot));
  let publicOrigin = options.publicOrigin.replace(/\/$/, "");
  const anonymousPushes = new Map<string, { window: number; count: number }>();
  const server = Bun.serve({
    port: options.port ?? Number(process.env.PORT ?? 4318),
    hostname: options.hostname ?? "0.0.0.0",
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (request.method === "GET" && url.pathname === "/.arbor/health") {
          return json({ status: "ok" });
        }
        if (url.pathname === "/.arbor/admin/trees") {
          if (!owner(request, options.ownerToken)) return new Response("Not found", { status: 404 });
          if (request.method === "GET") return json(authority.list().map((tree) => descriptor(publicOrigin, tree)));
          if (request.method === "POST") {
            const body = await request.json() as { slug?: unknown; root?: unknown; objects?: unknown };
            if (typeof body.slug !== "string" || typeof body.root !== "string") return json({ error: "Invalid tree" }, 400);
            const objects = WireClient.decodeObjects(body.objects);
            const map = new Map(objects.map(({ hash, bytes }) => [hash, bytes]));
            const tree = await authority.create(body.slug, { root: body.root, objects: map });
            return json(descriptor(publicOrigin, tree), 201);
          }
          return new Response("Method not allowed", { status: 405 });
        }
        const adminTree = /^\/\.arbor\/admin\/trees\/([^/]+)$/.exec(url.pathname);
        if (adminTree) {
          if (!owner(request, options.ownerToken)) return new Response("Not found", { status: 404 });
          if (request.method !== "PATCH") return new Response("Method not allowed", { status: 405 });
          const body = await request.json() as { publication?: PublicationMode };
          if (!body.publication) return json({ error: "Missing publication" }, 400);
          return json(descriptor(publicOrigin, authority.setPublication(decodeURIComponent(adminTree[1]!), body.publication)));
        }
        const wellKnown = /^\/\.well-known\/arbor\/([^/]+)$/.exec(url.pathname);
        if (wellKnown && request.method === "GET") {
          const tree = authority.bySlug(decodeURIComponent(wellKnown[1]!));
          if (!tree || (tree.publication === "private" && !owner(request, options.ownerToken))) {
            return new Response("Not found", { status: 404 });
          }
          return json(descriptor(publicOrigin, tree));
        }
        const ref = /^\/\.arbor\/trees\/([^/]+)\/ref$/.exec(url.pathname);
        if (ref && request.method === "GET") {
          const tree = authority.get(decodeURIComponent(ref[1]!));
          if (!tree || (tree.publication === "private" && !owner(request, options.ownerToken))) {
            return new Response("Not found", { status: 404 });
          }
          return json(descriptor(publicOrigin, tree));
        }
        const push = /^\/\.arbor\/trees\/([^/]+)\/push$/.exec(url.pathname);
        if (push && request.method === "POST") {
          const tree = authority.get(decodeURIComponent(push[1]!));
          if (!tree || (!owner(request, options.ownerToken) && tree.publication !== "public-write")) {
            return new Response("Not found", { status: 404 });
          }
          if (!owner(request, options.ownerToken)) {
            const key = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anonymous";
            const window = Math.floor(Date.now() / 60_000);
            const usage = anonymousPushes.get(key);
            if (usage?.window === window && usage.count >= 60) return json({ error: "rate-limit" }, 429);
            anonymousPushes.set(key, usage?.window === window
              ? { window, count: usage.count + 1 }
              : { window, count: 1 });
          }
          const body = await request.json() as { expected?: unknown; root?: unknown; objects?: unknown };
          if (typeof body.expected !== "string" || typeof body.root !== "string") return json({ error: "Invalid push" }, 400);
          const updated = await authority.push(tree.id, {
            expected: body.expected,
            root: body.root,
            objects: WireClient.decodeObjects(body.objects),
          });
          return json(descriptor(publicOrigin, updated));
        }
        const watch = /^\/\.arbor\/trees\/([^/]+)\/watch$/.exec(url.pathname);
        if (watch && request.method === "GET") {
          const tree = authority.get(decodeURIComponent(watch[1]!));
          if (!tree || (tree.publication === "private" && !owner(request, options.ownerToken))) {
            return new Response("Not found", { status: 404 });
          }
          const encoder = new TextEncoder();
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(`event: ref\ndata: ${JSON.stringify(descriptor(publicOrigin, tree))}\n\n`));
              const stop = authority.subscribe(tree.id, (updated) => {
                controller.enqueue(encoder.encode(`event: ref\ndata: ${JSON.stringify(descriptor(publicOrigin, updated))}\n\n`));
              });
              request.signal.addEventListener("abort", () => {
                stop();
                try { controller.close(); } catch {}
              }, { once: true });
            },
          }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
        }
        const object = /^\/\.arbor\/objects\/(sha256:[a-f0-9]{64})$/.exec(url.pathname);
        if (object && request.method === "GET") {
          const hash = object[1] as ObjectHash;
          if (!owner(request, options.ownerToken) && !(await authority.isPublicObject(hash))) {
            return new Response("Not found", { status: 404 });
          }
          const bytes = await authority.object(hash);
          const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          return new Response(body, { headers: { "content-type": "application/vnd.ipld.dag-cbor", "cache-control": "public, immutable" } });
        }
        const published = /^\/([^/.][^/]*)(\/.*)?$/.exec(url.pathname);
        if (published && request.method === "GET") {
          const tree = authority.bySlug(decodeURIComponent(published[1]!));
          if (!tree || tree.publication === "private") return new Response("Not found", { status: 404 });
          const requested = decodeURIComponent(published[2] || "/");
          const parts = requested.split("/").filter(Boolean);
          let hash = tree.ref;
          for (const part of parts) {
            const current = decodeWireObject(await authority.object(hash));
            if (current.type !== "directory") return new Response("Not found", { status: 404 });
            const entry = current.entries.find((candidate) => candidate.name === part);
            if (!entry?.hash || entry.tree) return new Response("Not found", { status: 404 });
            hash = entry.hash;
          }
          const object = decodeWireObject(await authority.object(hash));
          if (object.type === "file") {
            const name = parts.at(-1) ?? tree.slug;
            const body = new TextDecoder().decode(object.bytes);
            if (name.endsWith(".md")) {
              return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHTML(name)}</title><style>body{max-width:760px;margin:64px auto;padding:0 24px;font:16px/1.55 system-ui;color:#292823}pre{white-space:pre-wrap;font:inherit}</style><nav><a href="/${encodeURIComponent(tree.slug)}">← ${escapeHTML(tree.slug)}</a></nav><pre>${escapeHTML(body)}</pre>`);
            }
            const rawBody = object.bytes.buffer.slice(
              object.bytes.byteOffset,
              object.bytes.byteOffset + object.bytes.byteLength,
            ) as ArrayBuffer;
            return new Response(rawBody, { headers: { "content-type": "application/octet-stream", "cache-control": "no-cache" } });
          }
          const prefix = `/${encodeURIComponent(tree.slug)}${requested === "/" ? "" : requested.replace(/\/$/, "")}`;
          const entries = object.entries.map((entry) => entry.tree
            ? `<li><span>${escapeHTML(entry.name)} — independent tree</span></li>`
            : `<li><a href="${prefix}/${encodeURIComponent(entry.name)}">${escapeHTML(entry.name)}</a></li>`
          ).join("");
          const access = tree.publication === "public-write"
            ? "<p><strong>Public read/write.</strong> Anonymous clients may submit compare-and-swap pushes through the Arbor wire endpoint.</p>"
            : "<p>Public read-only.</p>";
          return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHTML(tree.slug)}</title><style>body{max-width:760px;margin:64px auto;padding:0 24px;font:16px/1.55 system-ui;color:#292823}a{color:inherit}li{margin:8px 0}p{color:#6d6b63}</style><h1>${escapeHTML(parts.at(-1) ?? tree.slug)}</h1>${access}<ul>${entries}</ul>`);
        }
        return new Response("Not found", { status: 404 });
      } catch (error) {
        if (error instanceof RefConflictError) return json({ error: "ref-conflict", current: error.current }, 409);
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    },
  });
  if (/^https?:\/\/(?:127\.0\.0\.1|localhost):0$/.test(publicOrigin)) {
    publicOrigin = `${publicOrigin.slice(0, publicOrigin.lastIndexOf(":"))}:${server.port}`;
  }
  return { authority, server, url: publicOrigin };
}
