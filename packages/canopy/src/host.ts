import { resolve } from "node:path";
import { decodeTreeSnapshotJSON, encodeUpdateConflictJSON, encodeUpdateResultJSON, type TreeSnapshot, type UpdateConflictResult, type UpdateResult } from "@arbor/wire";
import { buildNetworkLocator, canonicalArborLocator, encodeSSEFrame, resolveLogicalURL, sha256 } from "@arbor/core";
import type { AccessEntry, AccessLevel, LocatorResolution, MutationCallRuntime, ObservationEvent, QueryStreamRuntime, ReadWriteAccess, RemoteTreeDescriptor } from "@arbor/core";
import { treeMutationResponse, treeQueryResponse } from "@arbor/data/host";
import {
  AlreadyClaimedError,
  RefConflictError,
  ReservedBoundaryConflictError,
  UpdateProtocolError,
  CanopyDaemon,
  type CanopyAccount,
  type CanopyTree,
  type CanopyBootstrapAccount,
} from "./canopy.ts";
import type { ObservationRecord } from "./updates/observations.ts";
import {
  decodeUpdateRequestJSON,
  decodeWireObject,
  encodeAcceptedTransitionJSON,
  encodeObjectEnvelopes,
  type AcceptedTransition,
  type ObjectHash,
  type RemoteAccountDescriptor,
} from "@arbor/wire";
import { escapeHTML, renderPublicDataPage, renderPublicMarkdownPage, type PublicPageChild } from "./public-page.ts";
import { WireProjection, wireCollectionFileRowMarkdown, wireCollectionFileRowTitle } from "@arbor/wire-projection";


function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
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
  return {
    id: tree.id,
    kind: tree.kind,
    access,
    canonical: tree.canonicalPath === null ? null : {
      path: tree.canonicalPath,
      endpoint: `${origin}/.arbor/trees/${encodeURIComponent(tree.id)}`,
      parentTree: tree.parentTree,
    },
    root: tree.ref as RemoteTreeDescriptor["root"],
    update: "",
  };
}

/** The `arbor://` locator of a canonical tree descriptor, or null for a noncanonical tree. */
function arborLocator(tree: RemoteTreeDescriptor): string | null {
  return tree.canonical ? canonicalArborLocator(tree.canonical) : null;
}

function descriptorWithUpdate(
  origin: string,
  canopy: CanopyDaemon,
  tree: CanopyTree,
  access: ReadWriteAccess = "read",
): RemoteTreeDescriptor {
  const update = canopy.currentUpdate(tree.id);
  if (!update) throw new Error(`Tree has no accepted update: ${tree.id}`);
  return { ...descriptor(origin, tree, access), root: update.root as RemoteTreeDescriptor["root"], update: update.id };
}

function watchDescriptor(
  origin: string,
  tree: CanopyTree,
  transitions: AcceptedTransition[],
  access: ReadWriteAccess,
): ObservationEvent<"tree.update", { descriptor: RemoteTreeDescriptor; transitions: unknown[]; requestDigest?: ObjectHash }> {
  const final = transitions.at(-1);
  if (!final) throw new Error("Tree ref frame requires at least one accepted transition");
  return {
    cursor: final.update.id,
    tree: tree.id,
    kind: "tree.update",
    change: {
      descriptor: { ...descriptor(origin, { ...tree, ref: final.update.root }, access), update: final.update.id },
      transitions: transitions.map(encodeAcceptedTransitionJSON),
      ...(final.requestDigest ? { requestDigest: final.requestDigest } : {}),
    },
  };
}

const MAX_WATCH_TRANSITIONS_PER_FRAME = 64;
const MAX_WATCH_TRANSITION_FRAME_BYTES = 1024 * 1024;

function updateJSON(value: UpdateResult | UpdateConflictResult): unknown {
  return "error" in value ? encodeUpdateConflictJSON(value) : encodeUpdateResultJSON(value);
}

function accountDescriptor(origin: string, canopy: CanopyDaemon, account: CanopyAccount): RemoteAccountDescriptor {
  const profile = account.profileTree ? canopy.get(account.profileTree) : null;
  const configuration = account.configTree ? canopy.get(account.configTree) : null;
  if (!configuration) throw new Error("Account configuration tree is missing");
  return {
    id: account.id,
    handle: account.handle,
    profileTree: account.profileTree,
    profileURL: profile ? arborLocator(descriptorWithUpdate(origin, canopy, profile, "write")) : null,
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

function html(value: string, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "text/html; charset=utf-8");
  responseHeaders.set("cache-control", "no-cache");
  return new Response(value, {
    status,
    headers: responseHeaders,
  });
}

function bodySnapshot(body: unknown): TreeSnapshot {
  return decodeTreeSnapshotJSON(body);
}

function requireAccount(request: Request, canopy: CanopyDaemon): CanopyAccount {
  const account = accountFor(request, canopy);
  if (!account) throw new Error("Account authentication is required");
  return account;
}

function requireAuthentication(request: Request, canopy: CanopyDaemon) {
  const authentication = canopy.authenticateToken(bearer(request));
  if (!authentication) throw new Error("Account authentication is required");
  return authentication;
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
  mutationRuntime?: MutationCallRuntime;
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
    async fetch(request, server) {
      const url = new URL(request.url);
      const authentication = canopy.authenticateToken(bearer(request));
      const account = authentication?.account ?? null;
      try {
        const queryRoute = /^\/\.arbor\/trees\/([^/]+)\/queries$/.exec(url.pathname);
        if (request.method === "QUERY" && queryRoute) {
          if (!options.queryRuntime) return wireError("unsupported-operation", "No query runtime is active", 422);
          const treeID = decodeURIComponent(queryRoute[1]!);
          const tree = canopy.get(treeID);
          if (!tree || !canopy.canRead(account, treeID, linkDigest(request))) return wireError("not-found", "Tree not found", 404);
          server.timeout(request, 0);
          return treeQueryResponse(
            options.queryRuntime,
            request,
            treeID,
            account?.profileTree ? { profile: account.profileTree } : null,
          );
        }
        const mutateRoute = /^\/\.arbor\/trees\/([^/]+)\/mutate$/.exec(url.pathname);
        if (request.method === "POST" && mutateRoute) {
          if (!options.mutationRuntime) return wireError("unsupported-operation", "No mutation runtime is active", 422);
          const treeID = decodeURIComponent(mutateRoute[1]!);
          const tree = canopy.get(treeID);
          if (!tree || !account || !canopy.canWrite(account, treeID, linkDigest(request))) return wireError("not-found", "Tree not found", 404);
          return treeMutationResponse(
            options.mutationRuntime,
            request,
            treeID,
            account.profileTree ? { profile: account.profileTree } : null,
          );
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
        const profileProof = /^\/\.arbor\/profile-proofs\/([^/]+)$/.exec(url.pathname);
        if (profileProof && request.method === "PUT") {
          const body = await request.json() as {
            secretDigest?: unknown;
            targetOrigin?: unknown;
            targetAccount?: unknown;
            configurationTree?: unknown;
          };
          if (
            typeof body.secretDigest !== "string" || typeof body.targetOrigin !== "string"
            || typeof body.targetAccount !== "string" || typeof body.configurationTree !== "string"
          ) throw new Error("Profile proof requires a secret digest and exact target binding");
          const proof = await canopy.createProfileProof(requireAuthentication(request, canopy), {
            id: decodeURIComponent(profileProof[1]!),
            secretDigest: body.secretDigest,
            targetOrigin: body.targetOrigin,
            targetAccount: body.targetAccount,
            configurationTree: body.configurationTree,
          });
          return json(proof, 201);
        }
        const profileProofConsume = /^\/\.arbor\/profile-proofs\/([^/]+)\/consume$/.exec(url.pathname);
        if (profileProofConsume && request.method === "PUT") {
          const body = await request.json() as {
            secret?: unknown;
            targetOrigin?: unknown;
            targetAccount?: unknown;
            configurationTree?: unknown;
          };
          if (
            typeof body.secret !== "string" || typeof body.targetOrigin !== "string"
            || typeof body.targetAccount !== "string" || typeof body.configurationTree !== "string"
          ) throw new Error("Profile proof consumption requires its secret and exact target binding");
          return json(await canopy.consumeProfileProof({
            id: decodeURIComponent(profileProofConsume[1]!),
            secret: body.secret,
            targetOrigin: body.targetOrigin,
            targetAccount: body.targetAccount,
            configurationTree: body.configurationTree,
          }));
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
            || (body.placements !== undefined && (typeof body.placements !== "object" || body.placements === null || Array.isArray(body.placements)))
          ) throw new Error("Pairing claim requires secret, generated device identity, credential digest, and label");
          const claimed = await canopy.claimPairing({
            id: pairingID,
            secret: body.secret,
            deviceID: body.device.id,
            credentialDigest: body.device.credentialDigest,
            label: body.device.label,
            placements: (body.placements ?? {}) as Record<string, { server: string; path?: string }>,
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
        if (url.pathname === "/.arbor/accounts" && request.method === "PUT") {
          const body = await request.json() as {
            account?: unknown;
            issuerOrigin?: unknown;
            proof?: { id?: unknown; secret?: unknown };
            profileTree?: unknown;
            configurationTree?: unknown;
            device?: { id?: unknown; label?: unknown; credentialDigest?: unknown };
            configuration?: { root?: unknown; objects?: unknown };
          };
          let accountURL: URL | undefined;
          try { if (typeof body.account === "string") accountURL = new URL(body.account); } catch {}
          const reservation = accountURL?.origin === publicOrigin ? canopy.accountReservation(body.account as string) : null;
          if (
            !reservation || typeof body.profileTree !== "string" || typeof body.configurationTree !== "string"
            || typeof body.device?.id !== "string" || typeof body.device.label !== "string"
            || typeof body.device.credentialDigest !== "string" || !body.configuration
          ) throw new Error("Account join requires an exact community reservation, generated identities, credential digest, and initial configuration");
          if (reservation.profileTree && reservation.profileTree !== body.profileTree) {
            throw new Error("Account reservation names a different profile TreeID");
          }
          let issuer: URL | undefined;
          if (body.proof !== undefined || body.issuerOrigin !== undefined) {
            if (typeof body.issuerOrigin !== "string" || typeof body.proof?.id !== "string" || typeof body.proof.secret !== "string") {
              throw new Error("Profile proof requires both its issuer and one-time secret");
            }
            issuer = new URL(body.issuerOrigin);
            const loopback = issuer.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(issuer.hostname);
            if ((issuer.protocol !== "https:" && !loopback) || issuer.origin !== body.issuerOrigin) {
              throw new Error("Profile proof issuer must be a normalized HTTPS Canopy origin");
            }
            const proofResponse = await fetch(`${issuer.origin}/.arbor/profile-proofs/${encodeURIComponent(body.proof.id)}/consume`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                secret: body.proof.secret,
                targetOrigin: publicOrigin,
                targetAccount: body.account,
                configurationTree: body.configurationTree,
              }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!proofResponse.ok) throw new Error("Profile proof could not be verified by its issuer");
            const proven = await proofResponse.json() as { profileTree?: unknown };
            if (proven.profileTree !== body.profileTree) throw new Error("Profile proof returned a different profile TreeID");
          }
          const result = await canopy.claimAccountWithConfiguration({
            accountLocator: body.account as string,
            handle: reservation.handle,
            origin: publicOrigin,
            ...(issuer ? { issuerOrigin: issuer.origin, proofID: body.proof!.id as string } : {}),
            profileTree: body.profileTree,
            configurationTree: body.configurationTree,
            deviceID: body.device.id,
            deviceLabel: body.device.label,
            credentialDigest: body.device.credentialDigest,
            configurationSnapshot: bodySnapshot(body.configuration),
          });
          return json({
            account: accountDescriptor(publicOrigin, canopy, result.account),
            configuration: descriptorWithUpdate(publicOrigin, canopy, result.configuration, "write"),
          }, 201);
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
                const locator = profile ? arborLocator(descriptor(publicOrigin, profile)) : null;
                return {
                  id: entry.id,
                  subject: { kind: "profile" as const, tree: entry.subject, ...(locator ? { locator } : {}) },
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
            ref: { tree: resolved.tree.id, path: resolved.path, stableKey: null },
            enclosingTree,
            historical: false,
            observedThrough: canopy.observedThrough(resolved.tree.id),
          } satisfies LocatorResolution);
        }
        const ref = /^\/\.arbor\/trees\/([^/]+)$/.exec(url.pathname);
        if (ref && request.method === "GET") {
          const tree = canopy.get(decodeURIComponent(ref[1]!));
          if (!tree || !canopy.canRead(account, tree.id, linkDigest(request))) return new Response("Not found", { status: 404 });
          const current = descriptorWithUpdate(
            publicOrigin,
            canopy,
            tree,
            canopy.canWrite(account, tree.id, linkDigest(request)) ? "write" : "read",
          );
          return json({ tree: current, observedThrough: canopy.observedThrough(tree.id) });
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
          // Captured in the same synchronous step as `current`, so a later
          // non-ref observation may advance the cursor but no newer accepted
          // update can hide behind it.
          const observedThrough = canopy.observedThrough(tree.id);
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
            root: snapshot.root,
            objects: encodeObjectEnvelopes(snapshot.objects),
            observedThrough,
          });
        }
        const updates = /^\/\.arbor\/trees\/([^/]+)\/updates$/.exec(url.pathname);
        if (updates) {
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          const treeID = decodeURIComponent(updates[1]!);
          const update = decodeUpdateRequestJSON(await request.json());
          const tree = canopy.get(treeID);
          // A null base activates a reserved tree, which has no descriptor yet;
          // Canopy checks the reservation and the administrator device.
          const permitted = tree
            ? canopy.canWrite(account, treeID, linkDigest(request))
            : update.base === null && authentication !== null;
          if (!permitted) return new Response("Not found", { status: 404 });
          const result = await canopy.submitUpdate(
            treeID,
            update,
            account,
            linkDigest(request),
            authentication?.subject,
            authentication ?? undefined,
          );
          return json(updateJSON(result.result), result.status);
        }
        const watch = /^\/\.arbor\/trees\/([^/]+)\/watch$/.exec(url.pathname);
        if (watch && request.method === "GET") {
          const tree = canopy.get(decodeURIComponent(watch[1]!));
          if (!tree || !canopy.canRead(account, tree.id, linkDigest(request))) return new Response("Not found", { status: 404 });
          // Watch streams stay open indefinitely; lift Bun's per-connection idle timeout for them.
          server.timeout(request, 0);
          const encoder = new TextEncoder();
          const credentialSubject = authentication?.subject;
          const access = canopy.canWrite(account, tree.id, linkDigest(request)) ? "write" : "read";
          const headerCursor = request.headers.get("last-event-id");
          const queryCursor = url.searchParams.get("after");
          if (headerCursor && queryCursor && headerCursor !== queryCursor) {
            return wireError("invalid-request", "after and Last-Event-ID disagree", 400);
          }
          const lastEventID = queryCursor ?? headerCursor;
          /** Encode a contiguous run of accepted updates as bounded `tree.update` frames, or null when any transition is unavailable. */
          const refFrames = (updateIDs: string[]): string[] | null => {
            const current = canopy.get(tree.id) ?? tree;
            const transitions: AcceptedTransition[] = [];
            for (const id of updateIDs) {
              const transition = canopy.acceptedTransition(id, credentialSubject);
              if (!transition) return null;
              transitions.push(transition);
            }
            const frames: string[] = [];
            let batch: AcceptedTransition[] = [];
            const frame = (items: AcceptedTransition[]) => encodeSSEFrame({
              id: items.at(-1)!.update.id,
              event: "tree.update",
              data: watchDescriptor(publicOrigin, current, items, access),
            });
            for (const transition of transitions) {
              const candidate = [...batch, transition];
              if (batch.length && (candidate.length > MAX_WATCH_TRANSITIONS_PER_FRAME || Buffer.byteLength(frame(candidate)) > MAX_WATCH_TRANSITION_FRAME_BYTES)) {
                frames.push(frame(batch));
                batch = [];
              }
              batch.push(transition);
              if (Buffer.byteLength(frame(batch)) > MAX_WATCH_TRANSITION_FRAME_BYTES) return null;
            }
            if (batch.length) frames.push(frame(batch));
            return frames;
          };
          const observationFrame = (record: ObservationRecord) => encodeSSEFrame({
            id: record.cursor,
            event: record.kind,
            data: { cursor: record.cursor, tree: record.tree, kind: record.kind, change: record.change },
          });
          return new Response(new ReadableStream({
            start(controller) {
              let closed = false;
              let replaying = true;
              let delivered = 0;
              const pending: ObservationRecord[] = [];
              let stop = () => {};
              const resync = (reason: string) => {
                if (closed) return;
                closed = true;
                const cursor = canopy.observedThrough(tree.id);
                const event: ObservationEvent<"resync-required", { reason: string }> = {
                  cursor,
                  tree: tree.id,
                  kind: "resync-required",
                  change: { reason },
                };
                controller.enqueue(encoder.encode(encodeSSEFrame({ id: cursor, event: "resync-required", data: event })));
                stop();
                controller.close();
              };
              const sendRefs = (updateIDs: string[], failure: string) => {
                if (!updateIDs.length || closed) return;
                const frames = refFrames(updateIDs);
                if (!frames) return resync(failure);
                for (const frame of frames) controller.enqueue(encoder.encode(frame));
              };
              const deliver = (record: ObservationRecord) => {
                if (closed || record.ordinal <= delivered) return;
                delivered = record.ordinal;
                if (record.updateID) sendRefs([record.updateID], "The accepted transition is unavailable or exceeds the watch frame limit");
                else controller.enqueue(encoder.encode(observationFrame(record)));
              };
              stop = canopy.subscribeObservations(tree.id, (record) => {
                if (replaying) pending.push(record);
                else deliver(record);
              });
              const replay = canopy.observationsAfter(tree.id, lastEventID);
              if (!replay.retained) return resync("The requested cursor is no longer retained");
              // Replay groups consecutive accepted updates into bounded batches
              // without crossing another observation kind.
              let batch: string[] = [];
              for (const record of replay.records) {
                if (record.updateID) {
                  batch.push(record.updateID);
                  continue;
                }
                sendRefs(batch, "Retained accepted history has no replayable transition batch");
                batch = [];
                if (!closed) controller.enqueue(encoder.encode(observationFrame(record)));
              }
              sendRefs(batch, "Retained accepted history has no replayable transition batch");
              delivered = replay.through;
              replaying = false;
              for (const record of pending) deliver(record);
              request.signal.addEventListener("abort", () => {
                closed = true;
                stop();
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
              "content-type": "application/cbor",
              "cache-control": "public, immutable",
              etag: `"${hash}"`,
            },
          });
        }
        if (request.method === "GET" && !url.pathname.startsWith("/.")) {
          const requestLocator = resolveLogicalURL("/", `${url.pathname}${url.search}`);
          if (!requestLocator || requestLocator.kind !== "local") return new Response("Not found", { status: 404 });
          const pendingProfile = /^\/~([a-z0-9][a-z0-9-]{0,62})\/?$/.exec(requestLocator.path);
          if (pendingProfile && canopy.isReservedHandle(pendingProfile[1]!)) {
            const profileURL = `${publicOrigin}/~${pendingProfile[1]!}`;
            return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>~${escapeHTML(pendingProfile[1]!)}</title><style>body{max-width:620px;margin:72px auto;padding:0 24px;font:16px/1.55 system-ui;color:#292823}code{display:block;padding:12px;background:#f4f2ec;border-radius:8px}</style><h1>~${escapeHTML(pendingProfile[1]!)}</h1><p>This is an empty profile reserved by the ${escapeHTML(canopy.communityHandle())} community. It has not been claimed.</p><p>Open it in Arbor to claim it:</p><code>arbor open ${escapeHTML(profileURL)}</code><p>The first successful claim wins.</p>`, 200, { "x-arbor-profile-state": "reserved" });
          }
          if (pendingProfile && canopy.accountByHandle(pendingProfile[1]!) && !canopy.boundary(requestLocator.path)) {
            const claimed = canopy.accountByHandle(pendingProfile[1]!)!;
            return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>~${escapeHTML(pendingProfile[1]!)}</title><style>body{max-width:620px;margin:72px auto;padding:0 24px;font:16px/1.55 system-ui;color:#292823}code{display:block;padding:12px;background:#f4f2ec;border-radius:8px}</style><h1>~${escapeHTML(pendingProfile[1]!)}</h1><p>This account is linked to profile tree:</p><code>arbor://${escapeHTML(claimed.profileTree ?? "unbound")}/</code><p>The profile has not been hosted at this path yet.</p>`, 200, { "x-arbor-profile-state": "linked" });
          }
          const resolved = canopy.resolve(requestLocator.path);
          if (!resolved) return new Response("Not found", { status: 404 });
          if (!canopy.canRead(account, resolved.tree.id, linkDigest(request))) {
            return request.headers.get("accept")?.includes("text/html")
              ? linkBootstrap()
              : new Response("Not found", { status: 404 });
          }
          const tree = resolved.tree;
          const load = (hash: ObjectHash) => canopy.object(hash);
          const wireProjection = new WireProjection({
            tree: tree.id,
            root: tree.ref,
            load,
            rootName: tree.canonicalPath?.split("/").filter(Boolean).at(-1) ?? canopy.communityHandle(),
            observedThrough: "public",
          });
          const resolution = await wireProjection.resolve(resolved.path, requestLocator.stableKey);
          if (resolution.kind === "missing") return new Response("Not found", { status: 404 });
          const logicalPath = resolution.path;
          if (requestLocator.stableKey && resolved.path !== logicalPath) {
            const publicPath = tree.canonicalPath === "/"
              ? logicalPath
              : `${tree.canonicalPath}${logicalPath === "/" ? "" : logicalPath}`;
            const location = buildNetworkLocator(publicPath, {
              stableKey: requestLocator.stableKey,
              applicationQuery: requestLocator.applicationQuery,
              contentFragment: requestLocator.contentFragment,
            });
            if (!location) return new Response("Not found", { status: 404 });
            return new Response(null, { status: 308, headers: { location } });
          }
          const collectionFileRow = resolution.kind === "collection-file-row" ? resolution : null;
          const logical = resolution.kind === "node" ? resolution.node : null;
          const canonicalPath = tree.canonicalPath!;
          if (collectionFileRow) {
            const title = wireCollectionFileRowTitle(collectionFileRow.row);
            if (request.headers.get("accept")?.includes("text/markdown")) {
              return new Response(wireCollectionFileRowMarkdown(collectionFileRow.row), {
                headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" },
              });
            }
            return html(renderPublicDataPage(title, collectionFileRow.row.properties));
          }
          if (!logical) return new Response("Not found", { status: 404 });
          const objectValue = logical.object;
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
                documentPath: logicalPath,
              }));
            }
            return new Response(objectValue.bytes.buffer.slice(
              objectValue.bytes.byteOffset,
              objectValue.bytes.byteOffset + objectValue.bytes.byteLength,
            ) as ArrayBuffer);
          }
          const prefix = (tree.canonicalPath === "/"
            ? logicalPath
            : `${tree.canonicalPath}${logicalPath === "/" ? "" : logicalPath}`)
            .split("/").map((part) => encodeURIComponent(part)).join("/").replace(/\/$/, "");
          const source = logical.body ? new TextDecoder().decode(logical.body.bytes) : "";
          if (request.headers.get("accept")?.includes("text/markdown")) {
            return new Response(source, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" } });
          }
          const collectionFileDescriptor = objectValue.childrenSource;
          const collectionFile = await wireProjection.collectionFile(objectValue);
          const physicalChildren = (await Promise.all(objectValue.entries
            .filter((entry) => entry.name !== "_index.md"
              && entry.name !== collectionFileDescriptor?.source
              && entry.name !== collectionFileDescriptor?.schemaSource)
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
          const collectionFileChildren: PublicPageChild[] = (collectionFile?.rows ?? []).map((row) => ({
            name: wireCollectionFileRowTitle(row),
            href: buildNetworkLocator(`${prefix}/${encodeURIComponent(row.path)}`, {
              stableKey: row.stableKey,
              applicationQuery: requestLocator.applicationQuery,
            }),
            kind: "document",
          }));
          const children = [...physicalChildren, ...collectionFileChildren]
            .sort((left, right) => left.name.localeCompare(right.name));
          return html(renderPublicMarkdownPage({
            source,
            fallbackTitle: logicalPath.split("/").filter(Boolean).at(-1) ?? canonicalPath.split("/").filter(Boolean).at(-1) ?? canopy.communityHandle(),
            origin: publicOrigin,
            treeCanonicalPath: canonicalPath,
            documentPath: logicalPath,
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
