import { AlreadyClaimedError, AuthenticationRequiredError, ExpiredChallengeError, HomeHostUnavailableError, isServerFault, NotFoundError, PermissionDeniedError, PlacementAccountError, RefConflictError, ReservedBoundaryConflictError, ServerBusyError, ServerFaultError, UpdateProtocolError } from "./errors.ts";
import { MergeWorkerError } from "./merge-tool.ts";
import { EntryTimesBehind } from "./updates/entry-times.ts";
import { AttemptLimiter } from "./attempt-limiter.ts";
import { resolve } from "node:path";
import { HOST_PROTOCOL, decodePresenceAgentLabel, decodePresenceDevice, decodePresenceUpdate, decodePresenceMessagePost, decodePresenceRunnerLabel, PRESENCE_LIMITS, PresenceDecodeError, treeConfigurationID, parseTreeReference, decodeCandidateUpdateJSON, encodeSnapshotBundle, encodeUpdateConflictJSON, encodeUpdateResponseJSON, type UpdateHead, buildNetworkLocator, canonicalOverstoryLocator, encodeSSEFrame, markdownSourceDirectory, resolveLogicalURL, sha256, isTreeID, DOMAIN_PROFILE_PATH } from "@ovst/protocol";
import { canonicalNodePath, decodePathReadPath, encodePathReadPath, encodePathReadBundle, WIRE_CONTENT_TYPE, acceptsCBOR, decodeWireBody, encodeWireBody, wireEncodingOf, type TreeSnapshot, type WireEncoding } from "@ovst/protocol";
import type { AccountChallenge, LocatorResolution, MutationCallRuntime, ViewsRuntime, ReadWriteAccess, RemoteTreeDescriptor } from "@ovst/protocol";
import { treeMutationResponse, treeViewsResponse } from "./exec-routes.ts";
import { HostCollections, type HostCollectionsOptions } from "./collections.ts";
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
import { PresenceBusy, PresenceHub, PresenceNotFound, PresenceRefused } from "./presence.ts";
import { PhaseTimer, withPhaseTimer } from "./updates/timing.ts";
import {
  decodeDerivableUpdateRequestJSON,
  isStatedUpdate,
  encodeAcceptedWatchChange,
  encodeDecisionPage,
  type AcceptedTransition,
  type AcceptedUpdate,
  type ObjectHash,
  type RemoteAccountDescriptor,
  type RemotePlacementAccountDescriptor,
} from "@ovst/protocol";
import { escapeHTML, publicTreePath, renderNoticePage, renderPublicDataPage, renderPublicMarkdownPage, renderReservedPage, RESERVED_PAGE_SCRIPT, PAGE_ASSETS, type PublicPageChild, type StoryDownloads } from "./public-page.ts";
import { ProtocolProjection, protocolCollectionRowMarkdown, protocolCollectionRowTitle, type ProtocolCollectionRow } from "./projection.ts";
import { buildDirectory } from "./directory.ts";
import { DOMAIN_CHECK_PATH, LEGACY_DOMAIN_CHECK_PATH, domainOrigin, type CustomDomains } from "./custom-domains.ts";
import { clientAddress, hardenResponse, htmlContentSecurityPolicy, storedFileHeaders, type PageScript } from "./response-policy.ts";


/** Comment frames keep watch streams alive across proxy idle timeouts. */
const WATCH_KEEPALIVE_MS = 20_000;

/** A collection table's rows as page children, each addressed by its stable key. */
function collectionRowChildren(prefix: string, rows: readonly ProtocolCollectionRow[], applicationQuery: string | null | undefined): PublicPageChild[] {
  return rows.map((row) => ({
    name: protocolCollectionRowTitle(row),
    href: buildNetworkLocator(`${prefix}/${encodeURIComponent(row.path)}`, { stableKey: row.stableKey, applicationQuery }),
    kind: "document",
  }));
}

/**
 * The Markdown a folder with no index page, or a collection table, answers
 * (tree operations §1.3): its name as a title, then a link to each child.
 */
function childListMarkdown(title: string, children: readonly PublicPageChild[]): string {
  const text = (value: string) => value.replace(/[\\`*_[\]<>#]/g, "\\$&");
  const lines = children.map((child) => `- [${text(child.name)}](<${child.href}>)`);
  return `# ${text(title)}\n${lines.length ? `\n${lines.join("\n")}\n` : ""}`;
}

function markdown(value: string): Response {
  return new Response(value, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" } });
}

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

/**
 * A tree's canonical placement at this origin, or null for a tree mounted
 * nowhere; with `domains`, its canonical URL at a person's domain when one is
 * served over its path (locators §5.1).
 */
function canonicalOf(origin: string, tree: HostTree, domains?: CustomDomains): RemoteTreeDescriptor["canonical"] {
  if (tree.canonicalPath === null) return null;
  const url = domains?.url(tree.canonicalPath);
  return {
    path: tree.canonicalPath as `/${string}`,
    endpoint: `${origin}/.overstory/trees/${encodeURIComponent(tree.id)}`,
    parentTree: tree.parentTree,
    ...(url ? { url } : {}),
  } as RemoteTreeDescriptor["canonical"];
}

/** The `overstory://` locator of a canonical tree, or null for a noncanonical one. */
function overstoryLocator(origin: string, tree: HostTree): string | null {
  const canonical = canonicalOf(origin, tree);
  return canonical ? canonicalOverstoryLocator(canonical) : null;
}

/** A tree's descriptor at `head`, one of its accepted updates. */
function descriptor(origin: string, tree: HostTree, access: ReadWriteAccess, head: Pick<AcceptedUpdate, "id" | "root" | "conflicted">, pages = false, domains?: CustomDomains): RemoteTreeDescriptor {
  return {
    id: tree.id,
    kind: tree.kind,
    access,
    canonical: canonicalOf(origin, tree, domains),
    root: head.root as RemoteTreeDescriptor["root"],
    update: head.id,
    conflicted: head.conflicted,
    ...(pages ? { pages: true as const } : {}),
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
  return descriptor(origin, tree, access, update, overstoryd.acceptsPages(tree.id), overstoryd.customDomains);
}

/**
 * A `tree.update` frame's data (tree operations §1.1.3): the one transition
 * and what the client cannot derive for its new descriptor. The cursor is the
 * frame's SSE `id` and the tree is the URL's.
 */
function watchFrame(origin: string, tree: HostTree, transition: AcceptedTransition, access: ReadWriteAccess, domains?: CustomDomains) {
  return encodeAcceptedWatchChange({ transition, access, canonical: descriptor(origin, tree, access, transition.update, false, domains).canonical });
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
  const head: UpdateHead = { update: update.id, root: tree.ref as ObjectHash, conflicted: update.conflicted };
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
  const decoded = decodeURIComponent(segment);
  try {
    const reference = parseTreeReference(decoded);
    return reference.configuration ? { id: treeConfigurationID(reference.tree), governs: reference.tree } : { id: reference.tree };
  } catch {
    return { id: decoded };
  }
}

const CONFIGURATION_SUFFIX = ";overstory-config";

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

/**
 * The script of the access-link page: it reads the link's secret from the
 * fragment, which never reaches a server in a URL, and fetches the same
 * address with it in a header. Constant text, permitted by its hash.
 */
const ACCESS_LINK_SCRIPT: PageScript = { connects: true, source: `
const marker = "#overstory-access=";
const secret = location.hash.startsWith(marker) ? decodeURIComponent(location.hash.slice(marker.length)) : "";
if (!secret) document.body.textContent = "This Overstory tree requires access.";
else fetch(location.pathname + location.search, { headers: { "Overstory-Access-Link": secret } })
  .then(async response => {
    if (!response.ok) throw new Error("This access link is invalid or revoked.");
    document.open(); document.write(await response.text()); document.close();
  })
  .catch(error => { document.body.textContent = error.message; });
` };

function linkBootstrap(): Response {
  return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Overstory access</title><body><p>Opening shared Overstory tree…</p><script>${ACCESS_LINK_SCRIPT.source}</script></body>`, 200, {}, ACCESS_LINK_SCRIPT);
}

/** An HTML page under the page policy; `script` is the one inline script it carries, if any. */
function html(value: string, status = 200, headers: HeadersInit = {}, script?: PageScript): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "text/html; charset=utf-8");
  responseHeaders.set("cache-control", "no-cache");
  responseHeaders.set("content-security-policy", htmlContentSecurityPolicy(script));
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
    firstWriter?: { handle: string; profileTree?: string; inviteCode?: string; name?: string };
  };
  accounts?: HostBootstrapAccount[];
  port?: number;
  hostname?: string;
  viewsRuntime?: ViewsRuntime;
  mutationRuntime?: MutationCallRuntime;
  /** Serve named views and mutations through the execution sidecar, from the host's collection materializations, unless a runtime above is given. */
  collections?: HostCollectionsOptions;
  /** Session and placement device-key lifetimes; tests shorten them. */
  lifetimes?: Omit<HostDaemonOptions, "servedOverHTTP" | "pages" | "provenanceFill">;
  /**
   * Accept page entries and conversions to them (spec 02 §3), in every tree
   * or in the trees listed: health advertises `pages-v1`, and those trees'
   * descriptors say `pages`, which is when a writer's Story Sync converts.
   */
  pages?: boolean | readonly string[];
  /** Compute missing provenance indexes in the background (`HostDaemonOptions`). */
  provenanceFill?: boolean;
  /**
   * Bound unauthenticated session challenges and pairing claims per caller.
   * Off unless asked for: with one person's devices behind each host, a
   * client retrying through an outage tripped it and hid the real refusal.
   */
  rateLimits?: boolean;
  /**
   * Reverse proxies in front of the listener that append to
   * `X-Forwarded-For`. Zero, the default, ignores the header and counts a
   * caller by the connection's peer address.
   */
  trustedProxyHops?: number;
  /** Download pages the reserved-address page offers a person opening an invitation; each link is omitted when unset. */
  storyDownloads?: StoryDownloads;
}) {
  const trustedProxyHops = options.trustedProxyHops ?? 0;
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0) throw new Error("trustedProxyHops must be a whole number of proxies, zero or more");
  const bootstrapAccounts = options.accounts ?? [];
  let publicOrigin = options.publicOrigin.replace(/\/$/, "");
  const dynamicLoopbackOrigin = /^https?:\/\/(?:127\.0\.0\.1|localhost):0$/.test(publicOrigin);
  const overstoryd = await HostDaemon.open(resolve(options.dataRoot), {
    handle: options.community?.handle ?? "community",
    name: options.community?.name ?? "Overstory Community",
    accounts: bootstrapAccounts,
    ...(options.community?.firstWriter ? { firstWriter: options.community.firstWriter } : {}),
  }, options.mergeTool, { ...options.lifetimes, servedOverHTTP: new URL(publicOrigin).protocol === "http:", pages: options.pages ?? false, provenanceFill: options.provenanceFill ?? false });
  if (!dynamicLoopbackOrigin) overstoryd.setCommunityHost(new URL(publicOrigin).host);
  // Named views and mutations over the host's collection materializations.
  const collections = options.collections ? overstoryd.disposeWith(new HostCollections(overstoryd, resolve(options.dataRoot), options.collections)) : null;
  const viewsRuntime = options.viewsRuntime ?? collections?.viewsRuntime();
  const mutationRuntime = options.mutationRuntime ?? collections?.mutationRuntime();
  const onAuthorizationTick = authorizationTicker(overstoryd);
  const presence = new PresenceHub();
  const pairingClaims = options.rateLimits ? new AttemptLimiter(10, 10 * 60 * 1000) : null;
  const challenges = options.rateLimits ? new AttemptLimiter(30, 10 * 60 * 1000) : null;
  const server = Bun.serve({
    port: options.port ?? Number(process.env.PORT ?? 4318),
    hostname: options.hostname ?? "0.0.0.0",
    idleTimeout: 30,
    // Every response leaves through `hardenResponse`, whichever route built it.
    async fetch(request, server): Promise<Response> {
      return hardenResponse(await answer(request, server));
    },
  });
  type HostServer = ReturnType<typeof Bun.serve>;
  /** The rate-limit key for a request's caller (see `clientAddress`). */
  const callerAddress = (request: Request, server: HostServer): string =>
    clientAddress(request.headers.get("x-forwarded-for"), server.requestIP(request)?.address, trustedProxyHops);
  async function answer(request: Request, server: HostServer): Promise<Response> {
      const token = bearer(request);
      const execution = token?.startsWith("execution_") ? overstoryd.execution.resolve(token) : undefined;
      if (token?.startsWith("execution_") && !execution) return protocolError("unauthenticated", "Execution authorization is unavailable", 401);
      const response = await overstoryd.execution.run(execution, async () => {
      const url = new URL(request.url);
      // At a person's domain (locators §5.1), their prefix goes in front of
      // the path; `/.overstory/*` names trees by TreeID at every name.
      const servedDomain = overstoryd.customDomains.serving(request.headers.get("host"));
      if (servedDomain && (request.method === "GET" || request.method === "HEAD")) {
        if (url.pathname === DOMAIN_PROFILE_PATH) {
          return json({ profile: `${publicOrigin}${servedDomain.prefix}` });
        }
        if (url.pathname === "/.well-known/overstory" || url.pathname.startsWith("/.well-known/overstory/")) {
          const below = url.pathname.slice("/.well-known/overstory".length);
          url.pathname = `/.well-known/overstory${servedDomain.prefix}${below === "/" ? "" : below}`;
        } else if (!url.pathname.startsWith("/.")) {
          // Another account's path is at the host's own name.
          if (url.pathname.startsWith("/~")) return new Response(null, { status: 308, headers: { location: `${publicOrigin}${url.pathname}${url.search}` } });
          url.pathname = `${servedDomain.prefix}${url.pathname === "/" ? "" : url.pathname}`;
        }
      }
      // A browser at the host's own name is sent to the domain serving the path.
      if (!servedDomain && request.method === "GET" && !url.pathname.startsWith("/.") && request.headers.get("accept")?.includes("text/html")) {
        let decoded: string | null = null;
        try { decoded = decodeURIComponent(url.pathname).replace(/\/$/, ""); } catch {}
        const domain = decoded ? overstoryd.customDomains.domainFor(decoded) : null;
        if (domain) {
          const below = url.pathname.slice(encodeURI(domain.prefix).length);
          return new Response(null, { status: 301, headers: { location: `${domainOrigin(domain.domain)}${below || "/"}${url.search}` } });
        }
      }
      /** A path at this host as the request's own name spells it: without a served domain's prefix. */
      const shown = (path: string): string => {
        if (!servedDomain) return path;
        if (path === servedDomain.prefix) return "/";
        return path.startsWith(`${servedDomain.prefix}/`) ? path.slice(servedDomain.prefix.length) : path;
      };
      const shownOrigin = servedDomain ? domainOrigin(servedDomain.domain) : publicOrigin;
      // The one authentication of this request; routes below reuse it.
      const authentication = overstoryd.authenticateToken(token);
      if (authentication) overstoryd.noteDeviceClient(authentication, request.headers.get("overstory-client") ?? request.headers.get("user-agent"));
      // A visitor (accounts §5.6) has no account: every route reads it as
      // anonymous except the tree reads, which ask what it may read.
      const visitor = authentication || execution ? null : overstoryd.authenticateVisitor(token);
      // A presented token that authenticates nothing (an expired session, a
      // deleted device) is refused, never read as anonymous: a 404 for a
      // private tree would hide the reason and clients refresh only on 401.
      if (token && !execution && !authentication && !visitor) return protocolError("unauthenticated", "The session is not valid", 401);
      const account = authentication?.account ?? (execution?.caller ? overstoryd.account(execution.caller) : null);
      const link = linkDigest(request);
      /** The caller's whole-tree access: a visitor's is at most `read`. */
      const levelOf = (tree: HostTree): ReadWriteAccess | null => visitor
        ? overstoryd.visitorAccessLevel(visitor, tree, link)
        : overstoryd.accessLevel(account, tree, link);
      /** A visitor's stream holds while its session does and it may still read the tree. */
      const visitorReads = (treeID: string): boolean =>
        !!visitor && overstoryd.visitorIsActive(visitor) && overstoryd.visitorAccessLevel(visitor, treeID, link) !== null;
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
        const level = tree ? levelOf(tree) : null;
        if (!tree || !level) throw new NotFoundError("Tree not found");
        return { tree, level };
      };
      const notFound = (message = "Not found") => protocolError("not-found", message, 404);
      const methodNotAllowed = () => protocolError("invalid-request", "Method not allowed", 405);
      try {
        const viewsRoute = /^\/\.overstory\/trees\/([^/]+)\/views$/.exec(url.pathname);
        if (request.method === "QUERY" && viewsRoute) {
          if (!viewsRuntime) return protocolError("unsupported-operation", "No view runtime is active", 422);
          const treeID = readableTree(viewsRoute[1]!).tree.id;
          server.timeout(request, 0);
          return treeViewsResponse(
            viewsRuntime,
            request,
            treeID,
            account ? { profile: account.id } : null,
            { caller: { account, ...(link ? { linkDigest: link } : {}), ...(authentication ? { authentication } : {}) } },
          );
        }
        const mutateRoute = /^\/\.overstory\/trees\/([^/]+)\/mutate$/.exec(url.pathname);
        if (request.method === "POST" && mutateRoute) {
          if (!mutationRuntime) return protocolError("unsupported-operation", "No mutation runtime is active", 422);
          const { tree, level } = readableTree(mutateRoute[1]!);
          if (!account || level !== "write") return notFound("Tree not found");
          const treeID = tree.id;
          return treeMutationResponse(
            mutationRuntime,
            request,
            treeID,
            { profile: account.id },
            { caller: { account, ...(link ? { linkDigest: link } : {}), ...(authentication ? { authentication } : {}) } },
          );
        }
        const pageAsset = Object.values(PAGE_ASSETS).find((path) => path === url.pathname);
        if (pageAsset && (request.method === "GET" || request.method === "HEAD")) {
          return new Response(Bun.file(new URL(`../assets/${pageAsset.slice(pageAsset.lastIndexOf("/") + 1)}`, import.meta.url)), {
            headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
          });
        }
        if (request.method === "GET" && (url.pathname === DOMAIN_CHECK_PATH || url.pathname === LEGACY_DOMAIN_CHECK_PATH)) {
          return json({ host: overstoryd.customDomains.token });
        }
        if (request.method === "GET" && url.pathname === "/.overstory/health") {
          try {
            overstoryd.verifyDatabase();
            const pages = overstoryd.pages === true || (Array.isArray(overstoryd.pages) && overstoryd.pages.length > 0);
            // `founding`: the community was founded by code and nobody has
            // claimed it yet, so an invitation claim here makes its claimer
            // the administrator (accounts §1.2). Story words its join screen by it.
            return json({ status: "ok", protocol: HOST_PROTOCOL, ...(pages ? { features: ["pages-v1"] } : {}), ...(overstoryd.founding() ? { founding: true } : {}) });
          } catch (error) {
            console.error("overstoryd database check failed", error);
            return protocolError("internal-error", "Host database check failed", 503, true);
          }
        }
        if (request.method === "GET" && url.pathname === "/.overstory/integrity") {
          server.timeout(request, 0);
          try {
            const report = await overstoryd.verifyIntegrity();
            return json({ status: "ok", ...report });
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
        // Host-to-host routes live under `/.overstory/peer/`; the old path is
        // answered until plans/soon/protocol-001 removes it.
        const publishedKeys = /^\/\.overstory\/(?:peer\/)?profiles\/(tr_[a-z2-7]+)\/device-keys$/.exec(url.pathname);
        if (publishedKeys && request.method === "GET") {
          // Public: a placement host reads it without authenticating (accounts §5.4).
          return json(await overstoryd.publishedDeviceKeys(publishedKeys[1]!), 200, { "cache-control": "no-cache" });
        }
        if (url.pathname === "/.overstory/device-sessions/challenges" && request.method === "POST") {
          const body = await bodyFields(request) as { profileTree?: unknown; device?: unknown; homeHost?: unknown };
          // The profile may be left out at a device's home host, which knows whose device it is (accounts §5.1).
          if ((body.profileTree !== undefined && typeof body.profileTree !== "string") || typeof body.device !== "string") throw new Error("A session challenge names a DeviceID, and a profile TreeID unless this is the device's home host");
          if (challenges && !challenges.allow(`${callerAddress(request, server)}:session:${body.profileTree ?? body.device}`)) return protocolError("rate-limited", "Too many challenges", 429, true);
          if (body.homeHost !== undefined && (typeof body.homeHost !== "string" || typeof body.profileTree !== "string")) throw new Error("A visitor's session challenge names its profile TreeID and its home host's origin");
          return json(await overstoryd.createDeviceSessionChallenge({ origin: publicOrigin, profileTree: body.profileTree, device: body.device, ...(typeof body.homeHost === "string" ? { homeHost: body.homeHost } : {}) }), 201);
        }
        if (url.pathname === "/.overstory/device-sessions" && request.method === "POST") {
          const body = await bodyFields(request) as { challenge?: unknown; signature?: unknown };
          if (!body.challenge || typeof body.signature !== "string") throw new Error("A session requires the signed challenge and its signature");
          return json(await overstoryd.openDeviceSession({ origin: publicOrigin, challenge: body.challenge, signature: body.signature }), 201);
        }
        if (url.pathname === "/.overstory/account-challenges" && request.method === "POST") {
          const body = await bodyFields(request) as { account?: unknown; profileTree?: unknown; configurationTree?: unknown; inviteCode?: unknown; profile?: unknown };
          if ((body.account !== undefined && typeof body.account !== "string") || (body.inviteCode !== undefined && typeof body.inviteCode !== "string")
            || (body.profile !== undefined && typeof body.profile !== "string") || typeof body.profileTree !== "string" || typeof body.configurationTree !== "string") {
            throw new Error("Account challenge requires profile TreeID, configuration TreeID, and an optional account URL");
          }
          return json(overstoryd.createAccountChallenge({
            origin: publicOrigin,
            account: body.account,
            profileTree: body.profileTree,
            configurationTree: body.configurationTree,
            inviteCode: body.inviteCode as string | undefined,
            profile: body.profile as string | undefined,
          }), 201);
        }
        /** An invitation accepted by a profile homed at another host (accounts §1.4). */
        const acceptAsPlacement = async (fields: unknown) => {
          const body = fields as {
            account?: unknown;
            profile?: unknown;
            profileTree?: unknown;
            configurationTree?: unknown;
            inviteCode?: unknown;
            challenge?: AccountChallenge;
            publicKey?: unknown;
            signature?: unknown;
          };
          let accountURL: URL | undefined;
          try { if (typeof body.account === "string") accountURL = new URL(body.account); } catch {}
          if (
            accountURL?.origin !== publicOrigin || typeof body.profile !== "string" || typeof body.profileTree !== "string"
            || typeof body.configurationTree !== "string" || typeof body.inviteCode !== "string" || !body.challenge
            || typeof body.publicKey !== "string" || typeof body.signature !== "string"
          ) throw new Error("Accepting an invitation as a placement requires the account, the profile's locator, its code, and the signed challenge");
          const placed = await overstoryd.acceptInvitationAsPlacement({
            accountLocator: body.account as string,
            origin: publicOrigin,
            profile: body.profile,
            profileTree: body.profileTree,
            configurationTree: body.configurationTree,
            challenge: body.challenge,
            publicKey: body.publicKey,
            signature: body.signature,
            inviteCode: body.inviteCode,
          });
          return placed;
        };
        // The old route, kept until clients send `PUT /accounts` with `profile`
        // (plans/soon/protocol-001-spec-review-route-changes.md).
        if (url.pathname === "/.overstory/placements" && request.method === "PUT") {
          return json(accountDescriptor(publicOrigin, overstoryd, await acceptAsPlacement(await bodyFields(request))), 201);
        }
        const pairingClaim = /^\/\.overstory\/pairings\/([^/]+)\/claim$/.exec(url.pathname);
        if (pairingClaim && request.method === "PUT") {
          const pairingID = decodeURIComponent(pairingClaim[1]!);
          if (pairingClaims && !pairingClaims.allow(`${callerAddress(request, server)}:${pairingID}`))
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
                const level = levelOf(tree);
                return level ? [descriptorWithUpdate(publicOrigin, overstoryd, tree, level)] : [];
              }),
            });
          }
          return methodNotAllowed();
        }
        // `/.overstory/directory` is the old path, answered until plans/soon/protocol-001 removes it.
        if (url.pathname === "/.overstory/account/directory" || url.pathname === "/.overstory/directory") {
          if (request.method !== "GET") return methodNotAllowed();
          const authenticated = requireAccount(authentication);
          return json({
            snapshot: buildDirectory(overstoryd, authenticated, publicOrigin),
          });
        }
        if (url.pathname === "/.overstory/accounts" && request.method === "PUT") {
          const { value, encoding } = await wireBody(request);
          // Joining with a profile homed at another host: a membership here (accounts §1.4).
          if ((value as { profile?: unknown }).profile !== undefined) {
            const placed = await acceptAsPlacement(value);
            return wire({ account: accountDescriptor(publicOrigin, overstoryd, placed) }, answerEncoding(request), 201);
          }
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
        if (wellKnown !== null && request.method === "GET" && url.pathname.endsWith(CONFIGURATION_SUFFIX)) {
          // `/~joe/todos;overstory-config`: the configuration of the tree whose root the path names.
          const configuration = configurationAt(overstoryd, wellKnown.slice(0, -CONFIGURATION_SUFFIX.length) || "/");
          const level = configuration ? overstoryd.accessLevel(account, configuration, link) : null;
          if (!configuration || !level) return notFound();
          return json({
            ref: { tree: configuration.id, path: "/", stableKey: null },
            enclosingTree: descriptorWithUpdate(publicOrigin, overstoryd, configuration, level),
          } satisfies LocatorResolution);
        }
        if (wellKnown !== null && request.method === "GET") {
          const resolved = overstoryd.resolve(wellKnown);
          const level = resolved ? levelOf(resolved.tree) : null;
          if (!resolved || !level) return notFound();
          const enclosingTree = descriptorWithUpdate(publicOrigin, overstoryd, resolved.tree, level);
          return json({
            ref: { tree: resolved.tree.id, path: resolved.path, stableKey: null },
            enclosingTree,
          } satisfies LocatorResolution);
        }
        const ref = /^\/\.overstory\/trees\/([^/]+)$/.exec(url.pathname);
        if (ref && request.method === "GET") {
          const { tree, level } = readableTree(ref[1]!);
          const current = descriptorWithUpdate(publicOrigin, overstoryd, tree, level);
          return json({ tree: current });
        }
        const conflicts = /^\/\.overstory\/trees\/([^/]+)\/conflicts$/.exec(url.pathname);
        if (conflicts && request.method === "GET") {
          const tree = readableTree(conflicts[1]!).tree.id;
          const state = url.searchParams.get("update"), after = url.searchParams.get("after"), selected = url.searchParams.get("conflict");
          if (!state || ["update", "after", "conflict"].some(k => url.searchParams.getAll(k).length > 1) ||
              (after !== null && (!after || selected !== null)) || selected === "") {
            return protocolError("invalid-request", "Invalid conflict inspection query", 400);
          }
          const page = await overstoryd.conflictPage(tree, state, after ?? undefined, selected ?? undefined);
          return page ? json(encodeDecisionPage(page)) : notFound("Accepted state not found");
        }
        const acceptedSnapshot = /^\/\.overstory\/trees\/([^/]+)\/snapshots\/(sha256:[a-f0-9]{64})$/.exec(url.pathname);
        if (acceptedSnapshot && request.method === "GET") {
          const root = acceptedSnapshot[2] as ObjectHash;
          const { tree } = readableTree(acceptedSnapshot[1]!);
          const snapshot = await overstoryd.snapshotForRoot(tree.id, root);
          if (!snapshot) return notFound("Snapshot not found");
          // The bundle is a deterministic encoding of the root's graph, so the
          // root names it; hashing the body again would add nothing. Entry
          // times are a function of the root too (§1.1.2a).
          const times = url.searchParams.has("times") ? await overstoryd.entryTimesFor(tree.id, root, snapshot.objects) : undefined;
          return new Response(encodeSnapshotBundle(snapshot, times) as Uint8Array<ArrayBuffer>, { headers: immutableHeaders(request, times ? `${root};times` : root) });
        }
        const pathRead = /^\/\.overstory\/trees\/([^/]+)\/snapshots\/(sha256:[a-f0-9]{64})\/path(\/.*)?$/.exec(url.pathname);
        if (pathRead && request.method === "GET") {
          const root = pathRead[2] as ObjectHash;
          const { tree } = readableTree(pathRead[1]!);
          let path: string;
          try { path = decodePathReadPath(pathRead[3] ?? "/"); }
          catch { return protocolError("invalid-request", "The path is not a valid logical path", 400); }
          const objects = await overstoryd.pathRead(tree.id, root, path);
          if (!objects) return notFound("Snapshot not found");
          // The root and the path name the body: it is as immutable as the snapshot.
          // The path is percent-encoded as in the URL, since a header holds only ASCII.
          const times = url.searchParams.has("times") ? await overstoryd.entryTimesFor(tree.id, root, objects) : undefined;
          return new Response(encodePathReadBundle(objects, times) as Uint8Array<ArrayBuffer>, { headers: immutableHeaders(request, `${root}${encodePathReadPath(path)}${times ? ";times" : ""}`) });
        }
        const metadata = /^\/\.overstory\/trees\/([^/]+)\/entry-metadata$/.exec(url.pathname);
        if (metadata && request.method === "GET") {
          const { tree } = readableTree(metadata[1]!);
          const along = url.searchParams.get("path");
          let path: string | undefined;
          if (along !== null) {
            try { path = canonicalNodePath(along); }
            catch { return protocolError("invalid-request", "The path is not a valid logical path", 400); }
          }
          const value = overstoryd.entryMetadata(tree.id, path);
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
            const update = decodeDerivableUpdateRequestJSON(body.value, body.encoding);
            timer.count("trace-frames", update.updates.reduce((sum, element) => sum + (element.trace?.length ?? 0), 0));
            timer.count("trace-ops", update.updates.reduce((sum, element) =>
              sum + (element.trace ?? []).reduce((ops, frame) => ops + frame.operations.length, 0), 0));
            const tree = overstoryd.get(treeID);
            // Declaring a tree is the null-base first update of its configuration.
            if (!tree && reference.governs && update.base === null && !execution) {
              if (!update.updates.every(isStatedUpdate)) throw new UpdateProtocolError("unsupported-operation", "A declaration states its roots");
              const declared = await overstoryd.declareTree(reference.governs, { base: null, updates: update.updates.flatMap((element) => isStatedUpdate(element) ? [element] : []) }, authentication);
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
        const presenceRoute = /^\/\.overstory\/trees\/([^/]+)\/presence(?:\/([^/]+)(\/messages)?)?$/.exec(url.pathname);
        if (presenceRoute && execution) return protocolError("permission-denied", "Presence is for people and their agents, not execution tokens", 403);
        if (presenceRoute && !presenceRoute[2] && request.method === "GET") {
          const { tree } = readableTree(presenceRoute[1]!);
          const agentParameter = url.searchParams.get("agent");
          let agent: string | null = null;
          try { agent = agentParameter === null ? null : decodePresenceAgentLabel(agentParameter); }
          catch (error) { return protocolError("invalid-request", error instanceof Error ? error.message : String(error), 400); }
          if (agent !== null && !authentication) return protocolError("unauthenticated", "An agent's presence needs an account", 401);
          const visible = url.searchParams.get("visible") !== "false";
          const runnerParameter = url.searchParams.get("runner");
          let runner: string | null = null;
          try { runner = runnerParameter === null ? null : decodePresenceRunnerLabel(runnerParameter); }
          catch (error) { return protocolError("invalid-request", error instanceof Error ? error.message : String(error), 400); }
          if (runner !== null && (!authentication || !visible || agent !== null)) {
            return protocolError("invalid-request", "Only a visible person's stream can be a runner", 400);
          }
          const device = decodePresenceDevice(url.searchParams.get("device"));
          let name: string | null = null;
          if (authentication) {
            try { name = overstoryd.profileCard(authentication.account.id).displayName ?? null; } catch { name = null; }
          }
          server.timeout(request, 0);
          const encoder = new TextEncoder();
          const readable = cachedAuthorization(overstoryd, () => {
            if (visitor) return visitorReads(tree.id);
            const active = !authentication || overstoryd.authenticationIsActive(authentication);
            return active && overstoryd.canRead(account, tree.id, link);
          });
          const authorized = (epoch?: string) => (!authentication || overstoryd.authenticationIsCurrent(authentication))
            && (!visitor || overstoryd.visitorIsActive(visitor)) && readable(epoch);
          let closed = false;
          let wake: (() => void) | undefined;
          let end = () => {};
          let entryID: string | undefined;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              const joined = presence.join(tree.id, {
                caller: authentication ? { account: authentication.account.id, device: authentication.device } : null,
                visible, agent, name, device, runner,
                wake: () => { wake?.(); wake = undefined; },
                close: () => end(),
              });
              entryID = joined.id;
              const stopTicks = onAuthorizationTick((epoch) => { if (!authorized(epoch)) end(); });
              const keepalive = setInterval(() => {
                if (closed) return;
                try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* closing */ }
              }, WATCH_KEEPALIVE_MS);
              keepalive.unref?.();
              const abort = () => end();
              end = () => {
                if (closed) return;
                closed = true;
                stopTicks(); clearInterval(keepalive);
                request.signal.removeEventListener("abort", abort);
                presence.leave(tree.id, joined.id);
                wake?.(); wake = undefined;
                try { controller.close(); } catch {}
              };
              request.signal.addEventListener("abort", abort, {once: true});
              if (request.signal.aborted) return end();
              controller.enqueue(encoder.encode(joined.ready));
            },
            async pull(controller) {
              while (!closed) {
                if (!authorized()) return end();
                const frames = presence.take(tree.id, entryID!);
                if (frames.length) { controller.enqueue(encoder.encode(frames.join(""))); return; }
                await new Promise<void>(resolve => { wake = resolve; });
              }
            },
            cancel() { end(); },
          }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
        }
        if (presenceRoute && presenceRoute[2] && presenceRoute[3] && request.method === "POST") {
          // A message to another of the caller's own streams (spec 12 §6).
          const { tree } = readableTree(presenceRoute[1]!);
          if (!authentication) return notFound("Presence entry not found");
          const raw = new Uint8Array(await request.arrayBuffer());
          if (raw.byteLength > PRESENCE_LIMITS.messageBytes) return protocolError("invalid-request", "The presence message is too large", 413);
          let message;
          try { message = decodePresenceMessagePost(JSON.parse(new TextDecoder().decode(raw))); }
          catch (error) {
            return protocolError("invalid-request", error instanceof PresenceDecodeError ? error.message : "The presence message must be a JSON object", 400);
          }
          try {
            presence.message(tree.id, decodeURIComponent(presenceRoute[2]), { account: authentication.account.id, device: authentication.device }, message.to, message.body);
          } catch (error) {
            if (error instanceof PresenceNotFound) return notFound("Presence entry not found");
            if (error instanceof PresenceBusy) return protocolError("rate-limited", error.message, 429, true);
            throw error;
          }
          return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
        }
        if (presenceRoute && presenceRoute[2] && !presenceRoute[3] && request.method === "POST") {
          const { tree } = readableTree(presenceRoute[1]!);
          // Only the caller that opened the stream may change it; anyone else
          // is told it does not exist, so a presence ID is not a credential.
          if (!authentication) return notFound("Presence entry not found");
          const raw = new Uint8Array(await request.arrayBuffer());
          if (raw.byteLength > PRESENCE_LIMITS.bodyBytes) return protocolError("invalid-request", "The presence update is too large", 413);
          let update;
          try { update = decodePresenceUpdate(JSON.parse(new TextDecoder().decode(raw))); }
          catch (error) {
            return protocolError("invalid-request", error instanceof PresenceDecodeError ? error.message : "The presence update must be a JSON object", 400);
          }
          try {
            presence.update(tree.id, decodeURIComponent(presenceRoute[2]), { account: authentication.account.id, device: authentication.device }, update);
          } catch (error) {
            if (error instanceof PresenceNotFound) return notFound("Presence entry not found");
            if (error instanceof PresenceRefused) return protocolError("invalid-request", error.message, 400);
            if (error instanceof PresenceBusy) return protocolError("rate-limited", error.message, 429, true);
            throw error;
          }
          return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
        }
        if (presenceRoute) return methodNotAllowed();
        const watch = /^\/\.overstory\/trees\/([^/]+)\/watch$/.exec(url.pathname);
        if (watch && request.method === "GET") {
          const { tree, level: access } = readableTree(watch[1]!);
          // Watch streams stay open indefinitely; lift Bun's per-connection idle timeout for them.
          server.timeout(request, 0);
          const encoder = new TextEncoder();
          const credentialSubject = authentication?.subject;
          // `after` is the only resume cursor; `Last-Event-ID` is ignored.
          const after = url.searchParams.get("after");
          // `objects=none`: each frame without its objects; the client refetches what it holds (§1.1.3).
          const objectsParam = url.searchParams.get("objects");
          if (objectsParam !== null && objectsParam !== "none") return protocolError("invalid-request", "objects must be none when present", 400);
          const payloadFree = objectsParam === "none";
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
            if (visitor) return visitorReads(tree.id);
            const active = !authentication || overstoryd.authenticationIsActive(authentication);
            // By ID: a recheck reads the tree as it is now.
            return active && overstoryd.execution.run(execution, () => overstoryd.canRead(account, tree.id, link));
          });
          // Execution token validity and session expiry change with time,
          // not database state, so they are never cached.
          const authorized = (epoch?: string) => (!execution || overstoryd.execution.valid(execution))
            && (!authentication || overstoryd.authenticationIsCurrent(authentication))
            && (!visitor || overstoryd.visitorIsActive(visitor)) && readable(epoch);
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
                  const transition = payloadFree ? { ...next.transition, objects: [], deltas: [] } : next.transition;
                  frames = [encodeSSEFrame({id: next.record.id, event: "tree.update",
                    data: watchFrame(publicOrigin, overstoryd.get(tree.id) ?? tree, transition, access, overstoryd.customDomains)})];
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
          if (visitor ? !visitorReads(treeID) : !overstoryd.isReadableObject(treeID, account, link)) return protocolError("not-found", "Object not found in the named tree", 404, false, {}, { tree: treeID });
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
          const requestLocator = resolveLogicalURL("/", `${url.pathname}${url.search}`);
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
            // One page for every reserved address: it does not say whether the
            // address is held for a profile or for an invitation.
            return html(renderReservedPage(pendingHandle, new URL(publicOrigin).origin, options.storyDownloads), 200, { "overstory-profile-state": "reserved" }, { source: RESERVED_PAGE_SCRIPT });
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
          // At a served domain, links and redirects are spelled without its prefix.
          const publicPath = shown(publicTreePath(canonicalPath, logicalPath));
          if (requestLocator.stableKey && resolved.path !== logicalPath) {
            const location = buildNetworkLocator(publicPath, {
              stableKey: requestLocator.stableKey,
              applicationQuery: requestLocator.applicationQuery,
              contentFragment: requestLocator.contentFragment,
            });
            if (!location) return pageNotFound();
            return new Response(null, { status: 308, headers: { location } });
          }
          const collectionRow = resolution.kind === "collection-row" ? resolution : null;
          const logical = resolution.kind === "node" ? resolution.node : null;
          if (collectionRow) {
            const title = protocolCollectionRowTitle(collectionRow.row);
            if (request.headers.get("accept")?.includes("text/markdown")) {
              return new Response(protocolCollectionRowMarkdown(collectionRow.row), {
                headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" },
              });
            }
            return html(renderPublicDataPage(title, collectionRow.row.properties));
          }
          if (resolution.kind === "collection-table") {
            const prefix = publicPath.replace(/\/$/, "");
            if (request.headers.get("accept")?.includes("text/markdown")) {
              return markdown(childListMarkdown(resolution.table.table!, collectionRowChildren(prefix, resolution.table.rows, requestLocator.applicationQuery)
                .sort((left, right) => left.name.localeCompare(right.name))));
            }
            return html(renderPublicMarkdownPage({
              source: "",
              fallbackTitle: resolution.table.table!,
              origin: shownOrigin,
              treeCanonicalPath: shown(canonicalPath),
              sourceDirectory: markdownSourceDirectory(logicalPath, null),
              publicPath,
              storyDownloads: options.storyDownloads,
              children: collectionRowChildren(prefix, resolution.table.rows, requestLocator.applicationQuery)
                .sort((left, right) => left.name.localeCompare(right.name)),
            }));
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
                origin: shownOrigin,
                treeCanonicalPath: shown(canonicalPath),
                sourceDirectory: markdownSourceDirectory(logicalPath, "sibling"),
                publicPath,
                storyDownloads: options.storyDownloads,
              }));
            }
            // A tree's raw file: an inert image or text type is shown, and
            // anything else, HTML and SVG included, downloads as opaque bytes.
            return new Response(logical.bytes as Uint8Array<ArrayBuffer>, { headers: {
              ...storedFileHeaders(objectName),
              "cache-control": "no-cache",
            } });
          }
          const prefix = publicPath.replace(/\/$/, "");
          const source = logical.body ? new TextDecoder().decode(logical.body) : "";
          const wantsMarkdown = request.headers.get("accept")?.includes("text/markdown");
          // A folder's page is its source, byte for byte.
          if (wantsMarkdown && logical.body) return markdown(source);
          const collectionTables = await projection.collectionTables(logical.directory);
          const physicalChildren = (await Promise.all(logical.directory.entries
            // A collection's schema is its contract, not one of its children.
            .filter((entry) => entry.name !== "_index.md" && !(logical.directory.collection && entry.name === "schema.usl"))
            .map(async (entry): Promise<PublicPageChild | null> => {
              if (entry.tree) {
                const nested = overstoryd.get(entry.tree);
                if (!nested || !overstoryd.canRead(account, nested, link)) return null;
              }
              const markdown = (entry.file ?? entry.page) !== undefined && entry.name.endsWith(".md");
              const publicName = markdown ? entry.name.slice(0, -3) : entry.name;
              return {
                name: publicName,
                href: `${prefix}/${encodeURIComponent(publicName)}${url.search}`,
                kind: entry.tree || entry.directory !== undefined ? "folder" : markdown ? "document" : "file",
              };
            }))).filter((child): child is PublicPageChild => child !== null);
          const collectionChildren: PublicPageChild[] = (collectionTables ?? []).flatMap((table) => table.table === null
            ? collectionRowChildren(prefix, table.rows, requestLocator.applicationQuery)
            : [{ name: table.table, href: `${prefix}/${encodeURIComponent(table.table)}${url.search}`, kind: "folder" as const }]);
          const children = [...physicalChildren, ...collectionChildren]
            .sort((left, right) => left.name.localeCompare(right.name));
          const fallbackTitle = logicalPath.split("/").filter(Boolean).at(-1) ?? canonicalPath.split("/").filter(Boolean).at(-1) ?? overstoryd.communityHandle();
          // A folder with no page of its own answers a list of its children.
          if (wantsMarkdown) return markdown(childListMarkdown(fallbackTitle, children));
          return html(renderPublicMarkdownPage({
            source,
            fallbackTitle,
            origin: shownOrigin,
            treeCanonicalPath: shown(canonicalPath),
            sourceDirectory: markdownSourceDirectory(logicalPath, logical.bodyOrigin ?? null),
            children,
            publicPath,
            storyDownloads: options.storyDownloads,
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
        if (error instanceof ServerBusyError || error instanceof EntryTimesBehind) return protocolError("internal-error", message, 503, true);
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
  }
  if (dynamicLoopbackOrigin) {
    publicOrigin = `${publicOrigin.slice(0, publicOrigin.lastIndexOf(":"))}:${server.port}`;
  }
  if (dynamicLoopbackOrigin) overstoryd.setCommunityHost(new URL(publicOrigin).host, true);
  // Served domains are checked once the listener answers, then on the pin schedule.
  void overstoryd.customDomains.refresh().catch((error) => console.error("overstoryd custom domain check failed", error));
  // The execution sidecar calls the standard API here, on loopback.
  collections?.listen(`http://127.0.0.1:${server.port}`);
  return { overstoryd, server, url: publicOrigin, collections };
}
