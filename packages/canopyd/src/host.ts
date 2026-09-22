import { IntentError } from "../../canopyd-merge/src/intent-model.ts";
import { MergeWorkerError } from "./merge-tool.ts";
import { resolve } from "node:path";
import { decodeTreeSnapshotJSON, encodeSnapshotBundle, encodeUpdateConflictJSON, encodeUpdateResponseJSON, type TreeSnapshot, type UpdateConflictResult, type UpdateResponse, buildNetworkLocator, canonicalArborLocator, encodeSSEFrame, resolveLogicalURL, sha256 } from "@overstory/protocol";
import type { AccountChallenge, AccessEntry, AccessLevel, LocatorResolution, MutationCallRuntime, ObservationEvent, QueryStreamRuntime, ReadWriteAccess, RemoteTreeDescriptor } from "@overstory/protocol";
import { treeMutationResponse, treeQueryResponse } from "@overstory/apps-runtime/host";
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
import { encodeWatchFrames } from "./updates/watch-frames.ts";
import type { ObservationRecord } from "./updates/observations.ts";
import { PhaseTimer, withPhaseTimer } from "./updates/timing.ts";
import {
  decodeUpdateRequestJSON,
  encodeAcceptedTransitionJSON,
  type AcceptedTransition,
  type ObjectHash,
  type RemoteAccountDescriptor,
} from "@overstory/protocol";
import { escapeHTML, renderPublicDataPage, renderPublicMarkdownPage, type PublicPageChild } from "./public-page.ts";
import { WireProjection, wireCollectionFileRowMarkdown, wireCollectionFileRowTitle } from "./projection.ts";
import { buildDirectory } from "./directory.ts";


/** Comment frames keep watch streams alive across proxy idle timeouts. */
const WATCH_KEEPALIVE_MS = 20_000;

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** One structured line per update request; silent under the test runner. */
function logUpdate(record: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "test") return;
  console.log(JSON.stringify(record));
}

function immutableHeaders(request: Request, etag: string): HeadersInit {
  const scope = request.headers.has("authorization") || request.headers.has("arbor-access-link")
    ? "private"
    : "public";
  return {
    "content-type": "application/cbor",
    "cache-control": `${scope}, max-age=31536000, immutable`,
    vary: "Authorization, Arbor-Access-Link",
    etag: `"${etag}"`,
  };
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
    conflicted: false,
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
  return { ...descriptor(origin, tree, access), root: update.root as RemoteTreeDescriptor["root"], update: update.id, ...(update.conflicted === undefined ? {} : { conflicted: update.conflicted }) };
}

function watchDescriptor(
  origin: string,
  tree: CanopyTree,
  transitions: AcceptedTransition[],
  access: ReadWriteAccess,
  cursor: string,
): ObservationEvent<"tree.update", { descriptor: RemoteTreeDescriptor; transitions: unknown[]; requestDigest?: ObjectHash }> {
  const final = transitions.at(-1);
  if (!final) throw new Error("Tree ref frame requires at least one accepted transition");
  return {
    cursor,
    tree: tree.id,
    kind: "tree.update",
    change: {
      descriptor: { ...descriptor(origin, { ...tree, ref: final.update.root }, access), update: final.update.id, ...(final.update.conflicted === undefined ? {} : { conflicted: final.update.conflicted }) },
      transitions: transitions.map(encodeAcceptedTransitionJSON),
      ...(final.requestDigest ? { requestDigest: final.requestDigest } : {}),
    },
  };
}

const MAX_WATCH_TRANSITIONS_PER_FRAME = 64;
const MAX_WATCH_TRANSITION_FRAME_BYTES = 1024 * 1024;

function updateJSON(value: UpdateResponse | UpdateConflictResult): unknown {
  if ("error" in value) return encodeUpdateConflictJSON(value);
  return encodeUpdateResponseJSON(value);
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

export async function serveCanopy(options: {
  mergeTool?: import("./merge-tool.ts").MergeToolOptions;
  dataRoot: string;
  publicOrigin: string;
  community?: {
    handle: string;
    name: string;
    firstWriter?: { handle: string; profileTree: string; name?: string };
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
  }, options.mergeTool);
  if (!dynamicLoopbackOrigin) canopy.setCommunityHost(new URL(publicOrigin).host);
  const pairingClaimAttempts = new Map<string, number[]>();
  const server = Bun.serve({
    port: options.port ?? Number(process.env.PORT ?? 4318),
    hostname: options.hostname ?? "0.0.0.0",
    idleTimeout: 30,
    async fetch(request, server) {
      const token = bearer(request);
      const execution = token?.startsWith("execution_") ? canopy.execution.resolve(token) : undefined;
      if (token?.startsWith("execution_") && !execution) return wireError("unauthenticated", "Execution authorization is unavailable", 401);
      const response = await canopy.execution.run(execution, async () => {
      const url = new URL(request.url);
      const authentication = canopy.authenticateToken(bearer(request));
      const account = authentication?.account ?? (execution?.caller ? canopy.account(execution.caller) : null);
      try {
        if (url.pathname === "/.arbor/execution/authority-watch" && request.method === "GET") {
          if (!execution) return wireError("unauthenticated", "Execution authorization is required", 401);
          server.timeout(request, 0);
          let cleanup = () => {};
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              let closed = false;
              const publish = () => {
                if (closed) return;
                const allowed = canopy.execution.covered(execution);
                controller.enqueue(new TextEncoder().encode(`event: ${allowed ? "refresh" : "revoked"}\ndata: {}\n\n`));
                if (!allowed) { closed = true; cleanup(); controller.close(); }
              };
              const stop = canopy.execution.subscribe(publish);
              const timer = setInterval(() => { if (!canopy.execution.covered(execution)) publish(); }, 250);
              timer.unref?.();
              cleanup = () => { closed = true; stop(); clearInterval(timer); };
              request.signal.addEventListener("abort", () => { cleanup(); try { controller.close(); } catch {} }, { once: true });
              publish();
            },
            cancel() { cleanup(); },
          }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
        }
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
            canopy.verifyDatabase();
            return json({ status: "ok" });
          } catch (error) {
            console.error("Arbor canopy database check failed", error);
            return wireError("internal-error", "Canopy database check failed", 503, true);
          }
        }
        if (request.method === "GET" && url.pathname === "/.arbor/integrity") {
          server.timeout(request, 0);
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
        if (url.pathname === "/.arbor/account-challenges" && request.method === "POST") {
          const body = await request.json() as { account?: unknown; profileTree?: unknown; configurationTree?: unknown };
          if ((body.account !== undefined && typeof body.account !== "string") || typeof body.profileTree !== "string" || typeof body.configurationTree !== "string") {
            throw new Error("Account challenge requires profile TreeID, configuration TreeID, and an optional account URL");
          }
          return json(canopy.createAccountChallenge({
            origin: publicOrigin,
            account: body.account,
            profileTree: body.profileTree,
            configurationTree: body.configurationTree,
          }), 201);
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
          };
          if (
            typeof body.secret !== "string" || typeof body.device?.id !== "string"
            || typeof body.device.label !== "string" || typeof body.device.credentialDigest !== "string"
          ) throw new Error("Pairing claim requires secret, generated device identity, credential digest, and label");
          const claimed = await canopy.claimPairing({
            id: pairingID,
            secret: body.secret,
            deviceID: body.device.id,
            credentialDigest: body.device.credentialDigest,
            label: body.device.label,
          });
          return json({ device: claimed.device, confirmationCode: claimed.confirmationCode }, 201);
        }
        if (url.pathname === "/.arbor/trees") {
          if (request.method === "GET") {
            return json({ snapshot: canopy.list()
              // Retained/retired ordinary roots have no network identity and
              // therefore cannot be represented by a remote TreeDescriptor.
              .filter((tree) => tree.status === "active" && (tree.kind === "account-configuration" || tree.canonicalPath !== null))
              .filter((tree) => canopy.canRead(account, tree.id, linkDigest(request)))
              .map((tree) => descriptorWithUpdate(publicOrigin, canopy, tree, canopy.canWrite(account, tree.id, linkDigest(request)) ? "write" : "read")),
              observedThrough: canopy.observedThrough(),
            });
          }
          return new Response("Method not allowed", { status: 405 });
        }
        if (url.pathname === "/.arbor/directory") {
          if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
          const authenticated = requireAccount(request, canopy);
          return json({
            snapshot: await buildDirectory(canopy, authenticated, publicOrigin),
            observedThrough: canopy.observedThrough(),
          });
        }
        if (url.pathname === "/.arbor/accounts" && request.method === "PUT") {
          const body = await request.json() as {
            account?: unknown;
            profileTree?: unknown;
            configurationTree?: unknown;
            challenge?: AccountChallenge;
            publicKey?: unknown;
            signature?: unknown;
            device?: { id?: unknown; label?: unknown; credentialDigest?: unknown };
            configuration?: { root?: unknown; objects?: unknown };
          };
          let accountURL: URL | undefined;
          try { if (typeof body.account === "string") accountURL = new URL(body.account); } catch {}
          const reservation = accountURL?.origin === publicOrigin ? canopy.accountReservation(body.account as string) : null;
          if (
            !reservation || typeof body.profileTree !== "string" || typeof body.configurationTree !== "string"
            || !body.challenge || typeof body.publicKey !== "string" || typeof body.signature !== "string"
            || typeof body.device?.id !== "string" || typeof body.device.label !== "string"
            || typeof body.device.credentialDigest !== "string" || !body.configuration
          ) throw new Error("Account join requires an exact community reservation, generated identities, credential digest, and initial configuration");
          if (reservation.profileTree && reservation.profileTree !== body.profileTree) {
            throw new Error("Account reservation names a different profile TreeID");
          }
          const result = await canopy.claimAccountWithConfiguration({
            accountLocator: body.account as string,
            handle: reservation.handle,
            origin: publicOrigin,
            profileTree: body.profileTree,
            configurationTree: body.configurationTree,
            challenge: body.challenge,
            publicKey: body.publicKey,
            signature: body.signature,
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
            const administer = canopy.canAdminister(authenticated, treeID);
            const policy = canopy.resourcePolicy(authenticated, treeID);
            if (!administer && !policy) return wireError("not-found", "Tree not found", 404);
            const snapshot: AccessEntry[] = canopy.accessEntries(treeID)
              .filter(() => administer)
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
            return json({ snapshot, ...(policy ? { policy } : {}), observedThrough: canopy.observedThrough(treeID) });
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
        const conflicts = /^\/\.arbor\/trees\/([^/]+)\/conflicts$/.exec(url.pathname);
        if (conflicts && request.method === "GET") {
          const tree = decodeURIComponent(conflicts[1]!);
          if (!canopy.get(tree) || !canopy.canRead(account, tree, linkDigest(request))) return new Response("Not found", { status: 404 });
          const state = url.searchParams.get("state"), after = url.searchParams.get("after"), selected = url.searchParams.get("conflict");
          if (!state || ["state", "after", "conflict"].some(k => url.searchParams.getAll(k).length > 1) ||
              (after !== null && (!after || selected !== null)) || selected === "") {
            return wireError("invalid-request", "Invalid conflict inspection query", 400);
          }
          const page = canopy.conflictPage(tree, state, after ?? undefined, selected ?? undefined);
          return page ? json(page) : new Response("Not found", { status: 404 });
        }
        const acceptedSnapshot = /^\/\.arbor\/trees\/([^/]+)\/snapshots\/(sha256:[a-f0-9]{64})$/.exec(url.pathname);
        if (acceptedSnapshot && request.method === "GET") {
          const treeID = decodeURIComponent(acceptedSnapshot[1]!);
          const root = acceptedSnapshot[2] as ObjectHash;
          const tree = canopy.get(treeID);
          if (!tree || !canopy.canRead(account, tree.id, linkDigest(request))) return new Response("Not found", { status: 404 });
          const snapshot = await canopy.snapshotForRoot(tree.id, root);
          if (!snapshot) return new Response("Not found", { status: 404 });
          const body = encodeSnapshotBundle(snapshot);
          return new Response(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, {
            headers: immutableHeaders(request, `sha256:${sha256(body)}`),
          });
        }
        const updates = /^\/\.arbor\/trees\/([^/]+)\/updates$/.exec(url.pathname);
        if (updates) {
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          const treeID = decodeURIComponent(updates[1]!);
          const timer = new PhaseTimer();
          const countersBefore = canopy.objectCounters();
          return await withPhaseTimer(timer, async () => {
            // Read the body as text so the request's encoded size can be
            // recorded; `trace-frames` counts the authored steps and
            // `trace-ops` the operations across them. All are diagnostics,
            // never content.
            const raw = await request.text();
            const body = JSON.parse(raw) as Record<string, unknown>;
            timer.mark("body");
            timer.count("body-bytes", new TextEncoder().encode(raw).length);
            const update = decodeUpdateRequestJSON(body);
            timer.count("trace-frames", update.updates.reduce((sum, element) => sum + (element.trace?.length ?? 0), 0));
            timer.count("trace-ops", update.updates.reduce((sum, element) =>
              sum + (element.trace ?? []).reduce((ops, frame) => ops + frame.operations.length, 0), 0));
            const tree = canopy.get(treeID);
            const link = linkDigest(request);
            const writable = tree ? canopy.canWrite(account, treeID, link) : false;
            // A null base activates a reserved tree, which has no descriptor yet;
            // Canopy checks the reservation and the administrator device.
            const direct = !execution && tree && !writable
              ? canopy.scopedCaller(account, treeID, authentication?.subject ?? "public", () => !authentication || canopy.authenticationIsActive(authentication), link) : undefined;
            const permitted = tree
              ? writable || canopy.execution.canSubmit(treeID) || (direct && canopy.execution.run(direct, () => canopy.execution.canSubmit(treeID)))
              : update.base === null && authentication !== null;
            if (!permitted) return new Response("Not found", { status: 404 });
            timer.mark("parse-auth");
            let result: Awaited<ReturnType<typeof canopy.submitUpdate>>;
            try {
              result = await canopy.execution.run(execution ?? direct, () => canopy.submitUpdate(
                treeID,
                update,
                account,
                link,
                authentication?.subject,
                authentication ?? undefined,
              ));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logUpdate({ event: "update", tree: treeID, status: "error", error: message, updates: update.updates.length, ...timer.summary() });
              throw error;
            }
            if (direct && !canopy.execution.covered(direct)) return wireError("permission-denied", "Authorization changed before receipt disclosure", 403);
            // The server's current head lets the client skip a descriptor read
            // after acceptance; the watch still delivers anything newer.
            const headTree = canopy.get(treeID), headUpdate = headTree ? canopy.currentUpdate(treeID) : null;
            const payload = updateJSON(result.result) as Record<string, unknown>;
            if (headTree && headUpdate && !("error" in result.result)) {
              payload.head = { update: headUpdate.id, root: headTree.ref, conflicted: headUpdate.conflicted, observedThrough: canopy.observedThrough(treeID) };
            }
            const response = json(payload, result.status, { "server-timing": timer.serverTiming() });
            timer.mark("respond");
            const counters = canopy.objectCounters();
            for (const key of Object.keys(counters)) timer.count(key, Math.round((counters[key]! - countersBefore[key]!) * 10) / 10);
            // Diagnostics only: tree identity, outcome, and durations. No subjects,
            // request content, or object identities.
            const accepted = "results" in result.result ? result.result.results.map((element) => element.update.id) : [];
            logUpdate({ event: "update", tree: treeID, status: result.status, updates: update.updates.length, accepted, ...timer.summary() });
            return response;
          });
        }
        const watch = /^\/\.arbor\/trees\/([^/]+)\/watch$/.exec(url.pathname);
        if (watch && request.method === "GET") {
          const tree = canopy.get(decodeURIComponent(watch[1]!));
          const requestedLinkDigest = linkDigest(request);
          if (!tree || !canopy.canRead(account, tree.id, requestedLinkDigest)) return new Response("Not found", { status: 404 });
          // Watch streams stay open indefinitely; lift Bun's per-connection idle timeout for them.
          server.timeout(request, 0);
          const encoder = new TextEncoder();
          const credentialSubject = authentication?.subject;
          const access = canopy.canWrite(account, tree.id, requestedLinkDigest) ? "write" : "read";
          const headerCursor = request.headers.get("last-event-id");
          const queryCursor = url.searchParams.get("after");
          if (headerCursor && queryCursor && headerCursor !== queryCursor) {
            return wireError("invalid-request", "after and Last-Event-ID disagree", 400);
          }
          const lastEventID = queryCursor ?? headerCursor;
          const keepaliveRequested = request.headers.get("arbor-watch-keepalive") === "1";
          /** Encode a contiguous run of accepted updates as bounded `tree.update` frames, or null when any transition is unavailable. */
          const refFrames = (records: ObservationRecord[]): string[] | null => {
            const current = canopy.get(tree.id) ?? tree;
            const transitions: AcceptedTransition[] = [];
            const cursors = new Map<string, string>();
            for (const record of records) {
              if (!record.updateID) continue;
              cursors.set(record.updateID, record.cursor);
              const transition = canopy.acceptedTransition(record.updateID, credentialSubject);
              if (!transition) return null;
              transitions.push(transition);
            }
            const frame = (items: AcceptedTransition[]) => {
              const cursor = cursors.get(items.at(-1)!.update.id)!;
              return encodeSSEFrame({
                id: cursor,
                event: "tree.update",
                data: watchDescriptor(publicOrigin, current, items, access, cursor),
              });
            };
            return encodeWatchFrames(transitions, frame, MAX_WATCH_TRANSITIONS_PER_FRAME, MAX_WATCH_TRANSITION_FRAME_BYTES);
          };
          let closed = false;
          let delivered = 0;
          let frames: string[] = [];
          let wake: (() => void) | undefined;
          let stop = () => {};
          let resync = (_reason: string) => {};
          const authorized = () => {
            const active = !authentication || canopy.authenticationIsActive(authentication);
            return active && canopy.execution.run(execution, () => canopy.canRead(account, tree.id, requestedLinkDigest));
          };
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              resync = (reason: string) => {
                if (closed) return;
                closed = true;
                const cursor = canopy.observedThrough(tree.id);
                const event: ObservationEvent<"resync-required", {reason: string}> = {
                  cursor, tree: tree.id, kind: "resync-required", change: {reason},
                };
                controller.enqueue(encoder.encode(encodeSSEFrame({id: cursor, event: "resync-required", data: event})));
                stop(); controller.close();
              };
              const stopObserving = canopy.subscribeObservations(tree.id, () => { wake?.(); wake = undefined; });
              const timer = setInterval(() => { if (!authorized()) resync("Authorization was revoked"); }, 250);
              timer.unref?.();
              const abort = () => {
                if (closed) return;
                closed = true; stop();
                try { controller.close(); } catch {}
              };
              stop = () => {
                clearInterval(timer); stopObserving();
                request.signal.removeEventListener("abort", abort);
                frames = []; wake?.(); wake = undefined;
              };
              request.signal.addEventListener("abort", abort, {once: true});
              if (request.signal.aborted) return abort();
              const position = canopy.observationPosition(tree.id, lastEventID);
              if (!position.retained) return resync("The requested cursor is no longer retained");
              delivered = position.through;
              if (execution) controller.enqueue(encoder.encode(": authorized\n\n"));
              // Clients that opt in receive an immediate comment so headers flush
              // through proxies and an open stream is distinguishable from a
              // stalled connect, then periodic comments through proxy idle
              // timeouts. Older clients reject comment-only blocks, so this is
              // never sent unrequested.
              if (keepaliveRequested) {
                controller.enqueue(encoder.encode(": ready\n\n"));
                const keepalive = setInterval(() => {
                  if (closed) return;
                  try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* closing */ }
                }, WATCH_KEEPALIVE_MS);
                keepalive.unref?.();
                const stopTimers = stop;
                stop = () => { clearInterval(keepalive); stopTimers(); };
              }
            },
            async pull(controller) {
              try {
                while (!closed) {
                  if (!authorized()) return resync("Authorization was revoked");
                  if (frames.length) { controller.enqueue(encoder.encode(frames.shift()!)); return; }
                  const records = canopy.observationPage(tree.id, delivered);
                  if (!records.length) {
                    // Subscription precedes the position read. There is no await
                    // between checking the log and installing this wakeup.
                    await new Promise<void>(resolve => { wake = resolve; });
                    continue;
                  }
                  const encoded = records.length > 1 ? null : refFrames(records);
                  if (!encoded) {
                    const net = await canopy.netAcceptedTransition(tree.id, delivered, credentialSubject).catch(() => null);
                    if (closed) return;
                    if (!authorized()) return resync("Authorization was revoked");
                    if (!net) return resync("The requested accepted basis is no longer retained");
                    delivered = net.record.ordinal;
                    frames = [encodeSSEFrame({id: net.record.cursor, event: "tree.update",
                      data: watchDescriptor(publicOrigin, canopy.get(tree.id) ?? tree, [net.transition], access, net.record.cursor)})];
                    continue;
                  }
                  delivered = records.at(-1)!.ordinal;
                  frames = encoded;
                }
              } catch (error) { closed = true; stop(); controller.error(error); }
            },
            cancel() { closed = true; stop(); },
          }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
        }

        const object = /^\/\.arbor\/trees\/([^/]+)\/objects\/(sha256:[a-f0-9]{64})$/.exec(url.pathname);
        if (object && request.method === "GET") {
          const treeID = decodeURIComponent(object[1]!);
          const hash = object[2] as ObjectHash;
          if (!canopy.isReadableObject(treeID, account, linkDigest(request))) return wireError("not-found", "Object not found in the named tree", 404, false, {}, { tree: treeID });
          const bytes = await canopy.retainedObject(hash);
          if (!bytes) return wireError("not-found", "Object not found in the named tree", 404, false, {}, { tree: treeID });
          return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
            headers: { ...immutableHeaders(request, hash), "content-type": "application/octet-stream" },
          });
        }
        if (request.method === "GET" && !url.pathname.startsWith("/.")) {
          const requestLocator = resolveLogicalURL("/", `${url.pathname}${url.search}`);
          if (!requestLocator || requestLocator.kind !== "local") return new Response("Not found", { status: 404 });
          const pendingProfile = /^\/~([a-z0-9][a-z0-9-]{0,62})\/?$/.exec(requestLocator.path);
          if (pendingProfile && canopy.isReservedHandle(pendingProfile[1]!)) {
            const profileURL = `${publicOrigin}/~${pendingProfile[1]!}`;
            return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>~${escapeHTML(pendingProfile[1]!)}</title><style>body{max-width:620px;margin:72px auto;padding:0 24px;font:16px/1.55 system-ui;color:#292823}code{display:block;padding:12px;background:#f4f2ec;border-radius:8px}</style><h1>~${escapeHTML(pendingProfile[1]!)}</h1><p>This account is reserved by the ${escapeHTML(canopy.communityHandle())} community for one exact profile identity. It has not been claimed.</p><p>Its owner can open it in Arbor to claim it:</p><code>arbor open ${escapeHTML(profileURL)}</code>`, 200, { "x-arbor-profile-state": "reserved" });
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

          const objectName = logical.objectName || canonicalPath.split("/").at(-1) || "Arbor";
          if (logical.kind === "file") {
            const body = new TextDecoder().decode(logical.bytes);
            if (objectName.endsWith(".md")) {
              if (request.headers.get("accept")?.includes("text/markdown")) {
                return new Response(logical.bytes.buffer.slice(
                  logical.bytes.byteOffset,
                  logical.bytes.byteOffset + logical.bytes.byteLength,
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
            return new Response(logical.bytes.buffer.slice(
              logical.bytes.byteOffset,
              logical.bytes.byteOffset + logical.bytes.byteLength,
            ) as ArrayBuffer);
          }
          const prefix = (tree.canonicalPath === "/"
            ? logicalPath
            : `${tree.canonicalPath}${logicalPath === "/" ? "" : logicalPath}`)
            .split("/").map((part) => encodeURIComponent(part)).join("/").replace(/\/$/, "");
          const source = logical.body ? new TextDecoder().decode(logical.body) : "";
          if (request.headers.get("accept")?.includes("text/markdown")) {
            return new Response(source, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" } });
          }
          const collectionFileDescriptor = logical.directory.childrenSource;
          const collectionFile = await wireProjection.collectionFile(logical.directory);
          const physicalChildren = (await Promise.all(logical.directory.entries
            .filter((entry) => entry.name !== "_index.md"
              && entry.name !== collectionFileDescriptor?.source
              && entry.name !== collectionFileDescriptor?.schemaSource)
            .map(async (entry): Promise<PublicPageChild | null> => {
              if (entry.tree) {
                const nested = canopy.get(entry.tree);
                if (!nested || !canopy.canRead(account, nested.id, linkDigest(request))) return null;
              }
              const markdown = entry.file !== undefined && entry.name.endsWith(".md");
              const publicName = markdown ? entry.name.slice(0, -3) : entry.name;
              return {
                name: publicName,
                href: `${prefix}/${encodeURIComponent(publicName)}${url.search}`,
                kind: entry.tree || entry.directory !== undefined ? "folder" : markdown ? "document" : "file",
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
        if (error instanceof IntentError && error.code === "limit" && error.message === "Evaluation time budget exceeded") {
          return wireError("internal-error", error.message, 503, true);
        }
        if (error instanceof RefConflictError) {
          return wireError("conflict", "The tree ref changed before the mutation committed", 409, false, {
            kind: "server-update",
            current: error.current,
          });
        }
        if (error instanceof UpdateProtocolError) {
          if (error.code === "unsupported-operation") return wireError(error.code, error.message, 422);
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
        if (error instanceof MergeWorkerError) {
          return error.retryable
            ? wireError("merge-failed", error.message, 503, true)
            : wireError("merge-failed", error.message, 422);
        }
        const message = error instanceof Error ? error.message : String(error);
        if (/authentication is required/i.test(message)) return wireError("unauthenticated", message, 401);
        if (/not allowed|only an administrator|may not edit|not active|active account device|permission/i.test(message)) {
          return wireError("permission-denied", message, 403);
        }
        if (/unknown tree|not found/i.test(message)) return wireError("not-found", message, 404);
        return wireError("invalid-request", message, 400);
      }
      });
      if (execution && !canopy.execution.covered(execution)) {
        await response.body?.cancel().catch(() => {});
        return wireError("permission-denied", "Execution authorization is unavailable", 403);
      }
      return response;
    },
  });
  if (dynamicLoopbackOrigin) {
    publicOrigin = `${publicOrigin.slice(0, publicOrigin.lastIndexOf(":"))}:${server.port}`;
  }
  if (dynamicLoopbackOrigin) canopy.setCommunityHost(new URL(publicOrigin).host, true);
  await canopy.ensureAccountConfigTrees(publicOrigin);
  return { canopy, server, url: publicOrigin };
}
