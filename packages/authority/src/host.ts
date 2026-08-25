import { resolve } from "node:path";
import { sha256 } from "@arbor/core";
import {
  AlreadyClaimedError,
  RefConflictError,
  ReservedBoundaryConflictError,
  UpdateProtocolError,
  WireAuthority,
  type AuthorityAccount,
  type AuthorityTree,
  type CommunityBootstrapAccount,
} from "./authority.ts";
import {
  decodeObjectEnvelopes,
  decodeUpdateRequestJSON,
  decodeWireObject,
  resolveWireLogicalNode,
  type BoundaryKind,
  type AcceptedUpdate,
  type ObjectHash,
  type PublicAccess,
  type RemoteAccountDescriptor,
  type RemoteTreeDescriptor,
  type TreeAccess,
} from "@arbor/wire";
import { renderPublicMarkdownPage, type PublicPageChild } from "./public-page.ts";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function wireError(
  error: string,
  message: string,
  status: number,
  retryable = false,
  details: Record<string, unknown> = {},
): Response {
  return json({ error, message, retryable, ...details }, status);
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

function descriptorWithUpdate(
  origin: string,
  authority: WireAuthority,
  tree: AuthorityTree,
  access: TreeAccess = "read",
): RemoteTreeDescriptor {
  return { ...descriptor(origin, tree, access), update: authority.currentUpdate(tree.id)?.id };
}

function watchDescriptor(
  origin: string,
  tree: AuthorityTree,
  update: AcceptedUpdate,
  access: TreeAccess,
  requestDigest?: ObjectHash | null,
): RemoteTreeDescriptor {
  return {
    ...descriptor(origin, { ...tree, ref: update.root }, access),
    update: update.id,
    ...(requestDigest ? { requestDigest } : {}),
  };
}

function updateJSON(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const encodeSnapshot = (snapshot: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: Uint8Array }> }) => ({
    root: snapshot.root,
    objects: snapshot.objects.map(({ hash, bytes }) => ({ hash, bytes: Buffer.from(bytes).toString("base64") })),
  });
  if (!("error" in value) || (value as { error?: unknown }).error !== "conflict") {
    const result = value as { snapshot?: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: Uint8Array }> } };
    return result.snapshot ? { ...result, snapshot: encodeSnapshot(result.snapshot) } : value;
  }
  const conflict = value as {
    error: "conflict";
    current: unknown;
    base: ObjectHash;
    candidate: ObjectHash;
    conflicts: unknown[];
    draft: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: Uint8Array }> };
    currentSnapshot?: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: Uint8Array }> };
  };
  return {
    ...conflict,
    draft: encodeSnapshot(conflict.draft),
    ...(conflict.currentSnapshot ? { currentSnapshot: encodeSnapshot(conflict.currentSnapshot) } : {}),
  };
}

function accountDescriptor(origin: string, authority: WireAuthority, account: AuthorityAccount): RemoteAccountDescriptor {
  const profile = account.profileTree ? authority.get(account.profileTree) : null;
  return {
    id: account.id,
    handle: account.handle,
    profileTree: account.profileTree,
    profileURL: profile ? descriptorWithUpdate(origin, authority, profile, "write").arborURL : null,
    community: descriptorWithUpdate(origin, authority, authority.community(), authority.canWrite(account, authority.community().id) ? "write" : "read"),
    writableProfiles: authority.writableProfiles(account).map((tree) => descriptorWithUpdate(origin, authority, tree, "write")),
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
  const objects = decodeObjectEnvelopes(body.objects);
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
  const pairingClaimAttempts = new Map<string, number[]>();
  const server = Bun.serve({
    port: options.port ?? Number(process.env.PORT ?? 4318),
    hostname: options.hostname ?? "0.0.0.0",
    async fetch(request) {
      const url = new URL(request.url);
      const authentication = authority.authenticateToken(bearer(request));
      const account = authentication?.account ?? null;
      try {
        if (request.method === "GET" && url.pathname === "/.arbor/health") {
          try {
            await authority.verifyIntegrity();
            return json({ status: "ok" });
          } catch (error) {
            console.error("Arbor authority integrity check failed", error);
            return wireError("internal-error", "Authority integrity check failed", 503, true);
          }
        }
        if (request.method === "GET" && url.pathname === "/.arbor/account") {
          return json(accountDescriptor(publicOrigin, authority, requireAccount(request, authority)));
        }
        if (url.pathname === "/.arbor/pairings" && request.method === "POST") {
          return json(authority.createPairing(requireAccount(request, authority)), 201);
        }
        const pairingClaim = /^\/\.arbor\/pairings\/([^/]+)\/claim$/.exec(url.pathname);
        if (pairingClaim && request.method === "POST") {
          const pairingID = decodeURIComponent(pairingClaim[1]!);
          const address = request.headers.get("cf-connecting-ip")
            ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
            ?? "unknown";
          const rateKey = `${address}:${pairingID}`;
          const cutoff = Date.now() - 10 * 60 * 1000;
          const recent = (pairingClaimAttempts.get(rateKey) ?? []).filter((attempt) => attempt > cutoff);
          if (recent.length >= 10) return wireError("rate-limited", "Too many pairing claims", 429, true);
          recent.push(Date.now());
          pairingClaimAttempts.set(rateKey, recent);
          const body = await request.json() as { secret?: unknown; label?: unknown };
          if (typeof body.secret !== "string" || typeof body.label !== "string") throw new Error("Pairing claim requires secret and label");
          const claimed = authority.claimPairing(pairingID, body.secret, body.label);
          return json({ deviceToken: claimed.token, device: claimed.device, confirmationCode: claimed.confirmationCode }, 201);
        }
        if (url.pathname === "/.arbor/devices" && request.method === "GET") {
          return json(authority.devices(requireAccount(request, authority)));
        }
        const device = /^\/\.arbor\/devices\/([^/]+)$/.exec(url.pathname);
        if (device && request.method === "DELETE") {
          return json(authority.revokeDevice(requireAccount(request, authority), decodeURIComponent(device[1]!)));
        }
        if (url.pathname === "/.arbor/trees") {
          if (request.method === "GET") {
            return json(authority.list()
              .filter((tree) => authority.canRead(account, tree.id, linkDigest(request)))
              .map((tree) => descriptorWithUpdate(publicOrigin, authority, tree, authority.canWrite(account, tree.id, linkDigest(request)) ? "write" : "read")));
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
              authentication?.subject,
            );
            return json(descriptorWithUpdate(publicOrigin, authority, tree, "write"), 201);
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
            tree: descriptorWithUpdate(publicOrigin, authority, result.tree, "write"),
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
            ...descriptorWithUpdate(
              publicOrigin,
              authority,
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
          return json(descriptorWithUpdate(
            publicOrigin,
            authority,
            tree,
            authority.canWrite(account, tree.id, linkDigest(request)) ? "write" : "read",
          ));
        }
        const currentSnapshot = /^\/\.arbor\/trees\/([^/]+)\/snapshot$/.exec(url.pathname);
        if (currentSnapshot && request.method === "GET") {
          const treeID = decodeURIComponent(currentSnapshot[1]!);
          const tree = authority.get(treeID);
          if (!tree || !authority.canRead(account, tree.id, linkDigest(request))) return new Response("Not found", { status: 404 });
          const current = authority.currentUpdate(tree.id);
          if (!current) return wireError("not-ready", "Tree has no accepted update", 409, true);
          const snapshot = await authority.snapshotForUpdate(tree.id, current.id);
          return json({
            tree: {
              ...descriptor(
                publicOrigin,
                { ...tree, ref: current.root },
                authority.canWrite(account, tree.id, linkDigest(request)) ? "write" : "read",
              ),
              update: current.id,
            },
            snapshot: {
              root: snapshot.root,
              objects: [...snapshot.objects].map(([hash, bytes]) => ({
                hash,
                bytes: Buffer.from(bytes).toString("base64"),
              })),
            },
          });
        }
        const updates = /^\/\.arbor\/trees\/([^/]+)\/updates$/.exec(url.pathname);
        if (updates) {
          const treeID = decodeURIComponent(updates[1]!);
          const tree = authority.get(treeID);
          if (!tree || !authority.canWrite(account, treeID, linkDigest(request))) return new Response("Not found", { status: 404 });
          if (request.method === "POST") {
            const update = decodeUpdateRequestJSON(await request.json());
            const result = await authority.submitUpdate(
              treeID,
              update,
              account,
              linkDigest(request),
              authentication?.subject,
            );
            if (!update.returnSnapshot) return json(updateJSON(result.result), result.status);
            if ("error" in result.result) {
              const currentSnapshot = await authority.snapshotForUpdate(treeID, result.result.current.id);
              return json(updateJSON({ ...result.result, currentSnapshot: {
                root: currentSnapshot.root,
                objects: [...currentSnapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
              } }), result.status);
            }
            const accepted = result.result.outcome === "current" ? result.result.current : result.result.update;
            if (update.returnSnapshot === "if-result-differs" && accepted.root === update.candidate) {
              return json(updateJSON(result.result), result.status);
            }
            const snapshot = await authority.snapshotForUpdate(treeID, accepted.id);
            return json(updateJSON({ ...result.result, snapshot: {
              root: snapshot.root,
              objects: [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
            } }), result.status);
          }
          return new Response("Method not allowed", { status: 405 });
        }
        const watch = /^\/\.arbor\/trees\/([^/]+)\/watch$/.exec(url.pathname);
        if (watch && request.method === "GET") {
          const tree = authority.get(decodeURIComponent(watch[1]!));
          if (!tree || !authority.canRead(account, tree.id, linkDigest(request))) return new Response("Not found", { status: 404 });
          const encoder = new TextEncoder();
          const credentialSubject = authentication?.subject;
          const access = authority.canWrite(account, tree.id, linkDigest(request)) ? "write" : "read";
          const lastEventID = request.headers.get("last-event-id");
          const frame = (updated: AuthorityTree, accepted: AcceptedUpdate, digest?: ObjectHash | null) =>
            `id: ${accepted.id}\nevent: ref\ndata: ${JSON.stringify(watchDescriptor(publicOrigin, updated, accepted, access, digest))}\n\n`;
          return new Response(new ReadableStream({
            start(controller) {
              const stop = authority.subscribe(tree.id, (updated, accepted, digest) => {
                const visibleDigest = credentialSubject && accepted.subject === credentialSubject ? digest : undefined;
                controller.enqueue(encoder.encode(frame(updated, accepted, visibleDigest)));
              });
              const accepted = authority.acceptedUpdates(tree.id);
              const cursorIndex = lastEventID ? accepted.findIndex((update) => update.id === lastEventID) : -1;
              const replay = lastEventID === null
                ? accepted.slice(-1)
                : cursorIndex >= 0
                  ? accepted.slice(cursorIndex + 1)
                  : accepted.slice(-1);
              for (const update of replay) {
                const digest = authority.matchingRequestDigest(update.id, credentialSubject);
                controller.enqueue(encoder.encode(frame(tree, update, digest)));
              }
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
            headers: {
              "content-type": "application/vnd.ipld.dag-cbor",
              "cache-control": "public, immutable",
              etag: `"${hash}"`,
            },
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
          let tree = resolved.tree;
          const logical = await resolveWireLogicalNode(tree.ref, resolved.path, (hash) => authority.object(hash));
          if (!logical) return new Response("Not found", { status: 404 });
          const objectValue = logical.object;
          const objectName = logical.objectName || tree.canonicalPath.split("/").at(-1) || "Arbor";
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
          const source = logical.body ? new TextDecoder().decode(logical.body.bytes) : "";
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
            fallbackTitle: resolved.path.split("/").filter(Boolean).at(-1) ?? tree.canonicalPath.split("/").filter(Boolean).at(-1) ?? authority.communityHandle(),
            origin: publicOrigin,
            treeCanonicalPath: tree.canonicalPath,
            documentPath: resolved.path,
            children,
          }));
        }
        return wireError("not-found", "Route not found", 404);
      } catch (error) {
        if (error instanceof RefConflictError) {
          return wireError("ref-conflict", "The tree ref changed before the mutation committed", 409, false, { current: error.current });
        }
        if (error instanceof UpdateProtocolError) {
          const status = error.code === "base-not-retained" ? 410 : error.code === "authority-busy" ? 503 : 409;
          return wireError(error.code, error.message, status, error.code === "authority-busy");
        }
        if (error instanceof AlreadyClaimedError) {
          return wireError("already-claimed", `Profile ~${error.handle} is already claimed`, 409, false, { handle: error.handle });
        }
        if (error instanceof ReservedBoundaryConflictError) {
          return wireError("reserved-boundary", "The update would change an independently versioned tree boundary", 409, false, {
            path: error.path,
            tree: error.tree,
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        if (/authentication is required/i.test(message)) return wireError("unauthenticated", message, 401);
        if (/not allowed/i.test(message)) return wireError("permission-denied", message, 403);
        if (/unknown tree|not found/i.test(message)) return wireError("not-found", message, 404);
        return wireError("invalid-request", message, 400);
      }
    },
  });
  if (dynamicLoopbackOrigin) {
    publicOrigin = `${publicOrigin.slice(0, publicOrigin.lastIndexOf(":"))}:${server.port}`;
  }
  if (dynamicLoopbackOrigin) authority.setCommunityHost(new URL(publicOrigin).host, true);
  return { authority, server, url: publicOrigin };
}
