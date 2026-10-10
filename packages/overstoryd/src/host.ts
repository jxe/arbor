import { AlreadyClaimedError, AuthenticationRequiredError, ExpiredChallengeError, HomeHostUnavailableError, isServerFault, NotFoundError, PermissionDeniedError, PlacementAccountError, RefConflictError, ReservedBoundaryConflictError, ServerBusyError, ServerFaultError, UpdateProtocolError } from "./errors.ts";
import { MergeWorkerError } from "./merge-tool.ts";
import { AttemptLimiter } from "./attempt-limiter.ts";
import { resolve } from "node:path";
import { treeConfigurationID, parseTreeReference, decodeCandidateUpdateJSON, encodeSnapshotBundle, encodeUpdateConflictJSON, encodeUpdateResponseJSON, type UpdateHead, buildNetworkLocator, canonicalOverstoryLocator, encodeSSEFrame, markdownSourceDirectory, resolveLogicalURL, sha256, isTreeID } from "@ovst/protocol";
import { WIRE_CONTENT_TYPE, acceptsCBOR, decodeWireBody, encodeWireBody, wireEncodingOf, type TreeSnapshot, type WireEncoding } from "@ovst/protocol";
import type { AccountChallenge, LocatorResolution, MutationCallRuntime, QueryStreamRuntime, ReadWriteAccess, RemoteTreeDescriptor } from "@ovst/protocol";
import { treeMutationResponse, treeQueryResponse } from "@ovst/apps-runtime/host";
import {
  HostDaemon,
  type HostAccount,
  type HostAuthentication,
  type HostTree,
  type HostBootstrapAccount,
  type HostDaemonOptions,
  type StoredUpdateResponse,
} from "./overstoryd.ts";
import { handleOfPath } from "./profile.ts";
import { PhaseTimer, withPhaseTimer } from "./updates/timing.ts";
import {
  decodeUpdateRequestJSON,
  encodeAcceptedTransitionJSON,
  type AcceptedTransition,
  type AcceptedUpdate,
  type ObjectHash,
  type RemoteAccountDescriptor,
  type RemotePlacementAccountDescriptor,
} from "@ovst/protocol";
import { escapeHTML, publicTreePath, renderNoticePage, renderPublicDataPage, renderPublicMarkdownPage, type PublicPageChild } from "./public-page.ts";
import { ProtocolProjection, protocolCollectionFileRowMarkdown, protocolCollectionFileRowTitle } from "./projection.ts";
import { buildDirectory } from "./directory.ts";


/** Comment frames keep watch streams alive across proxy idle timeouts. */
const WATCH_KEEPALIVE_MS = 20_000;

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** A success answered in the encoding the request's `Accept` asked for; errors stay `json` (tree operations §4.4). */
function wire(value: unknown, encoding: WireEncoding, status = 200, headers: Record<string, string> = {}): Response {
  if (encoding === "json") return json(value, status, headers);
  return new Response(encodeWireBody(value, encoding) as Uint8Array<ArrayBuffer>, {
    status,
    headers: { "content-type": WIRE_CONTENT_TYPE.cbor, "cache-control": "no-store", ...headers },
  });
}

/** The encoding a request asks its success response in. */
function answerEncoding(request: Request): WireEncoding {
  return acceptsCBOR(request.headers.get("accept")) ? "cbor" : "json";
}

/** A request body as a wire value, read by its `Content-Type`; `bytes` is its size on the wire. */
async function wireBody(request: Request): Promise<{ value: unknown; encoding: WireEncoding; bytes: number }> {
  const encoding = wireEncodingOf(request.headers.get("content-type"));
  const raw = new Uint8Array(await request.arrayBuffer());
  return { value: decodeWireBody(raw, encoding), encoding, bytes: raw.byteLength };
}

/** A request body's fields, in either wire encoding; anything but an object is refused. */
async function bodyFields(request: Request): Promise<Record<string, unknown>> {
  const { value } = await wireBody(request);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The request body must be an object");
  return value as Record<string, unknown>;
}

/**
 * A claim's configuration: the configuration tree's activation element, the
 * same shape `declareTree` sends (accounts §1.2), carrying the complete first
 * snapshot.
 */
function claimConfiguration(value: unknown, encoding: WireEncoding): { configurationSnapshot: TreeSnapshot; configurationChange: string } {
  const element = decodeCandidateUpdateJSON(value, true, encoding);
  if (element.trace !== null) throw new Error("A claim's configuration is a snapshot activation element with a null trace");
  return {
    configurationSnapshot: { root: element.candidate, objects: new Map(element.objects.map(({ hash, bytes }) => [hash, bytes])) },
    configurationChange: element.change,
  };
}

/** One structured line per update request; silent under the test runner. */
function logUpdate(record: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "test") return;
  console.log(JSON.stringify(record));
}

/** One structured line per request rejected as invalid; silent under the test runner. */
function logRequestError(record: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "test") return;
  console.warn(JSON.stringify({ event: "request-rejected", ...record }));
}

function immutableHeaders(request: Request, etag: string): HeadersInit {
  const scope = request.headers.has("authorization") || request.headers.has("overstory-access-link")
    ? "private"
    : "public";
  return {
    "content-type": "application/cbor",
    "cache-control": `${scope}, max-age=31536000, immutable`,
    vary: "Authorization, Overstory-Access-Link",
    etag: `"${etag}"`,
  };
}

function protocolError(
  error: string,
  message: string,
  status: number,
  retryable = false,
  details: Record<string, unknown> = {},
  context: { tree?: string; path?: string } = {},
): Response {
  return json({ error, message, retryable, ...context, ...(Object.keys(details).length ? { details } : {}) }, status);
}

/** A tree's canonical placement at this origin, or null for a tree mounted nowhere. */
function canonicalOf(origin: string, tree: HostTree): RemoteTreeDescriptor["canonical"] {
  return tree.canonicalPath === null ? null : {
    path: tree.canonicalPath as `/${string}`,
    endpoint: `${origin}/.overstory/trees/${encodeURIComponent(tree.id)}`,
    parentTree: tree.parentTree,
  } as RemoteTreeDescriptor["canonical"];
}

/** The `overstory://` locator of a canonical tree, or null for a noncanonical one. */
function overstoryLocator(origin: string, tree: HostTree): string | null {
  const canonical = canonicalOf(origin, tree);
  return canonical ? canonicalOverstoryLocator(canonical) : null;
}

/** A tree's descriptor at `head`, one of its accepted updates. */
function descriptor(origin: string, tree: HostTree, access: ReadWriteAccess, head: Pick<AcceptedUpdate, "id" | "root" | "conflicted">): RemoteTreeDescriptor {
  return {
    id: tree.id,
    kind: tree.kind,
    access,
    canonical: canonicalOf(origin, tree),
    root: head.root as RemoteTreeDescriptor["root"],
    update: head.id,
    conflicted: head.conflicted,
  };
}

function descriptorWithUpdate(
  origin: string,
  overstoryd: HostDaemon,
  tree: HostTree,
  access: ReadWriteAccess = "read",
): RemoteTreeDescriptor {
  const update = overstoryd.currentUpdate(tree.id);
  if (!update) throw new ServerFaultError(`Tree has no accepted update: ${tree.id}`);
  return descriptor(origin, tree, access, update);
}

/**
 * A `tree.update` frame's data (tree operations §1.1.3): the one transition
 * and what the client cannot derive for its new descriptor. The cursor is the
 * frame's SSE `id` and the tree is the URL's.
 */
function watchFrame(origin: string, tree: HostTree, transition: AcceptedTransition, access: ReadWriteAccess) {
  return {
    transition: encodeAcceptedTransitionJSON(transition),
    access,
    canonical: descriptor(origin, tree, access, transition.update).canonical,
  };
}


/**
 * An update answer: a success in the requested encoding with the tree's
 * current head, which the client installs without a descriptor read (the
 * watch still delivers anything newer); a conflict always as its JSON envelope.
 */
function updateResponse(overstoryd: HostDaemon, treeID: string, value: StoredUpdateResponse["result"], encoding: WireEncoding, status: number, headers: Record<string, string> = {}): Response {
  if ("error" in value) return json(encodeUpdateConflictJSON(value), status, headers);
  const tree = overstoryd.get(treeID), update = tree ? overstoryd.currentUpdate(treeID) : null;
  if (!tree || !update) throw new Error(`An accepted update left no head for ${treeID}`);
  const head: UpdateHead = { update: update.id, root: tree.ref as ObjectHash, conflicted: update.conflicted, observedThrough: overstoryd.observedThrough(treeID) };
  return wire(encodeUpdateResponseJSON({ ...value, head }, encoding), encoding, status, headers);
}

function accountDescriptor(origin: string, overstoryd: HostDaemon, account: HostAccount): RemoteAccountDescriptor | RemotePlacementAccountDescriptor {
  if (account.homeHost) return placementAccountDescriptor(origin, overstoryd, account);
  const profile = overstoryd.get(account.id);
  const configuration = overstoryd.get(treeConfigurationID(account.id));
  const community = overstoryd.community();
  if (!configuration) throw new ServerFaultError("Account configuration tree is missing");
  return {
    id: account.id,
    handle: account.handle,
    profileTree: account.id,
    profileURL: profile ? overstoryLocator(origin, profile) : null,
    community: descriptorWithUpdate(origin, overstoryd, community, overstoryd.canWrite(account, community) ? "write" : "read"),
    configuration: descriptorWithUpdate(origin, overstoryd, configuration, "write"),
    writableProfiles: overstoryd.writableProfiles(account).map((tree) => descriptorWithUpdate(origin, overstoryd, tree, "write")),
  };
}

/**
 * A placement account's descriptor (accounts §1.3): its home host and its
 * placement root, and no configuration, which only the home host holds.
 */
function placementAccountDescriptor(origin: string, overstoryd: HostDaemon, account: HostAccount): RemotePlacementAccountDescriptor {
  const community = overstoryd.community();
  const rootID = overstoryd.placementRootOf(account);
  if (!rootID) throw new ServerFaultError("Placement account has no placement root");
  const root = overstoryd.get(rootID);
  return {
    id: account.id,
    handle: account.handle,
    profileTree: account.id,
    profileURL: null,
    homeHost: account.homeHost!,
    placementRoot: {
      id: rootID,
      path: `/~${account.handle}`,
      tree: root ? descriptorWithUpdate(origin, overstoryd, root, overstoryd.accessLevel(account, root) ?? "read") : null,
    },
    community: descriptorWithUpdate(origin, overstoryd, community, overstoryd.canWrite(account, community) ? "write" : "read"),
    writableProfiles: overstoryd.writableProfiles(account).map((tree) => descriptorWithUpdate(origin, overstoryd, tree, "write")),
  };
}

/**
 * A tree in a route: `tr_x`, or `tr_x;overstory-config` for its configuration,
 * which the host answers under the configuration's derived TreeID and only to
 * the tree's administrators.
 */
function treeReference(segment: string): { id: string; governs?: string } {
  const decoded = currentConfigurationSpelling(decodeURIComponent(segment));
  try {
    const reference = parseTreeReference(decoded);
    return reference.configuration ? { id: treeConfigurationID(reference.tree), governs: reference.tree } : { id: reference.tree };
  } catch {
    return { id: decoded };
  }
}

/** The caller's address as the edge proxy reports it. overstoryd trusts these
 * headers without checking who set them. Behind Railway's edge alone (see
 * deploy/README.md) a client-supplied `cf-connecting-ip` passes through, as
 * does a forged leading `x-forwarded-for` entry wherever the edge appends
 * rather than replaces; only a proxy that overwrites them, such as
 * Cloudflare, makes them trustworthy. The address is a best-effort
 * rate-limit key, never an identity. */
function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

const CONFIGURATION_SUFFIX = ";overstory-config";
// Rename 002: links shared before the rename end in `;arbor-config`. It is
// read wherever the suffix is; redirects and new links write only the current one.
const OLD_CONFIGURATION_SUFFIX = ";arbor-config";

/** `value` with an old-spelling configuration suffix rewritten to the current one. */
function currentConfigurationSpelling(value: string): string {
  return value.endsWith(OLD_CONFIGURATION_SUFFIX)
    ? `${value.slice(0, -OLD_CONFIGURATION_SUFFIX.length)}${CONFIGURATION_SUFFIX}`
    : value;
}

/** The configuration of the tree whose canonical root is `path`, or null when no tree's root is there. */
function configurationAt(overstoryd: HostDaemon, path: string) {
  const resolved = overstoryd.resolve(path);
  if (!resolved || resolved.path !== "/") return null;
  return overstoryd.get(treeConfigurationID(resolved.tree.id));
}

function bearer(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

function linkDigest(request: Request): string | undefined {
  const secret = request.headers.get("overstory-access-link") ?? undefined;
  return secret ? `sha256:${sha256(secret)}` : undefined;
}

function linkBootstrap(): Response {
  return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Overstory access</title><body><p>Opening shared Overstory tree…</p><script>
// Rename 002: links shared before the rename carry "#arbor-access=".
const marker = ["#overstory-access=", "#arbor-access="].find(prefix => location.hash.startsWith(prefix));
const secret = marker ? decodeURIComponent(location.hash.slice(marker.length)) : "";
if (!secret) document.body.textContent = "This Overstory tree requires access.";
else fetch(location.pathname + location.search, { headers: { "Overstory-Access-Link": secret } })
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

/**
 * A long-lived stream's authorization check, re-evaluated only when
 * `authorizationEpoch` shows the database or execution authority changed.
 * Watches poll it often; between changes it costs one trivial query.
 */
function cachedAuthorization(overstoryd: HostDaemon, check: () => boolean): (epoch?: string) => boolean {
  let epoch: string | undefined;
  let allowed = false;
  return (current = overstoryd.authorizationEpoch()) => {
    if (current !== epoch) {
      allowed = check();
      epoch = current;
    }
    return allowed;
  };
}

/**
 * One timer for every open stream's revocation check. Each tick reads the
 * authorization epoch once and hands it to every stream, so an idle host with
 * many watchers runs one trivial query per tick, not one per watcher.
 */
function authorizationTicker(overstoryd: HostDaemon, intervalMs = 250) {
  const checks = new Set<(epoch: string) => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  return (check: (epoch: string) => void): (() => void) => {
    checks.add(check);
    if (!timer) {
      timer = setInterval(() => {
        const epoch = overstoryd.authorizationEpoch();
        for (const each of [...checks]) each(epoch);
      }, intervalMs);
      timer.unref?.();
    }
    return () => {
      checks.delete(check);
      if (!checks.size && timer) { clearInterval(timer); timer = undefined; }
    };
  };
}

/** The request's device-authenticated account; execution tokens never qualify. */
function requireAccount(authentication: HostAuthentication | null): HostAccount {
  if (!authentication) throw new AuthenticationRequiredError("Account authentication is required");
  return authentication.account;
}

export async function serveHost(options: {
  mergeTool?: import("./merge-tool.ts").MergeToolOptions;
  dataRoot: string;
  publicOrigin: string;
  community?: {
    handle: string;
    name: string;
    firstWriter?: { handle: string; profileTree: string; name?: string };
  };
  accounts?: HostBootstrapAccount[];
  port?: number;
  hostname?: string;
  queryRuntime?: QueryStreamRuntime;
  mutationRuntime?: MutationCallRuntime;
  /** Session and placement device-key lifetimes; tests shorten them. */
  lifetimes?: Omit<HostDaemonOptions, "servedOverHTTP">;
  /**
   * Bound unauthenticated session challenges and pairing claims per caller.
   * Off unless asked for: with one person's devices behind each host, a
   * client retrying through an outage tripped it and hid the real refusal.
   */
  rateLimits?: boolean;
}) {
  const bootstrapAccounts = options.accounts ?? [];
  let publicOrigin = options.publicOrigin.replace(/\/$/, "");
  const dynamicLoopbackOrigin = /^https?:\/\/(?:127\.0\.0\.1|localhost):0$/.test(publicOrigin);
  const overstoryd = await HostDaemon.open(resolve(options.dataRoot), {
    handle: options.community?.handle ?? "community",
    name: options.community?.name ?? "Overstory Community",
    accounts: bootstrapAccounts,
    ...(options.community?.firstWriter ? { firstWriter: options.community.firstWriter } : {}),
  }, options.mergeTool, { ...options.lifetimes, servedOverHTTP: new URL(publicOrigin).protocol === "http:" });
  if (!dynamicLoopbackOrigin) overstoryd.setCommunityHost(new URL(publicOrigin).host);
  const onAuthorizationTick = authorizationTicker(overstoryd);
  const pairingClaims = options.rateLimits ? new AttemptLimiter(10, 10 * 60 * 1000) : null;
  const challenges = options.rateLimits ? new AttemptLimiter(30, 10 * 60 * 1000) : null;
  /** Unauthenticated challenges are cheap to ask for; with rate limits on, bound them per caller and profile. */
  const challengeAllowed = (request: Request, scope: string): boolean =>
    challenges?.allow(`${clientAddress(request)}:${scope}`) ?? true;
  const server = Bun.serve({
    port: options.port ?? Number(process.env.PORT ?? 4318),
    hostname: options.hostname ?? "0.0.0.0",
    idleTimeout: 30,
    async fetch(request, server) {
      const token = bearer(request);
      const execution = token?.startsWith("execution_") ? overstoryd.execution.resolve(token) : undefined;
      if (token?.startsWith("execution_") && !execution) return protocolError("unauthenticated", "Execution authorization is unavailable", 401);
      const response = await overstoryd.execution.run(execution, async () => {
      const url = new URL(request.url);
      // The one authentication of this request; routes below reuse it.
      const authentication = overstoryd.authenticateToken(token);
      // A presented token that authenticates nothing (an expired session, a
      // deleted device) is refused, never read as anonymous: a 404 for a
      // private tree would hide the reason and clients refresh only on 401.
      if (token && !execution && !authentication) return protocolError("unauthenticated", "The session is not valid", 401);
      const account = authentication?.account ?? (execution?.caller ? overstoryd.account(execution.caller) : null);
      const link = linkDigest(request);
      /** The tree a route segment names, with the caller's access; an unreadable tree is not found. */
      /** A route segment's tree reference, refused with 403 when it names a
       * placement account's profile configuration, which its home host holds. */
      const hostedReference = (segment: string): { id: string; governs?: string } => {
        const reference = treeReference(segment);
        if (reference.governs) overstoryd.refuseOwnConfigurationOf(reference.governs);
        else overstoryd.refusePlacementConfigurationID(reference.id);
        return reference;
      };
      const readableTree = (segment: string): { tree: HostTree; level: ReadWriteAccess } => {
        const reference = hostedReference(segment);
        const tree = overstoryd.get(reference.id);
        const level = tree ? overstoryd.accessLevel(account, tree, link) : null;
        if (!tree || !level) throw new NotFoundError("Tree not found");
        return { tree, level };
      };
      const notFound = (message = "Not found") => protocolError("not-found", message, 404);
      const methodNotAllowed = () => protocolError("invalid-request", "Method not allowed", 405);
      try {
        if (url.pathname === "/.overstory/execution/authority-watch" && request.method === "GET") {
          if (!execution) return protocolError("unauthenticated", "Execution authorization is required", 401);
          server.timeout(request, 0);
          let cleanup = () => {};
          // Token validity (revocation, expiry, its host callback) is checked
          // every time; the grants' database-backed permissions only on change.
          const permitted = cachedAuthorization(overstoryd, () => overstoryd.execution.covered(execution));
          const covered = (epoch?: string) => overstoryd.execution.valid(execution) && permitted(epoch);
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              let closed = false;
              const publish = () => {
                if (closed) return;
                const allowed = covered();
                controller.enqueue(new TextEncoder().encode(`event: ${allowed ? "refresh" : "revoked"}\ndata: {}\n\n`));
                if (!allowed) { closed = true; cleanup(); controller.close(); }
              };
              const stop = overstoryd.execution.subscribe(publish);
              const stopTicks = onAuthorizationTick((epoch) => { if (!covered(epoch)) publish(); });
              cleanup = () => { closed = true; stop(); stopTicks(); };
              request.signal.addEventListener("abort", () => { cleanup(); try { controller.close(); } catch {} }, { once: true });
              publish();
            },
            cancel() { cleanup(); },
          }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
        }
        const queryRoute = /^\/\.overstory\/trees\/([^/]+)\/queries$/.exec(url.pathname);
        if (request.method === "QUERY" && queryRoute) {
          if (!options.queryRuntime) return protocolError("unsupported-operation", "No query runtime is active", 422);
          const treeID = readableTree(queryRoute[1]!).tree.id;
          server.timeout(request, 0);
          return treeQueryResponse(
            options.queryRuntime,
            request,
            treeID,
            account ? { profile: account.id } : null,
          );
        }
        const mutateRoute = /^\/\.overstory\/trees\/([^/]+)\/mutate$/.exec(url.pathname);
        if (request.method === "POST" && mutateRoute) {
          if (!options.mutationRuntime) return protocolError("unsupported-operation", "No mutation runtime is active", 422);
          const { tree, level } = readableTree(mutateRoute[1]!);
          if (!account || level !== "write") return notFound("Tree not found");
          const treeID = tree.id;
          return treeMutationResponse(
            options.mutationRuntime,
            request,
            treeID,
            { profile: account.id },
          );
        }
        if (request.method === "GET" && url.pathname === "/.overstory/health") {
          try {
            overstoryd.verifyDatabase();
            return json({ status: "ok" });
          } catch (error) {
            console.error("overstoryd database check failed", error);
            return protocolError("internal-error", "Host database check failed", 503, true);
          }
        }
        if (request.method === "GET" && url.pathname === "/.overstory/integrity") {
          server.timeout(request, 0);
          try {
            await overstoryd.verifyIntegrity();
            return json({ status: "ok" });
          } catch (error) {
            console.error("overstoryd integrity check failed", error);
            return protocolError("internal-error", "Host integrity check failed", 503, true);
          }
        }
        if (request.method === "GET" && url.pathname === "/.overstory/account") {
          const authenticated = requireAccount(authentication);
          const currentDevice = overstoryd.devices(authenticated).find((device) => device.id === authentication!.device);
          return json({
            account: {
              ...accountDescriptor(publicOrigin, overstoryd, authenticated),
              ...(currentDevice ? { device: { id: currentDevice.id, label: currentDevice.label } } : {}),
            },
          });
        }
        if (url.pathname === "/.overstory/pairings" && request.method === "POST") {
          return json(overstoryd.createPairing(requireAccount(authentication)), 201);
        }
        const publishedKeys = /^\/\.overstory\/profiles\/(tr_[a-z2-7]+)\/device-keys$/.exec(url.pathname);
        if (publishedKeys && request.method === "GET") {
          // Public: a placement host reads it without authenticating (accounts §5.4).
          return json(await overstoryd.publishedDeviceKeys(publishedKeys[1]!), 200, { "cache-control": "no-cache" });
        }
        if (url.pathname === "/.overstory/device-sessions/challenges" && request.method === "POST") {
          const body = await bodyFields(request) as { profileTree?: unknown; device?: unknown };
          if (typeof body.profileTree !== "string" || typeof body.device !== "string") throw new Error("A session challenge names a profile TreeID and a DeviceID");
          if (!challengeAllowed(request, `session:${body.profileTree}`)) return protocolError("rate-limited", "Too many challenges", 429, true);
          return json(await overstoryd.createDeviceSessionChallenge({ origin: publicOrigin, profileTree: body.profileTree, device: body.device }), 201);
        }
        if (url.pathname === "/.overstory/device-sessions" && request.method === "POST") {
          const body = await bodyFields(request) as { challenge?: unknown; signature?: unknown };
          if (!body.challenge || typeof body.signature !== "string") throw new Error("A session requires the signed challenge and its signature");
          return json(await overstoryd.openDeviceSession({ origin: publicOrigin, challenge: body.challenge, signature: body.signature }), 201);
        }
        if (url.pathname === "/.overstory/account-challenges" && request.method === "POST") {
          const body = await bodyFields(request) as { account?: unknown; profileTree?: unknown; configurationTree?: unknown; inviteCode?: unknown };
          if ((body.account !== undefined && typeof body.account !== "string") || (body.inviteCode !== undefined && typeof body.inviteCode !== "string") || typeof body.profileTree !== "string" || typeof body.configurationTree !== "string") {
            throw new Error("Account challenge requires profile TreeID, configuration TreeID, and an optional account URL");
          }
          return json(overstoryd.createAccountChallenge({
            origin: publicOrigin,
            account: body.account,
            profileTree: body.profileTree,
            configurationTree: body.configurationTree,
            inviteCode: body.inviteCode as string | undefined,
          }), 201);
        }
        const pairingClaim = /^\/\.overstory\/pairings\/([^/]+)\/claim$/.exec(url.pathname);
        if (pairingClaim && request.method === "PUT") {
          const pairingID = decodeURIComponent(pairingClaim[1]!);
          if (pairingClaims && !pairingClaims.allow(`${clientAddress(request)}:${pairingID}`))
            return protocolError("rate-limited", "Too many pairing claims", 429, true);
          const body = await bodyFields(request) as {
            secret?: unknown;
            device?: { id?: unknown; label?: unknown; key?: unknown };
          };
          if (
            typeof body.secret !== "string" || typeof body.device?.id !== "string"
            || typeof body.device.label !== "string" || typeof body.device.key !== "string"
          ) throw new Error("Pairing claim requires secret, generated device identity, a device key, and label");
          const claimed = await overstoryd.claimPairing({
            id: pairingID,
            secret: body.secret,
            deviceID: body.device.id,
            key: body.device.key,
            label: body.device.label,
          });
          return json({ device: claimed.device, confirmationCode: claimed.confirmationCode }, 201);
        }
        if (url.pathname === "/.overstory/trees") {
          if (request.method === "GET") {
            return json({ snapshot: overstoryd.list()
              // A tree configuration is listed only for its own profile's account,
              // and a tree mounted nowhere only for its administrators.
              .filter((tree) => tree.kind === "tree-configuration" ? tree.governs === account?.id
                : tree.canonicalPath !== null || (account !== null && overstoryd.canAdminister(account, tree)))
              .flatMap((tree) => {
                const level = overstoryd.accessLevel(account, tree, link);
                return level ? [descriptorWithUpdate(publicOrigin, overstoryd, tree, level)] : [];
              }),
            });
          }
          return methodNotAllowed();
        }
        if (url.pathname === "/.overstory/directory") {
          if (request.method !== "GET") return methodNotAllowed();
          const authenticated = requireAccount(authentication);
          return json({
            snapshot: buildDirectory(overstoryd, authenticated, publicOrigin),
          });
        }
        if (url.pathname === "/.overstory/accounts" && request.method === "PUT") {
          const { value, encoding } = await wireBody(request);
          const body = value as {
            account?: unknown;
            profileTree?: unknown;
            configurationTree?: unknown;
            challenge?: AccountChallenge;
            publicKey?: unknown;
            signature?: unknown;
            inviteCode?: unknown;
            device?: { id?: unknown; label?: unknown; key?: unknown };
            configuration?: unknown;
          };
          let accountURL: URL | undefined;
          try { if (typeof body.account === "string") accountURL = new URL(body.account); } catch {}
          const reservation = accountURL?.origin === publicOrigin ? overstoryd.accountReservation(body.account as string) : null;
          if (
            !reservation || typeof body.profileTree !== "string" || typeof body.configurationTree !== "string"
            || !body.challenge || typeof body.publicKey !== "string" || typeof body.signature !== "string"
            || (body.inviteCode !== undefined && typeof body.inviteCode !== "string")
            || typeof body.device?.id !== "string" || typeof body.device.label !== "string"
            || typeof body.device.key !== "string" || !body.configuration
          ) throw new Error("Account join requires an exact community reservation, generated identities, a device key, and initial configuration");
          if (reservation.profileTree && reservation.profileTree !== body.profileTree) {
            throw new Error("Account reservation names a different profile TreeID");
          }
          const result = await overstoryd.claimAccountWithConfiguration({
            accountLocator: body.account as string,
            handle: reservation.handle,
            origin: publicOrigin,
            profileTree: body.profileTree,
            configurationTree: body.configurationTree,
            challenge: body.challenge,
            publicKey: body.publicKey,
            signature: body.signature,
            inviteCode: body.inviteCode as string | undefined,
            deviceID: body.device.id,
            deviceLabel: body.device.label,
            key: body.device.key,
            ...claimConfiguration(body.configuration, encoding),
          });
          return wire({
            account: accountDescriptor(publicOrigin, overstoryd, result.account),
            configuration: descriptorWithUpdate(publicOrigin, overstoryd, result.configuration, "write"),
          }, answerEncoding(request), 201);
        }
        const access = /^\/\.overstory\/trees\/([^/]+)\/access$/.exec(url.pathname);
        if (access) {
          const treeID = hostedReference(access[1]!).id;
          if (request.method === "GET") {
            // Only administrators read a tree's rules (access control §4),
            // with each profile a rule names by TreeID shown by its locator.
            const policy = overstoryd.resourcePolicy(requireAccount(authentication), treeID);
            if (!policy) return protocolError("not-found", "Tree not found", 404);
            const locators: Record<string, string> = {};
            for (const profile of overstoryd.ruleProfiles(treeID)) {
              const tree = isTreeID(profile) ? overstoryd.get(profile) : null;
              const locator = tree ? overstoryLocator(publicOrigin, tree) : null;
              if (locator) locators[profile] = locator;
            }
            return json({ policy, locators });
          }
          return methodNotAllowed();
        }
        const wellKnown = url.pathname === "/.well-known/overstory"
          ? "/"
          : url.pathname.startsWith("/.well-known/overstory/")
            ? decodeURIComponent(url.pathname.slice("/.well-known/overstory".length))
            : null;
        // The raw path: a literal `%3Boverstory-config` filename is data, not the parameter.
        // Rename 002: `;arbor-config` is read as `;overstory-config`.
        if (wellKnown !== null && request.method === "GET" && currentConfigurationSpelling(url.pathname).endsWith(CONFIGURATION_SUFFIX)) {
          // `/~joe/todos;overstory-config`: the configuration of the tree whose root the path names.
          const configuration = configurationAt(overstoryd, currentConfigurationSpelling(wellKnown).slice(0, -CONFIGURATION_SUFFIX.length) || "/");
          const level = configuration ? overstoryd.accessLevel(account, configuration, link) : null;
          if (!configuration || !level) return notFound();
          return json({
            ref: { tree: configuration.id, path: "/", stableKey: null },
            enclosingTree: descriptorWithUpdate(publicOrigin, overstoryd, configuration, level),
            historical: false,
            observedThrough: overstoryd.observedThrough(configuration.id),
          } satisfies LocatorResolution);
        }
        if (wellKnown !== null && request.method === "GET") {
          const resolved = overstoryd.resolve(wellKnown);
          const level = resolved ? overstoryd.accessLevel(account, resolved.tree, link) : null;
          if (!resolved || !level) return notFound();
          const enclosingTree = descriptorWithUpdate(publicOrigin, overstoryd, resolved.tree, level);
          return json({
            ref: { tree: resolved.tree.id, path: resolved.path, stableKey: null },
            enclosingTree,
            historical: false,
            observedThrough: overstoryd.observedThrough(resolved.tree.id),
          } satisfies LocatorResolution);
        }
        const ref = /^\/\.overstory\/trees\/([^/]+)$/.exec(url.pathname);
        if (ref && request.method === "GET") {
          const { tree, level } = readableTree(ref[1]!);
          const current = descriptorWithUpdate(publicOrigin, overstoryd, tree, level);
          return json({ tree: current, observedThrough: overstoryd.observedThrough(tree.id) });
        }
        const conflicts = /^\/\.overstory\/trees\/([^/]+)\/conflicts$/.exec(url.pathname);
        if (conflicts && request.method === "GET") {
          const tree = readableTree(conflicts[1]!).tree.id;
          const state = url.searchParams.get("state"), after = url.searchParams.get("after"), selected = url.searchParams.get("conflict");
          if (!state || ["state", "after", "conflict"].some(k => url.searchParams.getAll(k).length > 1) ||
              (after !== null && (!after || selected !== null)) || selected === "") {
            return protocolError("invalid-request", "Invalid conflict inspection query", 400);
          }
          const page = await overstoryd.conflictPage(tree, state, after ?? undefined, selected ?? undefined);
          return page ? json(page) : notFound("Accepted state not found");
        }
        const acceptedSnapshot = /^\/\.overstory\/trees\/([^/]+)\/snapshots\/(sha256:[a-f0-9]{64})$/.exec(url.pathname);
        if (acceptedSnapshot && request.method === "GET") {
          const root = acceptedSnapshot[2] as ObjectHash;
          const { tree } = readableTree(acceptedSnapshot[1]!);
          const snapshot = await overstoryd.snapshotForRoot(tree.id, root);
          if (!snapshot) return notFound("Snapshot not found");
          // The bundle is a deterministic encoding of the root's graph, so the
          // root names it; hashing the body again would add nothing.
          return new Response(encodeSnapshotBundle(snapshot) as Uint8Array<ArrayBuffer>, { headers: immutableHeaders(request, root) });
        }
        const metadata = /^\/\.overstory\/trees\/([^/]+)\/entry-metadata$/.exec(url.pathname);
        if (metadata && request.method === "GET") {
          const { tree } = readableTree(metadata[1]!);
          const value = overstoryd.entryMetadata(tree.id);
          return value ? json(value) : notFound("Entry metadata not found");
        }
        const updates = /^\/\.overstory\/trees\/([^/]+)\/updates$/.exec(url.pathname);
        if (updates) {
          if (request.method !== "POST") return methodNotAllowed();
          const reference = hostedReference(updates[1]!);
          const treeID = reference.id;
          const timer = new PhaseTimer();
          const countersBefore = overstoryd.objectCounters();
          return await withPhaseTimer(timer, async () => {
            // Read the body's bytes, in either encoding, so its size on the
            // wire can be recorded; `trace-frames` counts the authored steps
            // and `trace-ops` the operations across them. All are
            // diagnostics, never content.
            const body = await wireBody(request);
            const answer = answerEncoding(request);
            timer.mark("body");
            timer.count("body-bytes", body.bytes);
            const update = decodeUpdateRequestJSON(body.value, body.encoding);
            timer.count("trace-frames", update.updates.reduce((sum, element) => sum + (element.trace?.length ?? 0), 0));
            timer.count("trace-ops", update.updates.reduce((sum, element) =>
              sum + (element.trace ?? []).reduce((ops, frame) => ops + frame.operations.length, 0), 0));
            const tree = overstoryd.get(treeID);
            // Declaring a tree is the null-base first update of its configuration.
            if (!tree && reference.governs && update.base === null && !execution) {
              const declared = await overstoryd.declareTree(reference.governs, update, authentication);
              return updateResponse(overstoryd, treeID, declared.result, answer, declared.status);
            }
            const writable = tree ? overstoryd.canWrite(account, tree, link) : false;
            // A null base activates a reserved tree, which has no descriptor yet;
            // The host checks the reservation and the administrator device.
            const direct = !execution && tree && !writable
              ? overstoryd.scopedCaller(account, treeID, authentication?.subject ?? "public", () => !authentication || overstoryd.authenticationIsActive(authentication), link) : undefined;
            const permitted = tree
              ? writable || overstoryd.execution.canSubmit(treeID) || (direct && overstoryd.execution.run(direct, () => overstoryd.execution.canSubmit(treeID)))
              : update.base === null && authentication !== null;
            if (!permitted) return notFound("Tree not found");
            timer.mark("parse-auth");
            let result: Awaited<ReturnType<typeof overstoryd.submitUpdate>>;
            try {
              result = await overstoryd.execution.run(execution ?? direct, () => overstoryd.submitUpdate(treeID, update, {
                account,
                ...(link ? { linkDigest: link } : {}),
                ...(authentication ? { authentication } : {}),
              }));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logUpdate({ event: "update", tree: treeID, status: "error", error: message, updates: update.updates.length, ...timer.summary() });
              throw error;
            }
            if (direct && !overstoryd.execution.covered(direct)) return protocolError("permission-denied", "Authorization changed before receipt disclosure", 403);
            const response = updateResponse(overstoryd, treeID, result.result, answer, result.status, { "server-timing": timer.serverTiming() });
            timer.mark("respond");
            const counters = overstoryd.objectCounters();
            for (const key of Object.keys(counters)) timer.count(key, Math.round((counters[key]! - countersBefore[key]!) * 10) / 10);
            // Diagnostics only: tree identity, outcome, and durations. No subjects,
            // request content, or object identities.
            const accepted = "results" in result.result ? result.result.results.map((element) => element.update.id) : [];
            logUpdate({ event: "update", tree: treeID, status: result.status, updates: update.updates.length, accepted, ...timer.summary() });
            return response;
          });
        }
        const watch = /^\/\.overstory\/trees\/([^/]+)\/watch$/.exec(url.pathname);
        if (watch && request.method === "GET") {
          const { tree, level: access } = readableTree(watch[1]!);
          // Watch streams stay open indefinitely; lift Bun's per-connection idle timeout for them.
          server.timeout(request, 0);
          const encoder = new TextEncoder();
          const credentialSubject = authentication?.subject;
          // `after` is the only resume cursor; `Last-Event-ID` is ignored.
          const after = url.searchParams.get("after");
          let closed = false;
          let delivered = 0;
          let frames: string[] = [];
          let wake: (() => void) | undefined;
          let stop = () => {};
          // Ends the stream: with `resync-required` when retained history cannot
          // serve the catch-up, or silently for a revoked caller, whose
          // reconnect is refused as any request is (401 or 404).
          let end = (_resyncReason?: string) => {};
          const readable = cachedAuthorization(overstoryd, () => {
            const active = !authentication || overstoryd.authenticationIsActive(authentication);
            // By ID: a recheck reads the tree as it is now.
            return active && overstoryd.execution.run(execution, () => overstoryd.canRead(account, tree.id, link));
          });
          // Execution token validity and session expiry change with time,
          // not database state, so they are never cached.
          const authorized = (epoch?: string) => (!execution || overstoryd.execution.valid(execution))
            && (!authentication || overstoryd.authenticationIsCurrent(authentication)) && readable(epoch);
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              end = (resyncReason?: string) => {
                if (closed) return;
                closed = true;
                if (resyncReason !== undefined) controller.enqueue(encoder.encode(encodeSSEFrame({event: "resync-required", data: {reason: resyncReason}})));
                stop(); controller.close();
              };
              const stopObserving = overstoryd.subscribeObservations(tree.id, () => { wake?.(); wake = undefined; });
              const stopTicks = onAuthorizationTick((epoch) => { if (!authorized(epoch)) end(); });
              // Comments flush headers through proxies at once, then keep an
              // idle stream alive through their timeouts; clients skip them.
              const keepalive = setInterval(() => {
                if (closed) return;
                try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* closing */ }
              }, WATCH_KEEPALIVE_MS);
              keepalive.unref?.();
              const abort = () => {
                if (closed) return;
                closed = true; stop();
                try { controller.close(); } catch {}
              };
              stop = () => {
                stopTicks(); clearInterval(keepalive); stopObserving();
                request.signal.removeEventListener("abort", abort);
                frames = []; wake?.(); wake = undefined;
              };
              request.signal.addEventListener("abort", abort, {once: true});
              if (request.signal.aborted) return abort();
              const position = overstoryd.observationPosition(tree.id, after);
              if (!position.retained) return end("The requested cursor is no longer retained");
              delivered = position.through;
              controller.enqueue(encoder.encode(execution ? ": authorized\n\n" : ": ready\n\n"));
            },
            async pull(controller) {
              try {
                while (!closed) {
                  if (!authorized()) return end();
                  if (frames.length) { controller.enqueue(encoder.encode(frames.shift()!)); return; }
                  const records = overstoryd.observationPage(tree.id, delivered);
                  if (!records.length) {
                    // Subscription precedes the position read. There is no await
                    // between checking the log and installing this wakeup.
                    await new Promise<void>(resolve => { wake = resolve; });
                    continue;
                  }
                  // One update is sent as itself; a backlog is sent as one net
                  // transition from the last delivered update to the head.
                  const single = records.length === 1 ? await overstoryd.acceptedTransition(records[0]!.id, credentialSubject) : null;
                  if (closed) return;
                  if (!authorized()) return end();
                  const next = single
                    ? {record: records[0]!, transition: single}
                    : await overstoryd.netAcceptedTransition(tree.id, delivered, credentialSubject);
                  if (closed) return;
                  if (!authorized()) return end();
                  if (!next) return end("The requested accepted basis is no longer retained");
                  delivered = next.record.ordinal;
                  frames = [encodeSSEFrame({id: next.record.id, event: "tree.update",
                    data: watchFrame(publicOrigin, overstoryd.get(tree.id) ?? tree, next.transition, access)})];
                }
              } catch (error) {
                // A failure here, such as a retained transition whose objects
                // cannot be read, is a fault rather than an unretained basis:
                // log it and end the stream.
                console.error(`overstoryd fault on watch of ${tree.id}`, error);
                closed = true; stop(); controller.error(error);
              }
            },
            cancel() { closed = true; stop(); },
          }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
        }

        const object = /^\/\.overstory\/trees\/([^/]+)\/objects\/(sha256:[a-f0-9]{64})$/.exec(url.pathname);
        if (object && request.method === "GET") {
          const treeID = hostedReference(object[1]!).id;
          const hash = object[2] as ObjectHash;
          if (!overstoryd.isReadableObject(treeID, account, link)) return protocolError("not-found", "Object not found in the named tree", 404, false, {}, { tree: treeID });
          const bytes = await overstoryd.retainedObject(hash);
          if (!bytes) return protocolError("not-found", "Object not found in the named tree", 404, false, {}, { tree: treeID });
          return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
            headers: { ...immutableHeaders(request, hash), "content-type": "application/octet-stream" },
          });
        }
        if (request.method === "GET" && !url.pathname.startsWith("/.")) {
          // A browser gets a page; anything else the protocol's error envelope.
          const pageNotFound = () => request.headers.get("accept")?.includes("text/html")
            ? html(renderNoticePage("Not found", "<h1>Not found</h1><p>Nothing is published at this address.</p>"), 404)
            : notFound();
          // Rename 002: a canonical URL ending in `;arbor-config` is read as `;overstory-config`.
          const requestLocator = resolveLogicalURL("/", `${currentConfigurationSpelling(url.pathname)}${url.search}`);
          if (!requestLocator || requestLocator.kind !== "local") return pageNotFound();
          if (requestLocator.configuration) {
            // A canonical URL with `;overstory-config`: administrators are sent to the
            // configuration's descriptor; anyone else sees an unreadable tree.
            const configuration = configurationAt(overstoryd, requestLocator.path);
            if (!configuration || !overstoryd.canRead(account, configuration, link)) {
              return request.headers.get("accept")?.includes("text/html") ? linkBootstrap() : notFound();
            }
            return new Response(null, { status: 303, headers: { location: `/.overstory/trees/${configuration.governs};overstory-config` } });
          }
          const pendingHandle = handleOfPath(requestLocator.path);
          if (pendingHandle && overstoryd.isReservedHandle(pendingHandle)) {
            const profileURL = `${publicOrigin}/~${pendingHandle}`;
            return html(renderNoticePage(`~${pendingHandle}`, `<h1>~${escapeHTML(pendingHandle)}</h1><p>This account is reserved by the ${escapeHTML(overstoryd.communityHandle())} community for one exact profile identity. It has not been claimed.</p><p>Its owner can open it in Story to claim it:</p><code>story open ${escapeHTML(profileURL)}</code>`), 200, { "overstory-profile-state": "reserved" });
          }
          const claimed = pendingHandle ? overstoryd.accountByHandle(pendingHandle) : null;
          if (pendingHandle && claimed && !overstoryd.boundary(requestLocator.path)) {
            return html(renderNoticePage(`~${pendingHandle}`, `<h1>~${escapeHTML(pendingHandle)}</h1><p>This account is linked to profile tree:</p><code>overstory://${escapeHTML(claimed.id)}/</code><p>The profile has not been hosted at this path yet.</p>`), 200, { "overstory-profile-state": "linked" });
          }
          const resolved = overstoryd.resolve(requestLocator.path);
          if (!resolved) return pageNotFound();
          if (!overstoryd.canRead(account, resolved.tree, link)) {
            return request.headers.get("accept")?.includes("text/html") ? linkBootstrap() : notFound();
          }
          const tree = resolved.tree;
          const load = (hash: ObjectHash) => overstoryd.object(hash);
          const projection = new ProtocolProjection({ root: tree.ref, load });
          const resolution = await projection.resolve(resolved.path, requestLocator.stableKey);
          if (resolution.kind === "missing") return pageNotFound();
          const logicalPath = resolution.path;
          const canonicalPath = tree.canonicalPath!;
          const publicPath = publicTreePath(canonicalPath, logicalPath);
          if (requestLocator.stableKey && resolved.path !== logicalPath) {
            const location = buildNetworkLocator(publicPath, {
              stableKey: requestLocator.stableKey,
              applicationQuery: requestLocator.applicationQuery,
              contentFragment: requestLocator.contentFragment,
            });
            if (!location) return pageNotFound();
            return new Response(null, { status: 308, headers: { location } });
          }
          const collectionFileRow = resolution.kind === "collection-file-row" ? resolution : null;
          const logical = resolution.kind === "node" ? resolution.node : null;
          if (collectionFileRow) {
            const title = protocolCollectionFileRowTitle(collectionFileRow.row);
            if (request.headers.get("accept")?.includes("text/markdown")) {
              return new Response(protocolCollectionFileRowMarkdown(collectionFileRow.row), {
                headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" },
              });
            }
            return html(renderPublicDataPage(title, collectionFileRow.row.properties));
          }
          if (!logical) return pageNotFound();

          const objectName = logical.objectName || canonicalPath.split("/").at(-1) || "Overstory";
          if (logical.kind === "file") {
            if (objectName.endsWith(".md")) {
              if (request.headers.get("accept")?.includes("text/markdown")) {
                return new Response(logical.bytes.buffer.slice(
                  logical.bytes.byteOffset,
                  logical.bytes.byteOffset + logical.bytes.byteLength,
                ) as ArrayBuffer, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" } });
              }
              return html(renderPublicMarkdownPage({
                source: new TextDecoder().decode(logical.bytes),
                fallbackTitle: objectName.slice(0, -3),
                origin: publicOrigin,
                treeCanonicalPath: canonicalPath,
                sourceDirectory: markdownSourceDirectory(logicalPath, "sibling"),
              }));
            }
            // A tree's raw file, typed by its name. The sandbox keeps an HTML
            // or SVG file from running script with this origin's authority.
            return new Response(logical.bytes as Uint8Array<ArrayBuffer>, { headers: {
              "content-type": Bun.file(objectName).type,
              "cache-control": "no-cache",
              "x-content-type-options": "nosniff",
              "content-security-policy": "sandbox",
            } });
          }
          const prefix = publicPath.replace(/\/$/, "");
          const source = logical.body ? new TextDecoder().decode(logical.body) : "";
          if (request.headers.get("accept")?.includes("text/markdown")) {
            return new Response(source, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" } });
          }
          const collectionFileDescriptor = logical.directory.childrenSource;
          const collectionFile = await projection.collectionFile(logical.directory);
          const physicalChildren = (await Promise.all(logical.directory.entries
            .filter((entry) => entry.name !== "_index.md"
              && entry.name !== collectionFileDescriptor?.source
              && entry.name !== collectionFileDescriptor?.schemaSource)
            .map(async (entry): Promise<PublicPageChild | null> => {
              if (entry.tree) {
                const nested = overstoryd.get(entry.tree);
                if (!nested || !overstoryd.canRead(account, nested, link)) return null;
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
            name: protocolCollectionFileRowTitle(row),
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
            fallbackTitle: logicalPath.split("/").filter(Boolean).at(-1) ?? canonicalPath.split("/").filter(Boolean).at(-1) ?? overstoryd.communityHandle(),
            origin: publicOrigin,
            treeCanonicalPath: canonicalPath,
            sourceDirectory: markdownSourceDirectory(logicalPath, logical.bodyOrigin ?? null),
            children,
          }));
        }
        return protocolError("not-found", "Route not found", 404);
      } catch (error) {
        if (error instanceof RefConflictError) {
          return protocolError("conflict", "The tree ref changed before the mutation committed", 409, false, {
            kind: "server-update",
            current: error.current,
          });
        }
        if (error instanceof UpdateProtocolError) {
          if (error.code === "unsupported-operation") return protocolError(error.code, error.message, 422);
          return protocolError("conflict", error.message, 409, false, { kind: "server-update" });
        }
        if (error instanceof AlreadyClaimedError) {
          return protocolError("already-claimed", error.message, 409, false, error.handle ? { handle: error.handle } : {});
        }
        if (error instanceof ReservedBoundaryConflictError) {
          return protocolError("conflict", "The update would change an independently versioned tree boundary", 409, false, {
            kind: "server-update",
          }, { path: error.path, tree: error.tree });
        }
        if (error instanceof MergeWorkerError) {
          return error.retryable
            ? protocolError("merge-failed", error.message, 503, true)
            : protocolError("merge-failed", error.message, 422);
        }
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof AuthenticationRequiredError) return protocolError("unauthenticated", message, 401);
        if (error instanceof PermissionDeniedError) return protocolError("permission-denied", message, 403);
        if (error instanceof NotFoundError) return protocolError("not-found", message, 404);
        if (error instanceof ExpiredChallengeError) return protocolError("invalid-request", message, 400, false, { challenge: "expired" });
        if (error instanceof ServerBusyError) return protocolError("internal-error", message, 503, true);
        if (error instanceof PlacementAccountError) return protocolError("permission-denied", message, 403, false, { homeHost: error.homeHost });
        if (error instanceof HomeHostUnavailableError) return protocolError("internal-error", message, 503, true, { homeHost: error.homeHost });
        if (isServerFault(error)) {
          console.error(`overstoryd fault on ${request.method} ${url.pathname}`, error);
          return protocolError("internal-error", "The server failed to complete the request", 500);
        }
        logRequestError({ method: request.method, path: url.pathname, status: 400, message });
        return protocolError("invalid-request", message, 400);
      }
      });
      if (execution && !overstoryd.execution.covered(execution)) {
        await response.body?.cancel().catch(() => {});
        return protocolError("permission-denied", "Execution authorization is unavailable", 403);
      }
      return response;
    },
  });
  if (dynamicLoopbackOrigin) {
    publicOrigin = `${publicOrigin.slice(0, publicOrigin.lastIndexOf(":"))}:${server.port}`;
  }
  if (dynamicLoopbackOrigin) overstoryd.setCommunityHost(new URL(publicOrigin).host, true);
  return { overstoryd, server, url: publicOrigin };
}
