import { resolve } from "node:path";
import { encodeSSEFrame, sha256 } from "@arbor/core";
import type { AccessEntry, AccessLevel, LocatorResolution, ObservationEvent, QueryStreamEvent, QueryStreamRequest, QueryStreamRuntime, RemoteTreeDescriptor } from "@arbor/core";
import {
  AlreadyClaimedError,
  RefConflictError,
  ReservedBoundaryConflictError,
  UpdateProtocolError,
  CanopyDaemon,
  TreeIDConflictError,
  type CanopyAccount,
  type CanopyTree,
  type CanopyBootstrapAccount,
} from "./canopy.ts";
import {
  decodeObjectEnvelopes,
  decodeUpdateRequestJSON,
  decodeWireObject,
  resolveWireLogicalNode,
  type AcceptedUpdate,
  type ObjectHash,
  type RemoteAccountDescriptor,
  type TreeAccess,
} from "@arbor/wire";
import { renderPublicMarkdownPage, type PublicPageChild } from "./public-page.ts";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function queryStreamResponse(
  runtime: QueryStreamRuntime,
  input: QueryStreamRequest,
  signal: AbortSignal,
  user: { profile: string } | null,
): Promise<Response> | Response {
  const encoder = new TextEncoder();
  const response = (events: ReadableStream<QueryStreamEvent>) => new Response(events.pipeThrough(new TransformStream({
    transform(event, controller) {
      const { type, ...data } = event;
      controller.enqueue(encoder.encode(encodeSSEFrame({ event: type, data })));
    },
  })), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" } });
  const events = runtime.stream(input, { signal, user });
  return events instanceof Promise ? events.then(response) : response(events);
}

function wireError(
  error: string,
  message: string,
  status: number,
  retryable = false,
  details: Record<string, unknown> = {},
  context: { tree?: string; path?: string } = {},
): Response {
  return json({ error, message, retryable, ...context, ...(Object.keys(details).length ? { details } : {}) }, status);
}

function descriptor(origin: string, tree: CanopyTree, access: AccessLevel = "read"): RemoteTreeDescriptor {
  const encodedPath = tree.canonicalPath === null || tree.canonicalPath === "/"
    ? ""
    : `/${tree.canonicalPath.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
  const host = new URL(origin).host;
  return {
    id: tree.id,
    kind: tree.kind,
    access,
    canonical: tree.canonicalPath === null ? null : {
      locator: `arbor://${host}${encodedPath || "/"}`,
      path: tree.canonicalPath,
      endpoint: `${origin}/.arbor/trees/${encodeURIComponent(tree.id)}`,
      httpURL: `${origin}${encodedPath || "/"}`,
      parentTree: tree.parentTree,
    },
    ref: tree.ref as RemoteTreeDescriptor["ref"],
    update: "",
  };
}

function descriptorWithUpdate(
  origin: string,
  canopy: CanopyDaemon,
  tree: CanopyTree,
  access: TreeAccess = "read",
): RemoteTreeDescriptor {
  const update = canopy.currentUpdate(tree.id);
  if (!update) throw new Error(`Tree has no accepted update: ${tree.id}`);
  return { ...descriptor(origin, tree, access), ref: update.root as RemoteTreeDescriptor["ref"], update: update.id };
}

function watchDescriptor(
  origin: string,
  tree: CanopyTree,
  update: AcceptedUpdate,
  access: TreeAccess,
  requestDigest?: ObjectHash | null,
): ObservationEvent<"tree.ref", { descriptor: RemoteTreeDescriptor; requestDigest?: ObjectHash }> {
  return {
    cursor: update.id,
    tree: tree.id,
    kind: "tree.ref",
    change: {
      descriptor: { ...descriptor(origin, { ...tree, ref: update.root }, access), update: update.id },
      ...(requestDigest ? { requestDigest } : {}),
    },
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
    details: {
      draft: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: Uint8Array }> };
      currentSnapshot?: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: Uint8Array }> };
    };
  };
  return {
    ...conflict,
    details: {
      ...conflict.details,
      draft: encodeSnapshot(conflict.details.draft),
      ...(conflict.details.currentSnapshot ? { currentSnapshot: encodeSnapshot(conflict.details.currentSnapshot) } : {}),
    },
  };
}

function accountDescriptor(origin: string, canopy: CanopyDaemon, account: CanopyAccount): RemoteAccountDescriptor {
  const profile = account.profileTree ? canopy.get(account.profileTree) : null;
  const configuration = account.configTree ? canopy.get(account.configTree) : null;
  if (!configuration) throw new Error("Account configuration tree is missing");
  return {
    id: account.id,
    handle: account.handle,
    profileTree: account.profileTree,
    profileURL: profile ? descriptorWithUpdate(origin, canopy, profile, "write").canonical?.locator ?? null : null,
    community: descriptorWithUpdate(origin, canopy, canopy.community(), canopy.canWrite(account, canopy.community().id) ? "write" : "read"),
    configuration: descriptorWithUpdate(origin, canopy, configuration, "write"),
    writableProfiles: canopy.writableProfiles(account).map((tree) => descriptorWithUpdate(origin, canopy, tree, "write")),
  };
}

function bearer(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

function accountFor(request: Request, canopy: CanopyDaemon): CanopyAccount | null {
  return canopy.accountByToken(bearer(request));
}

function linkDigest(request: Request): string | undefined {
  const secret = request.headers.get("arbor-access-link") ?? undefined;
  return secret ? `sha256:${sha256(secret)}` : undefined;
}

function linkBootstrap(): Response {
  return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Arbor access</title><body><p>Opening shared Arbor tree…</p><script>
const secret = location.hash.startsWith("#arbor-access=") ? decodeURIComponent(location.hash.slice(14)) : "";
if (!secret) document.body.textContent = "This Arbor tree requires access.";
else fetch(location.pathname + location.search, { headers: { "Arbor-Access-Link": secret } })
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

function requireAccount(request: Request, canopy: CanopyDaemon): CanopyAccount {
  const account = accountFor(request, canopy);
  if (!account) throw new Error("Account authentication is required");
  return account;
}

export async function serveCanopy(options: {
  dataRoot: string;
  publicOrigin: string;
  community?: {
    handle: string;
    name: string;
    firstWriter?: { handle: string; name?: string };
  };
  accounts?: CanopyBootstrapAccount[];
  port?: number;
  hostname?: string;
  queryRuntime?: QueryStreamRuntime;
}) {
  const bootstrapAccounts = options.accounts ?? [];
  let publicOrigin = options.publicOrigin.replace(/\/$/, "");
  const dynamicLoopbackOrigin = /^https?:\/\/(?:127\.0\.0\.1|localhost):0$/.test(publicOrigin);
  const canopy = await CanopyDaemon.open(resolve(options.dataRoot), {
    handle: options.community?.handle ?? "community",
    name: options.community?.name ?? "Arbor Community",
    accounts: bootstrapAccounts,
    ...(dynamicLoopbackOrigin ? {} : { communityHost: new URL(publicOrigin).host }),
    ...(options.community?.firstWriter ? { firstWriter: options.community.firstWriter } : {}),
  });
  if (!dynamicLoopbackOrigin) canopy.setCommunityHost(new URL(publicOrigin).host);
  const pairingClaimAttempts = new Map<string, number[]>();
  const server = Bun.serve({
    port: options.port ?? Number(process.env.PORT ?? 4318),
    hostname: options.hostname ?? "0.0.0.0",
    async fetch(request) {
      const url = new URL(request.url);
      const authentication = canopy.authenticateToken(bearer(request));
      const account = authentication?.account ?? null;
      try {
        if (request.method === "POST" && url.pathname === "/.arbor/query-stream") {
          if (!options.queryRuntime) return wireError("unsupported-operation", "No query runtime is active", 422);
          try {
            return await queryStreamResponse(
              options.queryRuntime,
              await request.json() as QueryStreamRequest,
              request.signal,
              account?.profileTree ? { profile: account.profileTree } : null,
            );
          } catch (error) {
            return wireError("invalid-request", error instanceof Error ? error.message : "Invalid query stream request", 400);
          }
        }
        if (request.method === "GET" && url.pathname === "/.arbor/health") {
          try {
            await canopy.verifyIntegrity();
            return json({ status: "ok" });
          } catch (error) {
            console.error("Arbor canopy integrity check failed", error);
            return wireError("internal-error", "Canopy integrity check failed", 503, true);
          }
        }
        if (request.method === "GET" && url.pathname === "/.arbor/account") {
          const authenticated = canopy.authenticateToken(bearer(request));
          const currentDevice = authenticated?.device
            ? canopy.devices(authenticated.account).find((device) => device.id === authenticated.device)
            : undefined;
          return json({
            account: {
              ...accountDescriptor(publicOrigin, canopy, requireAccount(request, canopy)),
              ...(currentDevice ? { device: { id: currentDevice.id, label: currentDevice.label } } : {}),
            },
            observedThrough: canopy.observedThrough(),
          });
        }
        if (url.pathname === "/.arbor/pairings" && request.method === "POST") {
          return json(canopy.createPairing(requireAccount(request, canopy)), 201);
        }
        const pairingClaim = /^\/\.arbor\/pairings\/([^/]+)\/claim$/.exec(url.pathname);
        if (pairingClaim && request.method === "PUT") {
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
          const body = await request.json() as {
            secret?: unknown;
            device?: { id?: unknown; label?: unknown; credentialDigest?: unknown };
            placements?: unknown;
          };
          if (
            typeof body.secret !== "string" || typeof body.device?.id !== "string"
            || typeof body.device.label !== "string" || typeof body.device.credentialDigest !== "string"
            || !body.placements || typeof body.placements !== "object" || Array.isArray(body.placements)
          ) throw new Error("Pairing claim requires secret, generated device identity, credential digest, label, and placements");
          const claimed = await canopy.claimPairing({
            id: pairingID,
            secret: body.secret,
            deviceID: body.device.id,
            credentialDigest: body.device.credentialDigest,
            label: body.device.label,
            placements: body.placements as Record<string, { server: string; path?: string }>,
          });
          return json({ device: claimed.device, confirmationCode: claimed.confirmationCode }, 201);
        }
        if (url.pathname === "/.arbor/trees") {
          if (request.method === "GET") {
            return json({ snapshot: canopy.list()
              .filter((tree) => canopy.canRead(account, tree.id, linkDigest(request)))
              .map((tree) => descriptorWithUpdate(publicOrigin, canopy, tree, canopy.canWrite(account, tree.id, linkDigest(request)) ? "write" : "read")),
              observedThrough: canopy.observedThrough(),
            });
          }
          return new Response("Method not allowed", { status: 405 });
        }
        const claim = /^\/\.arbor\/claims\/([a-z0-9][a-z0-9-]{0,62})$/.exec(url.pathname);
        if (claim && request.method === "PUT") {
          const body = await request.json() as {
            profileTree?: unknown;
            configurationTree?: unknown;
            device?: { id?: unknown; label?: unknown; credentialDigest?: unknown };
            profile?: { root?: unknown; objects?: unknown };
            configuration?: { root?: unknown; objects?: unknown };
          };
          if (
            typeof body.profileTree !== "string" || typeof body.configurationTree !== "string"
            || typeof body.device?.id !== "string" || typeof body.device.label !== "string"
            || typeof body.device.credentialDigest !== "string" || !body.profile || !body.configuration
          ) throw new Error("Claim requires generated identities, a credential digest, and both initial snapshots");
          const result = await canopy.claimWithConfiguration({
            handle: claim[1]!,
            origin: publicOrigin,
            profileTree: body.profileTree,
            configurationTree: body.configurationTree,
            deviceID: body.device.id,
            deviceLabel: body.device.label,
            credentialDigest: body.device.credentialDigest,
            profileSnapshot: bodySnapshot(body.profile),
            configurationSnapshot: bodySnapshot(body.configuration),
          });
          return json({
            account: accountDescriptor(publicOrigin, canopy, result.account),
            tree: descriptorWithUpdate(publicOrigin, canopy, result.tree, "write"),
            configuration: descriptorWithUpdate(publicOrigin, canopy, result.configuration, "write"),
          }, 201);
        }
        const activation = /^\/\.arbor\/trees\/([^/]+)$/.exec(url.pathname);
        if (activation && request.method === "PUT") {
          if (!authentication) throw new Error("Account authentication is required");
          const body = await request.json() as { root?: unknown; objects?: unknown };
          const tree = await canopy.activateTree(authentication, decodeURIComponent(activation[1]!), bodySnapshot(body));
          return json({ snapshot: descriptorWithUpdate(publicOrigin, canopy, tree, "write"), observedThrough: canopy.observedThrough(tree.id) });
        }
        const access = /^\/\.arbor\/trees\/([^/]+)\/access$/.exec(url.pathname);
        if (access) {
          const treeID = decodeURIComponent(access[1]!);
          if (request.method === "GET") {
            const authenticated = requireAccount(request, canopy);
            if (!canopy.canAdminister(authenticated, treeID)) return wireError("not-found", "Tree not found", 404);
            const snapshot: AccessEntry[] = canopy.accessEntries(treeID)
              .filter((entry) => entry.subjectKind !== "profile" || entry.subject !== authenticated.profileTree)
              .map((entry) => {
              if (entry.subjectKind === "profile") {
                const profile = canopy.get(entry.subject);
                return {
                  id: entry.id,
                  subject: { kind: "profile" as const, tree: entry.subject, ...(profile ? { locator: descriptor(publicOrigin, profile).canonical?.locator } : {}) },
                  access: entry.access,
                };
              }
              return { id: entry.id, subject: { kind: entry.subjectKind } as AccessEntry["subject"], access: entry.access };
              });
            return json({ snapshot, observedThrough: canopy.observedThrough(treeID) });
          }
          return new Response("Method not allowed", { status: 405 });
        }
        const wellKnown = url.pathname === "/.well-known/arbor"
          ? "/"
          : url.pathname.startsWith("/.well-known/arbor/")
            ? decodeURIComponent(url.pathname.slice("/.well-known/arbor".length))
            : null;
        if (wellKnown !== null && request.method === "GET") {
          const resolved = canopy.resolve(wellKnown);
          if (!resolved || !canopy.canRead(account, resolved.tree.id, linkDigest(request))) return new Response("Not found", { status: 404 });
          const enclosingTree = descriptorWithUpdate(
              publicOrigin,
              canopy,
              resolved.tree,
              canopy.canWrite(account, resolved.tree.id, linkDigest(request)) ? "write" : "read",
            );
          return json({
            ref: { tree: resolved.tree.id, path: resolved.path },
            enclosingTree,
            historical: false,
            observedThrough: canopy.observedThrough(resolved.tree.id),
          } satisfies LocatorResolution);
        }
        const ref = /^\/\.arbor\/trees\/([^/]+)\/ref$/.exec(url.pathname);
        if (ref && request.method === "GET") {
          const tree = canopy.get(decodeURIComponent(ref[1]!));
          if (!tree || !canopy.canRead(account, tree.id, linkDigest(request))) return new Response("Not found", { status: 404 });
          const snapshot = descriptorWithUpdate(
            publicOrigin,
            canopy,
            tree,
            canopy.canWrite(account, tree.id, linkDigest(request)) ? "write" : "read",
          );
          return json({ snapshot, observedThrough: canopy.observedThrough(tree.id) });
        }
        const currentSnapshot = /^\/\.arbor\/trees\/([^/]+)\/snapshot$/.exec(url.pathname);
        if (currentSnapshot && request.method === "GET") {
          const treeID = decodeURIComponent(currentSnapshot[1]!);
          const tree = canopy.get(treeID);
          if (!tree || !canopy.canRead(account, tree.id, linkDigest(request))) return new Response("Not found", { status: 404 });
          const current = canopy.currentUpdate(tree.id);
          if (!current) return wireError("conflict", "Tree has no accepted update", 409, true, {
            kind: "server-update",
            state: "awaiting-initialization",
          }, { tree: treeID });
          const snapshot = await canopy.snapshotForUpdate(tree.id, current.id);
          return json({
            tree: {
              ...descriptor(
                publicOrigin,
                { ...tree, ref: current.root },
                canopy.canWrite(account, tree.id, linkDigest(request)) ? "write" : "read",
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
            observedThrough: current.id,
          });
        }
        const updates = /^\/\.arbor\/trees\/([^/]+)\/updates$/.exec(url.pathname);
        if (updates) {
          const treeID = decodeURIComponent(updates[1]!);
          const tree = canopy.get(treeID);
          if (!tree || !canopy.canWrite(account, treeID, linkDigest(request))) return new Response("Not found", { status: 404 });
          if (request.method === "POST") {
            const update = decodeUpdateRequestJSON(await request.json());
            const result = await canopy.submitUpdate(
              treeID,
              update,
              account,
              linkDigest(request),
              authentication?.subject,
            );
            if (!update.returnSnapshot) return json(updateJSON(result.result), result.status);
            if ("error" in result.result) {
              const currentSnapshot = await canopy.snapshotForUpdate(treeID, result.result.details.current.id);
              return json(updateJSON({ ...result.result, details: {
                ...result.result.details,
                currentSnapshot: {
                  root: currentSnapshot.root,
                  objects: [...currentSnapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
                },
              } }), result.status);
            }
            const accepted = result.result.outcome === "current" ? result.result.current : result.result.update;
            if (update.returnSnapshot === "if-result-differs" && accepted.root === update.candidate) {
              return json(updateJSON(result.result), result.status);
            }
            const snapshot = await canopy.snapshotForUpdate(treeID, accepted.id);
            return json(updateJSON({ ...result.result, snapshot: {
              root: snapshot.root,
              objects: [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
            } }), result.status);
          }
          return new Response("Method not allowed", { status: 405 });
        }
        const watch = /^\/\.arbor\/trees\/([^/]+)\/watch$/.exec(url.pathname);
        if (watch && request.method === "GET") {
          const tree = canopy.get(decodeURIComponent(watch[1]!));
          if (!tree || !canopy.canRead(account, tree.id, linkDigest(request))) return new Response("Not found", { status: 404 });
          const encoder = new TextEncoder();
          const credentialSubject = authentication?.subject;
          const access = canopy.canWrite(account, tree.id, linkDigest(request)) ? "write" : "read";
          const headerCursor = request.headers.get("last-event-id");
          const queryCursor = url.searchParams.get("after");
          if (headerCursor && queryCursor && headerCursor !== queryCursor) {
            return wireError("invalid-request", "after and Last-Event-ID disagree", 400);
          }
          const lastEventID = queryCursor ?? headerCursor;
          const refFrame = (updated: CanopyTree, accepted: AcceptedUpdate, digest?: ObjectHash | null) =>
            encodeSSEFrame({ id: accepted.id, event: "tree.ref", data: watchDescriptor(publicOrigin, updated, accepted, access, digest) });
          const observationFrame = (event: { cursor: string; tree: string; kind: string; change: unknown }) =>
            encodeSSEFrame({ id: event.cursor, event: event.kind, data: event });
          return new Response(new ReadableStream({
            start(controller) {
              const stopRefs = canopy.subscribe(tree.id, (updated, accepted, digest) => {
                const visibleDigest = credentialSubject && accepted.subject === credentialSubject ? digest : undefined;
                controller.enqueue(encoder.encode(refFrame(updated, accepted, visibleDigest)));
              });
              const stopObservations = canopy.subscribeObservations(tree.id, (event) => {
                controller.enqueue(encoder.encode(observationFrame(event)));
              });
              const accepted = canopy.acceptedUpdates(tree.id);
              const observations = canopy.observationEvents(tree.id);
              const timeline = [
                ...accepted.map((update) => ({ cursor: update.id, at: update.acceptedAt, update })),
                ...observations.map((event) => ({ cursor: event.cursor, at: event.createdAt, event })),
              ].sort((a, b) => a.at - b.at || a.cursor.localeCompare(b.cursor));
              const cursorIndex = lastEventID ? timeline.findIndex((event) => event.cursor === lastEventID) : -1;
              if (lastEventID && cursorIndex < 0) {
                const cursor = canopy.observedThrough(tree.id);
                const event: ObservationEvent<"resync-required", { reason: string }> = {
                  cursor,
                  tree: tree.id,
                  kind: "resync-required",
                  change: { reason: "The requested cursor is no longer retained" },
                };
                controller.enqueue(encoder.encode(encodeSSEFrame({ id: cursor, event: "resync-required", data: event })));
                stopRefs();
                stopObservations();
                controller.close();
                return;
              }
              const replay = lastEventID === null
                ? []
                : cursorIndex >= 0
                  ? timeline.slice(cursorIndex + 1)
                  : [];
              for (const item of replay) {
                if ("update" in item && item.update) {
                  const digest = canopy.matchingRequestDigest(item.update.id, credentialSubject);
                  controller.enqueue(encoder.encode(refFrame(tree, item.update, digest)));
                } else if ("event" in item && item.event) {
                  controller.enqueue(encoder.encode(observationFrame(item.event)));
                }
              }
              request.signal.addEventListener("abort", () => {
                stopRefs();
                stopObservations();
                try { controller.close(); } catch {}
              }, { once: true });
            },
          }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
        }
        const object = /^\/\.arbor\/trees\/([^/]+)\/objects\/(sha256:[a-f0-9]{64})$/.exec(url.pathname);
        if (object && request.method === "GET") {
          const treeID = decodeURIComponent(object[1]!);
          const hash = object[2] as ObjectHash;
          if (!(await canopy.isReadableObject(treeID, hash, account, linkDigest(request)))) return wireError("not-found", "Object not found in the named tree", 404, false, {}, { tree: treeID });
          const bytes = await canopy.object(hash);
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
          if (pendingProfile && canopy.isReservedHandle(pendingProfile[1]!)) {
            const profileURL = `${publicOrigin}/~${pendingProfile[1]!}`;
            return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>~${escapeHTML(pendingProfile[1]!)}</title><style>body{max-width:620px;margin:72px auto;padding:0 24px;font:16px/1.55 system-ui;color:#292823}code{display:block;padding:12px;background:#f4f2ec;border-radius:8px}</style><h1>~${escapeHTML(pendingProfile[1]!)}</h1><p>This is an empty profile reserved by the ${escapeHTML(canopy.communityHandle())} community. It has not been claimed.</p><p>Open it in Arbor to claim it:</p><code>arbor open ${escapeHTML(profileURL)}</code><p>The first successful claim wins.</p>`, 200, { "x-arbor-profile-state": "reserved" });
          }
          const resolved = canopy.resolve(decodeURIComponent(url.pathname));
          if (!resolved) return new Response("Not found", { status: 404 });
          if (!canopy.canRead(account, resolved.tree.id, linkDigest(request))) {
            return request.headers.get("accept")?.includes("text/html")
              ? linkBootstrap()
              : new Response("Not found", { status: 404 });
          }
          let tree = resolved.tree;
          const logical = await resolveWireLogicalNode(tree.ref, resolved.path, (hash) => canopy.object(hash));
          if (!logical) return new Response("Not found", { status: 404 });
          const objectValue = logical.object;
          const canonicalPath = tree.canonicalPath!;
          const objectName = logical.objectName || canonicalPath.split("/").at(-1) || "Arbor";
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
                treeCanonicalPath: canonicalPath,
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
                const nested = canopy.get(entry.tree);
                if (!nested || !canopy.canRead(account, nested.id, linkDigest(request))) return null;
              }
              const object = entry.hash ? decodeWireObject(await canopy.object(entry.hash)) : null;
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
            fallbackTitle: resolved.path.split("/").filter(Boolean).at(-1) ?? canonicalPath.split("/").filter(Boolean).at(-1) ?? canopy.communityHandle(),
            origin: publicOrigin,
            treeCanonicalPath: canonicalPath,
            documentPath: resolved.path,
            children,
          }));
        }
        return wireError("not-found", "Route not found", 404);
      } catch (error) {
        if (error instanceof RefConflictError) {
          return wireError("conflict", "The tree ref changed before the mutation committed", 409, false, {
            kind: "server-update",
            current: error.current,
          });
        }
        if (error instanceof UpdateProtocolError) {
          if (error.code === "base-not-retained") {
            return wireError("resync-required", error.message, 409, true, { kind: "server-update" });
          }
          if (error.code === "server-busy") {
            return wireError("internal-error", error.message, 503, true);
          }
          return wireError("conflict", error.message, 409, false, { kind: "server-update" });
        }
        if (error instanceof AlreadyClaimedError) {
          return wireError("already-claimed", `Profile ~${error.handle} is already claimed`, 409, false, { handle: error.handle });
        }
        if (error instanceof TreeIDConflictError) {
          return wireError("tree-id-conflict", error.message, 409, false, { tree: error.tree });
        }
        if (error instanceof ReservedBoundaryConflictError) {
          return wireError("conflict", "The update would change an independently versioned tree boundary", 409, false, {
            kind: "server-update",
          }, { path: error.path, tree: error.tree });
        }
        const message = error instanceof Error ? error.message : String(error);
        if (/authentication is required/i.test(message)) return wireError("unauthenticated", message, 401);
        if (/not allowed|only an administrator|may not edit|not active|active account device|permission/i.test(message)) {
          return wireError("permission-denied", message, 403);
        }
        if (/unknown tree|not found/i.test(message)) return wireError("not-found", message, 404);
        return wireError("invalid-request", message, 400);
      }
    },
  });
  if (dynamicLoopbackOrigin) {
    publicOrigin = `${publicOrigin.slice(0, publicOrigin.lastIndexOf(":"))}:${server.port}`;
  }
  if (dynamicLoopbackOrigin) canopy.setCommunityHost(new URL(publicOrigin).host, true);
  await canopy.ensureAccountConfigTrees(publicOrigin);
  return { canopy, server, url: publicOrigin };
}
