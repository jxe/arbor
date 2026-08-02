import { resolve } from "node:path";
import { sha256 } from "@arbor/core";
import {
  AlreadyClaimedError,
  RefConflictError,
  ReservedBoundaryConflictError,
  WireAuthority,
  type AuthorityAccount,
  type AuthorityTree,
  type BoundaryKind,
  type CommunityBootstrapAccount,
  type PublicAccess,
  type TreeAccess,
} from "./authority.ts";
import { WireClient, type RemoteAccountDescriptor, type RemoteTreeDescriptor } from "./client.ts";
import { decodeWireObject, type ObjectHash } from "./objects.ts";
import { renderPublicMarkdownPage, type PublicPageChild } from "./public-page.ts";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function descriptor(origin: string, tree: AuthorityTree, access: TreeAccess = "read"): RemoteTreeDescriptor {
  const encodedPath = tree.canonicalPath === "/"
    ? ""
    : `/${tree.canonicalPath.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
  const host = new URL(origin).host;
  return {
    id: tree.id,
    canonicalPath: tree.canonicalPath,
    parentTree: tree.parentTree,
    kind: tree.kind,
    ref: tree.ref,
    publicAccess: tree.publicAccess,
    access,
    httpURL: `${origin}${encodedPath || "/"}`,
    arborURL: `arbor://${host}${encodedPath || "/"}`,
  };
}

function accountDescriptor(origin: string, authority: WireAuthority, account: AuthorityAccount): RemoteAccountDescriptor {
  const profile = account.profileTree ? authority.get(account.profileTree) : null;
  return {
    id: account.id,
    handle: account.handle,
    profileTree: account.profileTree,
    profileURL: profile ? descriptor(origin, profile, "write").arborURL : null,
    community: descriptor(origin, authority.community(), authority.canWrite(account, authority.community().id) ? "write" : "read"),
    writableProfiles: authority.writableProfiles(account).map((tree) => descriptor(origin, tree, "write")),
  };
}

function bearer(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

function accountFor(request: Request, authority: WireAuthority): AuthorityAccount | null {
  return authority.accountByToken(bearer(request));
}

function linkDigest(request: Request): string | undefined {
  const secret = request.headers.get("x-arbor-access") ?? undefined;
  return secret ? `sha256:${sha256(secret)}` : undefined;
}

function linkBootstrap(): Response {
  return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Arbor access</title><body><p>Opening shared Arbor tree…</p><script>
const secret = location.hash.startsWith("#arbor-access=") ? decodeURIComponent(location.hash.slice(14)) : "";
if (!secret) document.body.textContent = "This Arbor tree requires access.";
else fetch(location.pathname + location.search, { headers: { "x-arbor-access": secret } })
  .then(async response => {
    if (!response.ok) throw new Error("This access link is invalid or revoked.");
    document.open(); document.write(await response.text()); document.close();
  })
  .catch(error => { document.body.textContent = error.message; });
</script></body>`);
}

function escapeHTML(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function html(value: string, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "text/html; charset=utf-8");
  responseHeaders.set("cache-control", "no-cache");
  return new Response(value, {
    status,
    headers: responseHeaders,
  });
}

function bodySnapshot(body: { root?: unknown; objects?: unknown }) {
  if (typeof body.root !== "string") throw new Error("Snapshot root is required");
  const objects = WireClient.decodeObjects(body.objects);
  return { root: body.root, objects: new Map(objects.map(({ hash, bytes }) => [hash, bytes])) };
}

function requireAccount(request: Request, authority: WireAuthority): AuthorityAccount {
  const account = accountFor(request, authority);
  if (!account) throw new Error("Account authentication is required");
  return account;
}

function publicAccess(value: unknown): PublicAccess {
  if (value === "none" || value === "read" || value === "write") return value;
  throw new Error("Public access must be none, read, or write");
}

export async function serveWireHost(options: {
  dataRoot: string;
  publicOrigin: string;
  community?: {
    handle: string;
    name: string;
    firstWriter?: { handle: string; name?: string };
  };
  accounts?: CommunityBootstrapAccount[];
  port?: number;
  hostname?: string;
}) {
  const bootstrapAccounts = options.accounts ?? [];
  let publicOrigin = options.publicOrigin.replace(/\/$/, "");
  const dynamicLoopbackOrigin = /^https?:\/\/(?:127\.0\.0\.1|localhost):0$/.test(publicOrigin);
  const authority = await WireAuthority.open(resolve(options.dataRoot), {
    handle: options.community?.handle ?? "community",
    name: options.community?.name ?? "Arbor Community",
    accounts: bootstrapAccounts,
    ...(dynamicLoopbackOrigin ? {} : { communityHost: new URL(publicOrigin).host }),
    ...(options.community?.firstWriter ? { firstWriter: options.community.firstWriter } : {}),
  });
  if (!dynamicLoopbackOrigin) authority.setCommunityHost(new URL(publicOrigin).host);
  const anonymousPushes = new Map<string, { window: number; count: number }>();
  const server = Bun.serve({
    port: options.port ?? Number(process.env.PORT ?? 4318),
    hostname: options.hostname ?? "0.0.0.0",
    async fetch(request) {
      const url = new URL(request.url);
      const account = accountFor(request, authority);
      try {
        if (request.method === "GET" && url.pathname === "/.arbor/health") {
          return json({ status: "ok" });
        }
        if (request.method === "GET" && url.pathname === "/.arbor/account") {
          return json(accountDescriptor(publicOrigin, authority, requireAccount(request, authority)));
        }
        if (url.pathname === "/.arbor/trees") {
          if (request.method === "GET") {
            return json(authority.list()
              .filter((tree) => authority.canRead(account, tree.id, linkDigest(request)))
              .map((tree) => descriptor(publicOrigin, tree, authority.canWrite(account, tree.id, linkDigest(request)) ? "write" : "read")));
          }
          if (request.method === "POST") {
            const authenticated = requireAccount(request, authority);
            const body = await request.json() as {
              canonicalPath?: unknown;
              kind?: unknown;
              publicAccess?: unknown;
              profileAccess?: unknown;
              root?: unknown;
              objects?: unknown;
            };
            if (typeof body.canonicalPath !== "string") throw new Error("canonicalPath is required");
            const kind = (body.kind ?? "shared-subtree") as BoundaryKind;
            if (kind !== "shared-subtree" && kind !== "group-profile") throw new Error("Invalid tree kind");
            const rawProfileAccess = body.profileAccess ?? [];
            if (!Array.isArray(rawProfileAccess)) throw new Error("profileAccess must be an array");
            const profileAccess = rawProfileAccess.map((entry) => {
              if (
                !entry || typeof entry !== "object"
                || typeof (entry as { locator?: unknown }).locator !== "string"
                || !["read", "write"].includes(String((entry as { access?: unknown }).access))
              ) throw new Error("Invalid profile access rule");
              const locator = new URL((entry as { locator: string }).locator);
              if (locator.host !== new URL(publicOrigin).host) throw new Error("Profile access must use this community");
              const profile = authority.resolve(locator.pathname)?.tree;
              if (!profile || !["person-profile", "group-profile"].includes(profile.kind)) {
                throw new Error("Profile access rule does not resolve to a profile");
              }
              return { profile: profile.id, access: (entry as { access: TreeAccess }).access };
            });
            const tree = await authority.create(
              authenticated,
              body.canonicalPath,
              kind,
              bodySnapshot(body),
              publicAccess(body.publicAccess ?? "none"),
              profileAccess,
            );
            return json(descriptor(publicOrigin, tree, "write"), 201);
          }
          return new Response("Method not allowed", { status: 405 });
        }
        const claim = /^\/\.arbor\/claims\/([a-z0-9][a-z0-9-]{0,62})$/.exec(url.pathname);
        if (claim && request.method === "POST") {
          const body = await request.json() as { root?: unknown; objects?: unknown };
          const result = await authority.claim(claim[1]!, bodySnapshot(body));
          return json({
            accountToken: result.token,
            account: accountDescriptor(publicOrigin, authority, result.account),
            tree: descriptor(publicOrigin, result.tree, "write"),
          }, 201);
        }
        const access = /^\/\.arbor\/trees\/([^/]+)\/access$/.exec(url.pathname);
        if (access) {
          const treeID = decodeURIComponent(access[1]!);
          if (request.method === "GET") {
            const authenticated = requireAccount(request, authority);
            if (!authority.canAdminister(authenticated, treeID)) return new Response("Not found", { status: 404 });
            return json(authority.accessEntries(treeID)
              .filter((entry) => entry.subjectKind !== "profile" || entry.subject !== authenticated.profileTree)
              .map((entry) => {
              if (entry.subjectKind === "profile") {
                const profile = authority.get(entry.subject);
                return {
                  id: entry.id,
                  kind: "profile",
                  access: entry.access,
                  ...(profile ? { locator: descriptor(publicOrigin, profile).arborURL } : {}),
                };
              }
              return { id: entry.id, kind: entry.subjectKind, access: entry.access };
              }));
          }
          if (request.method === "POST") {
            const authenticated = requireAccount(request, authority);
            const body = await request.json() as {
              subject?: { kind?: unknown; locator?: unknown; digest?: unknown; id?: unknown };
              access?: unknown;
            };
            const level = body.access as TreeAccess | "none";
            if (!["none", "read", "write"].includes(level)) throw new Error("Invalid access");
            if (body.subject?.kind === "all" && level === "none") {
              return json(descriptor(
                publicOrigin,
                authority.clearAccess(authenticated, treeID),
                "write",
              ));
            }
            if (body.subject?.kind === "everyone") {
              return json(descriptor(
                publicOrigin,
                authority.setAccess(authenticated, treeID, "everyone", "everyone", level),
                "write",
              ));
            }
            if (body.subject?.kind === "profile" && typeof body.subject.locator === "string") {
              const profile = authority.resolve(new URL(body.subject.locator).pathname)?.tree;
              if (!profile || !["person-profile", "group-profile"].includes(profile.kind)) {
                throw new Error("Profile locator does not resolve to a profile");
              }
              return json(descriptor(
                publicOrigin,
                authority.setAccess(authenticated, treeID, "profile", profile.id, level),
                "write",
              ));
            }
            if (body.subject?.kind === "link" && typeof body.subject.digest === "string") {
              return json(descriptor(
                publicOrigin,
                authority.setAccess(authenticated, treeID, "link", body.subject.digest, level),
                "write",
              ));
            }
            if (body.subject?.kind === "entry" && typeof body.subject.id === "string" && level === "none") {
              return json(descriptor(
                publicOrigin,
                authority.removeAccess(authenticated, treeID, body.subject.id),
                "write",
              ));
            }
            throw new Error("Invalid access subject");
          }
          return new Response("Method not allowed", { status: 405 });
        }
        const wellKnown = url.pathname === "/.well-known/arbor"
          ? "/"
          : url.pathname.startsWith("/.well-known/arbor/")
            ? decodeURIComponent(url.pathname.slice("/.well-known/arbor".length))
            : null;
        if (wellKnown !== null && request.method === "GET") {
          const resolved = authority.resolve(wellKnown);
          if (!resolved || !authority.canRead(account, resolved.tree.id, linkDigest(request))) return new Response("Not found", { status: 404 });
          return json({
            ...descriptor(
              publicOrigin,
              resolved.tree,
              authority.canWrite(account, resolved.tree.id, linkDigest(request)) ? "write" : "read",
            ),
            path: resolved.path,
          });
        }
        const ref = /^\/\.arbor\/trees\/([^/]+)\/ref$/.exec(url.pathname);
        if (ref && request.method === "GET") {
          const tree = authority.get(decodeURIComponent(ref[1]!));
          if (!tree || !authority.canRead(account, tree.id, linkDigest(request))) return new Response("Not found", { status: 404 });
          return json(descriptor(
            publicOrigin,
            tree,
            authority.canWrite(account, tree.id, linkDigest(request)) ? "write" : "read",
          ));
        }
        const push = /^\/\.arbor\/trees\/([^/]+)\/push$/.exec(url.pathname);
        if (push && request.method === "POST") {
          const tree = authority.get(decodeURIComponent(push[1]!));
          if (!tree || !authority.canWrite(account, tree.id, linkDigest(request))) return new Response("Not found", { status: 404 });
          if (!account) {
            const key = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anonymous";
            const window = Math.floor(Date.now() / 60_000);
            const usage = anonymousPushes.get(key);
            if (usage?.window === window && usage.count >= 60) return json({ error: "rate-limit" }, 429);
            anonymousPushes.set(key, usage?.window === window
              ? { window, count: usage.count + 1 }
              : { window, count: 1 });
          }
          const body = await request.json() as { expected?: unknown; root?: unknown; objects?: unknown };
          if (typeof body.expected !== "string" || typeof body.root !== "string") throw new Error("Invalid push");
          const updated = await authority.push(tree.id, {
            expected: body.expected,
            root: body.root,
            objects: WireClient.decodeObjects(body.objects),
          }, account, linkDigest(request));
          return json(descriptor(publicOrigin, updated, "write"));
        }
        const watch = /^\/\.arbor\/trees\/([^/]+)\/watch$/.exec(url.pathname);
        if (watch && request.method === "GET") {
          const tree = authority.get(decodeURIComponent(watch[1]!));
          if (!tree || !authority.canRead(account, tree.id, linkDigest(request))) return new Response("Not found", { status: 404 });
          const encoder = new TextEncoder();
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(`event: ref\ndata: ${JSON.stringify(descriptor(publicOrigin, tree, authority.canWrite(account, tree.id, linkDigest(request)) ? "write" : "read"))}\n\n`));
              const stop = authority.subscribe(tree.id, (updated) => {
                controller.enqueue(encoder.encode(`event: ref\ndata: ${JSON.stringify(descriptor(publicOrigin, updated, authority.canWrite(account, updated.id, linkDigest(request)) ? "write" : "read"))}\n\n`));
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
          if (!(await authority.isReadableObject(hash, account, linkDigest(request)))) return new Response("Not found", { status: 404 });
          const bytes = await authority.object(hash);
          return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
            headers: { "content-type": "application/vnd.ipld.dag-cbor", "cache-control": "public, immutable" },
          });
        }
        if (request.method === "GET" && !url.pathname.startsWith("/.")) {
          const pendingProfile = /^\/~([a-z0-9][a-z0-9-]{0,62})\/?$/.exec(decodeURIComponent(url.pathname));
          if (pendingProfile && authority.isReservedHandle(pendingProfile[1]!)) {
            const profileURL = `${publicOrigin}/~${pendingProfile[1]!}`;
            return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>~${escapeHTML(pendingProfile[1]!)}</title><style>body{max-width:620px;margin:72px auto;padding:0 24px;font:16px/1.55 system-ui;color:#292823}code{display:block;padding:12px;background:#f4f2ec;border-radius:8px}</style><h1>~${escapeHTML(pendingProfile[1]!)}</h1><p>This is an empty profile reserved by the ${escapeHTML(authority.communityHandle())} community. It has not been claimed.</p><p>Open it in Arbor to claim it:</p><code>arbor browse ${escapeHTML(profileURL)}</code><p>The first successful claim wins.</p>`, 200, { "x-arbor-profile-state": "reserved" });
          }
          const resolved = authority.resolve(decodeURIComponent(url.pathname));
          if (!resolved) return new Response("Not found", { status: 404 });
          if (!authority.canRead(account, resolved.tree.id, linkDigest(request))) {
            return request.headers.get("accept")?.includes("text/html")
              ? linkBootstrap()
              : new Response("Not found", { status: 404 });
          }
          const parts = resolved.path.split("/").filter(Boolean);
          let tree = resolved.tree;
          let hash = tree.ref;
          let objectName = parts.at(-1) ?? tree.canonicalPath.split("/").at(-1) ?? "Arbor";
          for (const [index, part] of parts.entries()) {
            const current = decodeWireObject(await authority.object(hash));
            if (current.type !== "directory") return new Response("Not found", { status: 404 });
            const entry = current.entries.find((candidate) => candidate.name === part)
              ?? current.entries.find((candidate) => candidate.name === `${part}.md`);
            if (!entry) return new Response("Not found", { status: 404 });
            if (index === parts.length - 1) objectName = entry.name;
            if (entry.tree) {
              const nested = authority.get(entry.tree);
              if (!nested || !authority.canRead(account, nested.id, linkDigest(request))) return new Response("Not found", { status: 404 });
              tree = nested;
              hash = tree.ref;
              continue;
            }
            if (!entry.hash) return new Response("Not found", { status: 404 });
            hash = entry.hash;
            if (index < parts.length - 1) continue;
          }
          const objectValue = decodeWireObject(await authority.object(hash));
          if (objectValue.type === "file") {
            const body = new TextDecoder().decode(objectValue.bytes);
            if (objectName.endsWith(".md")) {
              if (request.headers.get("accept")?.includes("text/markdown")) {
                return new Response(objectValue.bytes.buffer.slice(
                  objectValue.bytes.byteOffset,
                  objectValue.bytes.byteOffset + objectValue.bytes.byteLength,
                ) as ArrayBuffer, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" } });
              }
              return html(renderPublicMarkdownPage({
                source: body,
                fallbackTitle: objectName.slice(0, -3),
                origin: publicOrigin,
                treeCanonicalPath: tree.canonicalPath,
                documentPath: resolved.path,
              }));
            }
            return new Response(objectValue.bytes.buffer.slice(
              objectValue.bytes.byteOffset,
              objectValue.bytes.byteOffset + objectValue.bytes.byteLength,
            ) as ArrayBuffer);
          }
          const prefix = url.pathname.replace(/\/$/, "");
          const index = objectValue.entries.find((entry) => entry.name === "_index.md" && entry.hash);
          const indexObject = index?.hash ? decodeWireObject(await authority.object(index.hash)) : null;
          const source = indexObject?.type === "file" ? new TextDecoder().decode(indexObject.bytes) : "";
          if (request.headers.get("accept")?.includes("text/markdown")) {
            return new Response(source, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" } });
          }
          const children = (await Promise.all(objectValue.entries
            .filter((entry) => entry.name !== "_index.md")
            .map(async (entry): Promise<PublicPageChild | null> => {
              if (entry.tree) {
                const nested = authority.get(entry.tree);
                if (!nested || !authority.canRead(account, nested.id, linkDigest(request))) return null;
              }
              const object = entry.hash ? decodeWireObject(await authority.object(entry.hash)) : null;
              const markdown = object?.type === "file" && entry.name.endsWith(".md");
              const publicName = markdown ? entry.name.slice(0, -3) : entry.name;
              return {
                name: publicName,
                href: `${prefix}/${encodeURIComponent(publicName)}${url.search}`,
                kind: entry.tree || object?.type === "directory" ? "folder" : markdown ? "document" : "file",
              };
            }))).filter((child): child is PublicPageChild => child !== null);
          return html(renderPublicMarkdownPage({
            source,
            fallbackTitle: parts.at(-1) ?? tree.canonicalPath.split("/").filter(Boolean).at(-1) ?? authority.communityHandle(),
            origin: publicOrigin,
            treeCanonicalPath: tree.canonicalPath,
            documentPath: resolved.path,
            children,
          }));
        }
        return new Response("Not found", { status: 404 });
      } catch (error) {
        if (error instanceof RefConflictError) return json({ error: "ref-conflict", current: error.current }, 409);
        if (error instanceof AlreadyClaimedError) return json({ error: "already-claimed", handle: error.handle }, 409);
        if (error instanceof ReservedBoundaryConflictError) {
          return json({ error: "reserved-boundary", path: error.path, tree: error.tree }, 409);
        }
        const message = error instanceof Error ? error.message : String(error);
        const status = /authentication|not allowed/i.test(message) ? 403 : 400;
        return json({ error: message }, status);
      }
    },
  });
  if (dynamicLoopbackOrigin) {
    publicOrigin = `${publicOrigin.slice(0, publicOrigin.lastIndexOf(":"))}:${server.port}`;
  }
  if (dynamicLoopbackOrigin) authority.setCommunityHost(new URL(publicOrigin).host, true);
  return { authority, server, url: publicOrigin };
}
