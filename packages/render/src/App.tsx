import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeft, Share } from "lucide-react";
import type { AccessEntry, RecoveryEntry, SearchResult, NodeSummary, LocalTreeDescriptor } from "@arbor/core";
import type { CommunityPairingOffer, NodeRef, NodeSnapshot, ObservedNodeUpdate, ObservedNodeView } from "@arbor/client";
import { canonicalNodePath } from "@arbor/core/logical-path";
import { canonicalArborLocator, canonicalHTTPURL } from "@arbor/core";
import { api } from "./api.ts";
import { CollectionView } from "./CollectionView.tsx";
import { PageEditor } from "./PageEditor.tsx";
import { ReadOnlyPage } from "./ReadOnlyPage.tsx";
import { hasChildren, hasMarkdownContent, nodeDocument, presentationKind } from "./node-presentation.ts";
import type { ActiveDevice as CommunityDevice } from "./configuration.ts";

type PublicAccess = "none" | "read" | "write";
type TreeDescriptor = LocalTreeDescriptor & { accessEntries?: AccessEntry[] };
type ShareAudience =
  | { kind: "private" }
  | { kind: "everyone"; access: "read" | "write" }
  | { kind: "profile"; locator: string; access: "read" | "write" }
  | { kind: "rules"; rules: Array<
      | { subject: { kind: "everyone" }; access: "read" | "write" }
      | { subject: { kind: "profile"; locator: string }; access: "read" | "write" }
    > };

const SIDEBAR_STORAGE_KEY = "arbor.sidebar.collapsed";
const LAST_LOCATION_KEY = "arbor.lastLocation";
const SYSTEM_URL_PREFIX = "/system:";

type SidebarMenuMode = "createDirectory" | "createMarkdown" | "rename" | null;

interface SidebarMenuState {
  x: number;
  y: number;
  target: NodeSummary | null;
  mode: SidebarMenuMode;
  value: string;
}

interface VisitedTreeSummary {
  id: string;
  tree: string;
  name: string;
  locator: string;
  canonical?: string;
  visitedAt: string;
}

/**
 * The browser location is URL-space: "" is the home surface, an absolute
 * OS path browses the local filesystem (canonicalized into shared trees
 * by arborsync), and "/system:…" addresses the read-only control scope.
 */
function pathFromLocation(): string {
  const value = decodeURIComponent(location.pathname.replace(/^\/render/, ""));
  if (!value || value === "/") return "";
  return value;
}

function urlToRef(url: string): NodeRef {
  if (url.startsWith(SYSTEM_URL_PREFIX)) {
    return { tree: "system", path: `/${url.slice(SYSTEM_URL_PREFIX.length)}` || "/", stableKey: null };
  }
  return { tree: "local", path: url, stableKey: null };
}

/** The URL-space spelling of a loaded node. */
function nodeUrl(node: NodeSnapshot): string {
  if (node.ref.tree === "system") {
    return node.ref.path === "/" ? SYSTEM_URL_PREFIX.slice(0, -1) + ":" : `${SYSTEM_URL_PREFIX}${node.ref.path.slice(1)}`;
  }
  if (node.enclosingTree?.osPath) {
    return `${node.enclosingTree.osPath}${node.ref.path === "/" ? "" : node.ref.path}`;
  }
  return node.ref.path;
}

/** Compose a scope-relative path from `container`'s scope into URL space. */
function scopeUrl(container: NodeSnapshot, scopePath: string): string {
  if (container.ref.tree === "system") {
    return `${SYSTEM_URL_PREFIX}${scopePath === "/" ? "" : scopePath.slice(1)}`;
  }
  if (container.enclosingTree?.osPath) {
    return `${container.enclosingTree.osPath}${scopePath === "/" ? "" : scopePath}`;
  }
  return scopePath;
}

function parentUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith(SYSTEM_URL_PREFIX)) {
    const rest = url.slice(SYSTEM_URL_PREFIX.length);
    const slash = rest.lastIndexOf("/");
    return slash <= 0 ? "" : `${SYSTEM_URL_PREFIX}${rest.slice(0, slash)}`;
  }
  return url.slice(0, url.lastIndexOf("/")) || "/";
}

function childPath(parent: string, name: string): string {
  return canonicalNodePath(`${parent === "/" ? "" : parent}/${name}`);
}

function isDirectoryNode(node: NodeSnapshot): boolean {
  return hasChildren(node);
}

function everyoneAccess(tree: TreeDescriptor): PublicAccess {
  return tree.accessEntries?.find((entry) => entry.subject.kind === "everyone")?.access ?? "none";
}

function storedSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

interface Crumb {
  label: string;
  url: string;
}

function crumbsFor(url: string, home: string | null): Crumb[] {
  if (!url) return [];
  if (url.startsWith(SYSTEM_URL_PREFIX)) {
    const crumbs: Crumb[] = [{ label: "system:", url: "/system:" }];
    const rest = url.slice(SYSTEM_URL_PREFIX.length);
    let acc = SYSTEM_URL_PREFIX;
    for (const part of rest.split("/").filter(Boolean)) {
      acc = acc === SYSTEM_URL_PREFIX ? `${SYSTEM_URL_PREFIX}${part}` : `${acc}/${part}`;
      crumbs.push({ label: part, url: acc });
    }
    return crumbs;
  }
  let remainder = url;
  const crumbs: Crumb[] = [];
  if (home && (url === home || url.startsWith(`${home}/`))) {
    crumbs.push({ label: "~", url: home });
    remainder = url.slice(home.length);
  } else {
    crumbs.push({ label: "/", url: "/" });
  }
  let acc = crumbs[0]!.url === "/" ? "" : crumbs[0]!.url;
  for (const part of remainder.split("/").filter(Boolean)) {
    acc = `${acc}/${part}`;
    crumbs.push({ label: part, url: acc });
  }
  return crumbs;
}

function scopeChip(node: NodeSnapshot): { label: string; className: string; iconOnly?: boolean } | null {
  if (node.ref.tree === "local") return { label: "Share", className: "scope-chip untracked", iconOnly: true };
  if (node.ref.tree === "system") return { label: "System · Read-only", className: "scope-chip system" };
  if (node.enclosingTree) {
    const localOnly = node.enclosingTree.canonical === null;
    return {
      label: localOnly ? "Share" : `${node.enclosingTree.name} · ${node.enclosingTree.access === "write" ? "Writable" : "Read-only"}`,
      className: `scope-chip ${localOnly ? "session" : "tracked"}`,
      iconOnly: localOnly,
    };
  }
  return null;
}

function reservedProfileTarget(input: string): { origin: string; handle: string } | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "arbor:") return null;
    const path = `/${url.pathname.split("/").filter(Boolean).map(decodeURIComponent).join("/")}`;
    const match = /^\/~([a-z0-9][a-z0-9-]{0,62})$/.exec(path);
    if (!match) return null;
    const origin = url.protocol === "arbor:"
      ? `${url.hostname === "localhost" || url.hostname === "127.0.0.1" ? "http" : "https"}://${url.host}`
      : url.origin;
    return { origin, handle: match[1]! };
  } catch {
    return null;
  }
}

function localUserPath(input: string, home: string | null): string | null {
  const value = input.trim();
  if (value.startsWith("/")) return value;
  if (!home) return null;
  if (value === "~") return home;
  if (value.startsWith("~/")) return `${home}/${value.slice(2)}`;
  return null;
}

interface RemoteLocation {
  url: string;
  claimable: boolean;
  handle?: string;
}

type AccessPermission = "read" | "write";
type AccessSubjectKind = "" | "everyone" | "profile";
type ExistingAccessSubjectKind = AccessSubjectKind | "link";

interface DraftAccessRule {
  id: string;
  subject: AccessSubjectKind;
  locator: string;
  access: AccessPermission;
}

function emptyAccessRule(): DraftAccessRule {
  return { id: crypto.randomUUID(), subject: "", locator: "", access: "read" };
}

function canonicalProfileLocator(input: string, community: string | undefined): string {
  const value = input.trim();
  if (!value.startsWith("~")) return value;
  if (!/^~[a-z0-9][a-z0-9-]{0,62}$/.test(value) || !community) return value;
  const url = new URL(community);
  url.pathname = `/${value}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function profileLabel(locator: string): string {
  try {
    const path = new URL(locator).pathname;
    return /^\/~[a-z0-9][a-z0-9-]{0,62}$/.test(path) ? path.slice(1) : locator;
  } catch {
    return locator;
  }
}

function launchedRemoteLocation(): RemoteLocation | null {
  const parameters = new URLSearchParams(location.search);
  const value = parameters.get("browse")?.trim() ?? "";
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const profile = reservedProfileTarget(value);
    return {
      url: url.toString(),
      claimable: parameters.get("claimable") === "true" && Boolean(profile),
      ...(profile ? { handle: profile.handle } : {}),
    };
  } catch {
    return null;
  }
}

export function App() {
  const [path, setPath] = useState(pathFromLocation);
  const [node, setNode] = useState<NodeSnapshot | null>(null);
  const [nodeChildren, setNodeChildren] = useState<NodeSummary[]>([]);
  const [nodeChildrenCursor, setNodeChildrenCursor] = useState<string | null>(null);
  const [nodeUpdates, setNodeUpdates] = useState<AsyncIterable<ObservedNodeUpdate> | null>(null);
  const [pageActionsHost, setPageActionsHost] = useState<HTMLDivElement | null>(null);
  const [sidebar, setSidebar] = useState<NodeSnapshot | null>(null);
  const [sidebarChildren, setSidebarChildren] = useState<NodeSummary[]>([]);
  const [sidebarMenu, setSidebarMenu] = useState<SidebarMenuState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<SearchResult & { url: string }>>([]);
  const [searchScope, setSearchScope] = useState<"root" | "all">("root");
  const [trees, setTrees] = useState<TreeDescriptor[]>([]);
  const [visits, setVisits] = useState<VisitedTreeSummary[]>([]);
  const [recoverable, setRecoverable] = useState<Array<{ tree: TreeDescriptor; entry: RecoveryEntry }>>([]);
  const [home, setHome] = useState<string | null>(null);
  const [systemCursor, setSystemCursor] = useState<string | null>(null);
  const [server, setServer] = useState<{
    configured: boolean;
    credentialAvailable: boolean;
    origin?: string;
    handle?: string;
    profileTree?: string;
    profileURL?: string;
    communityURL?: string;
  }>({ configured: false, credentialAvailable: false });
  const [treeControl, setTreeControl] = useState<{ path: string; tree?: TreeDescriptor } | null>(null);
  const [treeSlug, setTreeSlug] = useState("");
  const [remoteLocation, setRemoteLocation] = useState<RemoteLocation | null>(launchedRemoteLocation);
  const [remoteNode, setRemoteNode] = useState<NodeSnapshot | null>(null);
  const [remoteChildren, setRemoteChildren] = useState<NodeSummary[]>([]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [claimURL, setClaimURL] = useState("");
  const [claimPath, setClaimPath] = useState("");
  const [profileLocator, setProfileLocator] = useState("");
  const [linkURL, setLinkURL] = useState("");
  const [linkSecret, setLinkSecret] = useState("");
  const [sharePrivate, setSharePrivate] = useState(false);
  const [shareRules, setShareRules] = useState<DraftAccessRule[]>(() => [emptyAccessRule()]);
  const [treeBusy, setTreeBusy] = useState(false);
  const [accessDraftKind, setAccessDraftKind] = useState<ExistingAccessSubjectKind>("");
  const [accessDraftPermission, setAccessDraftPermission] = useState<AccessPermission>("read");
  const [devices, setDevices] = useState<CommunityDevice[]>([]);
  const [pairing, setPairing] = useState<CommunityPairingOffer | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [crumbsExpanded, setCrumbsExpanded] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(storedSidebarCollapsed);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const nodeRequest = useRef(0);
  const nodeView = useRef<ObservedNodeView | null>(null);
  const pendingRef = useRef<NodeRef | null>(null);
  const sidebarRequest = useRef(0);
  const systemRequest = useRef(0);
  const refreshSystem = useCallback(async () => {
    const request = ++systemRequest.current;
    try {
      const [treeSnapshot, community, visitedDirectory] = await Promise.all([
        api.client.trees(),
        api.configurationStatus(),
        api.node({ tree: "system", path: "/visited", stableKey: null }),
      ]);
      if (request !== systemRequest.current) return;
      const origin = community.origin;
      setServer({
        configured: community.configured,
        credentialAvailable: community.credentialAvailable,
        ...(typeof origin === "string" ? { origin } : {}),
        ...(typeof community.handle === "string" ? { handle: community.handle } : {}),
        ...(typeof community.profileTree === "string" ? { profileTree: community.profileTree } : {}),
        ...(typeof community.profileURL === "string" ? { profileURL: community.profileURL } : {}),
        ...(typeof community.communityURL === "string" ? { communityURL: community.communityURL } : {}),
      });
      const nextTrees = treeSnapshot.snapshot;
      const currentURLPath = pathFromLocation();
      const activePlacement = nextTrees
        .filter((tree) => tree.osPath && (
          currentURLPath === tree.osPath || currentURLPath.startsWith(`${tree.osPath}/`)
        ))
        .sort((left, right) => right.osPath!.length - left.osPath!.length)[0];
      setHome((current) => activePlacement?.osPath ?? current);
      setTrees(nextTrees);
      const recoveryPages = await Promise.all(nextTrees.filter((tree) => tree.osPath && !tree.missing).map(async (tree) => {
        try { return (await api.scoped(tree.id).recovery("/", true)).map((entry) => ({ tree, entry })); }
        catch { return []; }
      }));
      if (request !== systemRequest.current) return;
      setRecoverable(recoveryPages.flat().sort((a, b) => b.entry.changedAt - a.entry.changedAt));
      const visitedChildren = hasChildren(visitedDirectory)
        ? (await api.children(visitedDirectory.ref)).items
        : [];
      const visitRecords = await Promise.all(visitedChildren.map((child) =>
        api.node(child.ref)
      ));
      if (request !== systemRequest.current) return;
      setVisits(visitRecords.flatMap((record): VisitedTreeSummary[] => {
        const values = record.properties;
        if (!values || typeof values.id !== "string" || typeof values.tree !== "string" || typeof values.locator !== "string") return [];
        return [{
          id: values.id,
          tree: values.tree,
          name: record.name,
          locator: values.locator,
          visitedAt: typeof values.visitedAt === "string" ? values.visitedAt : "",
          ...(typeof values.canonical === "string" ? { canonical: values.canonical } : {}),
        }];
      }));
      setSystemCursor(treeSnapshot.observedThrough);
    } catch {}
  }, []);
  useEffect(() => { void refreshSystem(); }, [refreshSystem]);
  useEffect(() => {
    if (!profileOpen || !server.configured || !server.credentialAvailable) return;
    void api.activeDevices()
      .then(setDevices)
      .catch((error) => setError(error instanceof Error ? error.message : String(error)));
  }, [profileOpen, server.configured, server.credentialAvailable]);
  useEffect(() => {
    if (!remoteLocation || remoteLocation.claimable) {
      setRemoteNode(null);
      setRemoteChildren([]);
      return;
    }
    const request = ++nodeRequest.current;
    setError(null);
    setRemoteNode(null);
    api.client.resolve(remoteLocation.url).then((resolution) => api.client.node(resolution.ref)).then(
      (loaded) => {
        if (request !== nodeRequest.current) return;
        setRemoteNode(loaded);
        if (hasChildren(loaded)) {
          void api.children(loaded.ref).then((page) => {
            if (request === nodeRequest.current) setRemoteChildren(page.items);
          });
        } else setRemoteChildren([]);
      },
      (remoteError) => {
        if (request === nodeRequest.current) setError(remoteError instanceof Error ? remoteError.message : String(remoteError));
      },
    );
    return () => { if (request === nodeRequest.current) nodeRequest.current += 1; };
  }, [remoteLocation]);
  useEffect(() => {
    const refresh = () => { void refreshSystem(); };
    addEventListener("focus", refresh);
    return () => removeEventListener("focus", refresh);
  }, [refreshSystem]);
  useEffect(() => {
    if (!systemCursor) return;
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of api.client.observe(systemCursor, controller.signal)) {
          if (event.tree === "system") await refreshSystem();
        }
      } catch {}
    })();
    return () => controller.abort();
  }, [refreshSystem, systemCursor]);

  const load = useCallback(async (next: string) => {
    const request = ++nodeRequest.current;
    try {
      setError(null);
      // A durable-ID reference wins over the (possibly stale) path; arborsync
      // resolves it and returns the current location, which is written back
      // through the history correction below.
      const target = pendingRef.current ?? urlToRef(next);
      pendingRef.current = null;
      const view = await api.openNodeView(target);
      if (request !== nodeRequest.current) {
        view.close();
        return;
      }
      nodeView.current?.close();
      nodeView.current = view;
      const loaded = view.snapshot;
      if (loaded.enclosingTree?.osPath) setHome(loaded.enclosingTree.osPath);
      const childrenPage = hasChildren(loaded) ? await api.children(loaded.ref) : null;
      if (request !== nodeRequest.current) {
        view.close();
        return;
      }
      setNodeUpdates(view.updates);
      const url = nodeUrl(loaded);
      if (url !== next) {
        history.replaceState({}, "", `/render${url}`);
        setPath(url);
      }
      try { localStorage.setItem(LAST_LOCATION_KEY, url); } catch {}
      setNode(loaded);
      setNodeChildren(childrenPage?.items ?? []);
      setNodeChildrenCursor(childrenPage?.nextCursor ?? null);
    }
    catch (error) {
      if (request === nodeRequest.current) setError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const navigate = useCallback((target: string | NodeRef) => {
    setMobileSidebarOpen(false);
    setCrumbsExpanded(false);
    const next = typeof target === "string" ? target : target.path;
    pendingRef.current = typeof target === "string" ? null : target;
    if (next === path && !pendingRef.current) return;
    nodeRequest.current += 1;
    nodeView.current?.close();
    nodeView.current = null;
    setNodeUpdates(null);
    sidebarRequest.current += 1;
    history.pushState({}, "", `/render${next || "/"}`);
    setPath(next); setNode(null);
    setNodeChildren([]);
    setNodeChildrenCursor(null);
    if (!next) {
      setSidebar(null);
      setSidebarChildren([]);
    }
  }, [path]);

  /** Navigation from inside a node's scope (editor links, collection rows). */
  const navigateFromNode = useCallback((target: string | NodeRef) => {
    const container = node;
    if (typeof target === "string") {
      navigate(container ? scopeUrl(container, canonicalNodePath(target)) : target);
      return;
    }
    if (target.tree === undefined && container?.ref.tree !== undefined) {
      navigate({ ...target, tree: container.ref.tree });
      return;
    }
    navigate(target);
  }, [navigate, node]);

  const acceptNode = useCallback((loaded: NodeSnapshot) => {
    const url = nodeUrl(loaded);
    if (url !== path) {
      history.replaceState({}, "", `/render${url}`);
      setPath(url);
    }
    setNode(loaded);
  }, [path]);

  const loadMoreChildren = useCallback(async () => {
    if (!node || !nodeChildrenCursor) return;
    const page = await api.children(node.ref, nodeChildrenCursor);
    setNodeChildren((items) => [...items, ...page.items]);
    setNodeChildrenCursor(page.nextCursor);
  }, [node, nodeChildrenCursor]);

  useEffect(() => {
    if (!path) {
      nodeView.current?.close();
      nodeView.current = null;
      setNode(null);
      setNodeUpdates(null);
      void refreshSystem();
      return;
    }
    if (node && nodeUrl(node) === path) return;
    void load(path);
    return () => { nodeRequest.current += 1; };
  }, [load, node, path, refreshSystem]);
  useEffect(() => () => nodeView.current?.close(), []);

  const sidebarUrl = node && isDirectoryNode(node) ? nodeUrl(node) : parentUrl(path);
  const refreshSidebar = useCallback(async () => {
    if (!sidebarUrl) return;
    const request = ++sidebarRequest.current;
    try {
      const loaded = await api.node(urlToRef(sidebarUrl));
      const children = hasChildren(loaded) ? (await api.children(loaded.ref)).items : [];
      if (request === sidebarRequest.current) {
        setSidebar(loaded);
        setSidebarChildren(children);
      }
    }
    catch {
      if (request === sidebarRequest.current) {
        setSidebar(null);
        setSidebarChildren([]);
      }
    }
  }, [sidebarUrl]);
  useEffect(() => {
    if (!node) return;
    if (isDirectoryNode(node)) {
      sidebarRequest.current += 1;
      setSidebar((current) => current === node ? current : node);
      setSidebarChildren(nodeChildren);
      return;
    }
    if (sidebar && nodeUrl(sidebar) === sidebarUrl) return;
    if (!sidebarUrl) return;
    const request = ++sidebarRequest.current;
    api.node(urlToRef(sidebarUrl)).then(async (loaded) => ({
      loaded,
      children: hasChildren(loaded) ? (await api.children(loaded.ref)).items : [],
    })).then(
      ({ loaded, children }) => {
        if (request === sidebarRequest.current) {
          setSidebar(loaded);
          setSidebarChildren(children);
        }
      },
      () => {
        if (request === sidebarRequest.current) {
          setSidebar(null);
          setSidebarChildren([]);
        }
      },
    );
    return () => {
      if (request === sidebarRequest.current) sidebarRequest.current += 1;
    };
  }, [node, nodeChildren, sidebar, sidebarUrl]);

  useEffect(() => {
    if (!sidebarMenu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".sidebar-context-menu")) setSidebarMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarMenu(null);
    };
    addEventListener("pointerdown", close, true);
    addEventListener("keydown", escape, true);
    return () => {
      removeEventListener("pointerdown", close, true);
      removeEventListener("keydown", escape, true);
    };
  }, [sidebarMenu]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") { event.preventDefault(); setSearchOpen(true); }
      if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        if (matchMedia("(max-width: 760px)").matches) setMobileSidebarOpen((value) => !value);
        else setSidebarCollapsed((value) => !value);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setMobileSidebarOpen(false);
      }
    };
    const popstate = () => {
      nodeRequest.current += 1;
      nodeView.current?.close();
      nodeView.current = null;
      setNodeUpdates(null);
      sidebarRequest.current += 1;
      setRemoteLocation(launchedRemoteLocation());
      setPath(pathFromLocation());
      setNode(null);
    };
    addEventListener("keydown", listener, true);
    addEventListener("popstate", popstate);
    return () => {
      removeEventListener("keydown", listener, true);
      removeEventListener("popstate", popstate);
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
    } catch {}
  }, [sidebarCollapsed]);

  // Search is scoped to a promoted tree; all-trees fans out client-side.
  const searchTree = node?.enclosingTree?.id ?? sidebar?.enclosingTree?.id;
  const searchDisabled = !searchTree && searchScope === "root";
  useEffect(() => {
    if (!query || searchDisabled) { setResults([]); return; }
    const timer = setTimeout(async () => {
      try {
        if (searchScope === "root" && searchTree) {
          const found = await api.search(query, searchTree);
          const rootPath = node?.enclosingTree?.osPath ?? sidebar?.enclosingTree?.osPath ?? "";
          setResults(found.map((result) => ({ ...result, url: `${rootPath}${result.ref.path}` })));
          return;
        }
        const tracked = trees.filter((tree) => tree.placement !== "remote" && tree.osPath && !tree.missing);
        const pages = await Promise.all(tracked.map(async (root) => {
          try {
            return { root, found: await api.search(query, root.id) };
          } catch {
            return { root, found: [] as SearchResult[] };
          }
        }));
        setResults(
          pages
            .flatMap(({ root, found }) => found.map((result) => ({ ...result, url: `${root.osPath!}${result.ref.path}` })))
            .sort((a, b) => b.score - a.score)
            .slice(0, 30),
        );
      } catch {
        setResults([]);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [node, query, searchDisabled, searchScope, searchTree, sidebar, trees]);

  const openSidebarMenu = useCallback((event: React.MouseEvent, target: NodeSummary | null) => {
    event.preventDefault();
    event.stopPropagation();
    setSidebarMenu({ x: event.clientX, y: event.clientY, target, mode: null, value: "" });
  }, []);

  const sidebarApi = useMemo(() => api.scoped(sidebar?.ref.tree), [sidebar?.ref.tree]);

  const submitSidebarName = useCallback(async () => {
    if (!sidebarMenu?.mode || !sidebar) return;
    const name = sidebarMenu.value.trim();
    if (!name) return;
    try {
      setError(null);
      if (sidebarMenu.mode === "rename" && sidebarMenu.target) {
        const oldPath = sidebarMenu.target.ref.path;
        const nextPath = childPath(oldPath.slice(0, oldPath.lastIndexOf("/")) || "/", name);
        await sidebarApi.mutate({ operations: [{ op: "rename", ref: sidebarMenu.target.ref, name }] });
        setSidebarMenu(null);
        const oldUrl = scopeUrl(sidebar, oldPath);
        if (path === oldUrl || path.startsWith(`${oldUrl}/`)) {
          navigate(`${scopeUrl(sidebar, nextPath)}${path.slice(oldUrl.length)}`);
        } else {
          await refreshSidebar();
        }
        return;
      }
      const destination = sidebarMenu.target && hasChildren(sidebarMenu.target)
        ? sidebarMenu.target.ref.path
        : sidebar.ref.path;
      const createdPath = childPath(destination, name);
      const operation = sidebarMenu.mode === "createDirectory"
        ? { op: "createDirectory" as const, tree: sidebar.ref.tree, path: createdPath }
        : { op: "createMarkdown" as const, tree: sidebar.ref.tree, path: createdPath };
      await sidebarApi.mutate({ operations: [operation] });
      setSidebarMenu(null);
      if (destination === sidebar.ref.path) await refreshSidebar();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [navigate, path, refreshSidebar, sidebar, sidebarApi, sidebarMenu]);

  const trashSidebarTarget = useCallback(async () => {
    const target = sidebarMenu?.target;
    if (!target || !sidebar || !confirm(`Move ${target.name} to Trash?`)) return;
    try {
      setError(null);
      await sidebarApi.mutate({ operations: [{ op: "trash", refs: [target.ref] }] });
      setSidebarMenu(null);
      const targetUrl = scopeUrl(sidebar, target.ref.path);
      if (path === targetUrl || path.startsWith(`${targetUrl}/`)) navigate(parentUrl(targetUrl));
      else await refreshSidebar();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [navigate, path, refreshSidebar, sidebar, sidebarApi, sidebarMenu]);

  const openTreeControl = useCallback((osPath: string, tree?: TreeDescriptor, proposedCanonicalPath?: string) => {
    setError(null);
    const current = tree ? trees.find((candidate) => candidate.id === tree.id) : undefined;
    const controlledTree = tree && current ? { ...tree, ...current } : tree;
    const profilePath = server.profileURL ? new URL(server.profileURL).pathname.replace(/\/$/, "") : "";
    const suggested = osPath.split("/").filter(Boolean).at(-1)?.toLowerCase().replace(/[^a-z0-9-]+/g, "-") ?? "shared";
    setTreeSlug(controlledTree?.canonical?.path ?? proposedCanonicalPath ?? (profilePath ? `${profilePath}/${suggested}` : ""));
    setSharePrivate(false);
    setShareRules([emptyAccessRule()]);
    setProfileLocator("");
    setAccessDraftKind("");
    setAccessDraftPermission("read");
    setLinkURL("");
    setLinkSecret("");
    setTreeControl({ path: osPath, tree: controlledTree });
    if (controlledTree && controlledTree.canonical !== null) {
      void api.configurationAccess(controlledTree.id).then((accessEntries) => {
        setTreeControl((opened) => opened?.tree?.id === controlledTree.id
          ? { ...opened, tree: { ...opened.tree, accessEntries } }
          : opened);
      }).catch((accessError) => setError(accessError instanceof Error ? accessError.message : String(accessError)));
    }
  }, [server.profileURL, trees]);

  const normalizedShareRules = useMemo(() => shareRules.map((rule) => ({
    ...rule,
    locator: rule.subject === "profile"
      ? canonicalProfileLocator(rule.locator, server.communityURL ?? server.origin)
      : "",
  })), [server.communityURL, server.origin, shareRules]);
  const shareRuleKeys = normalizedShareRules.map((rule) => rule.subject === "everyone" ? "everyone" : rule.locator);
  const shareAccessValid = sharePrivate || (
    normalizedShareRules.length > 0
    && normalizedShareRules.every((rule) => rule.subject === "everyone" || (rule.subject === "profile" && /^\w+:\/\//.test(rule.locator)))
    && new Set(shareRuleKeys).size === shareRuleKeys.length
  );

  const promoteTree = useCallback(async () => {
    if (!treeControl || !treeSlug.trim() || !shareAccessValid) return;
    try {
      setTreeBusy(true);
      setError(null);
      const selected: ShareAudience = sharePrivate
        ? { kind: "private" }
        : {
            kind: "rules",
            rules: normalizedShareRules.map((rule) => rule.subject === "everyone"
              ? { subject: { kind: "everyone" as const }, access: rule.access }
              : { subject: { kind: "profile" as const, locator: rule.locator }, access: rule.access }),
          };
      if (
        selected.kind === "rules"
        && selected.rules.some((rule) => rule.subject.kind === "everyone" && rule.access === "write")
        && !confirm("Anyone can create, edit, move, and trash content in this tree. Allow public write access?")
      ) return;
      await api.configure({
        op: "promoteTree",
        path: treeControl.path,
        canonicalPath: treeSlug.trim().startsWith("/") ? treeSlug.trim() : `/${treeSlug.trim()}`,
        audience: selected,
      });
      setTreeControl(null);
      await refreshSystem();
      if (path) await load(path);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setTreeBusy(false);
    }
  }, [load, normalizedShareRules, path, refreshSystem, shareAccessValid, sharePrivate, treeControl, treeSlug]);

  const reloadTreeAccess = useCallback(async (tree: TreeDescriptor) => {
    await refreshSystem();
    const accessEntries = await api.configurationAccess(tree.id);
    setTreeControl((current) => current?.tree?.id === tree.id
      ? { ...current, tree: { ...current.tree, accessEntries } }
      : current);
  }, [refreshSystem]);

  const setPublicAccess = useCallback(async (tree: TreeDescriptor, access: PublicAccess): Promise<boolean> => {
    if (access === "write" && !confirm("Anyone can create, edit, move, and trash content in this tree. Allow public write access?")) return false;
    try {
      setTreeBusy(true);
      setError(null);
      await api.configure({ op: "setTreeAccess", tree: tree.id, subject: { kind: "everyone" }, access });
      await reloadTreeAccess(tree);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setTreeBusy(false);
    }
  }, [reloadTreeAccess]);

  const setProfileAccess = useCallback(async (tree: TreeDescriptor, locatorInput: string, access: "none" | AccessPermission): Promise<boolean> => {
    const locator = canonicalProfileLocator(locatorInput, server.communityURL ?? server.origin);
    if (!locator) return false;
    try {
      setTreeBusy(true);
      setError(null);
      await api.configure({
        op: "setTreeAccess",
        tree: tree.id,
        subject: { kind: "profile", locator },
        access,
      });
      setProfileLocator("");
      await reloadTreeAccess(tree);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setTreeBusy(false);
    }
  }, [reloadTreeAccess, server.communityURL, server.origin]);

  const createLink = useCallback(async (tree: TreeDescriptor, access: AccessPermission): Promise<boolean> => {
    if (!tree.canonical) return false;
    const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    try {
      setTreeBusy(true);
      setError(null);
      await api.configure({
        op: "setTreeAccess",
        tree: tree.id,
        subject: { kind: "link", secret },
        access,
      });
      const url = new URL(canonicalHTTPURL(tree.canonical));
      url.hash = `arbor-access=${encodeURIComponent(secret)}`;
      setLinkURL(url.toString());
      setLinkSecret(secret);
      await navigator.clipboard.writeText(url.toString()).catch(() => {});
      await reloadTreeAccess(tree);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setTreeBusy(false);
    }
  }, [reloadTreeAccess]);

  const revokeLink = useCallback(async (tree: TreeDescriptor) => {
    if (!linkSecret) return;
    try {
      setTreeBusy(true);
      await api.configure({
        op: "setTreeAccess",
        tree: tree.id,
        subject: { kind: "link", secret: linkSecret },
        access: "none",
      });
      setLinkURL("");
      setLinkSecret("");
      await reloadTreeAccess(tree);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setTreeBusy(false);
    }
  }, [linkSecret, reloadTreeAccess]);

  const revokeAccessEntry = useCallback(async (tree: TreeDescriptor, id: string) => {
    try {
      setTreeBusy(true);
      setError(null);
      await api.configure({
        op: "setTreeAccess",
        tree: tree.id,
        subject: { kind: "entry", id },
        access: "none",
      });
      await reloadTreeAccess(tree);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setTreeBusy(false);
    }
  }, [reloadTreeAccess]);

  const addAccessEntry = useCallback(async (tree: TreeDescriptor) => {
    const added = accessDraftKind === "everyone"
      ? await setPublicAccess(tree, accessDraftPermission)
      : accessDraftKind === "profile"
        ? await setProfileAccess(tree, profileLocator, accessDraftPermission)
        : accessDraftKind === "link"
          ? await createLink(tree, accessDraftPermission)
          : false;
    if (!added) return;
    setAccessDraftKind("");
    setAccessDraftPermission("read");
  }, [accessDraftKind, accessDraftPermission, createLink, profileLocator, setProfileAccess, setPublicAccess]);

  const claimProfile = useCallback(async () => {
    const target = reservedProfileTarget(claimURL);
    const profilePath = localUserPath(claimPath, home);
    if (!target || !profilePath) {
      setError("Choose an absolute path or a path beginning with ~/.");
      return;
    }
    try {
      setTreeBusy(true);
      setError(null);
      await api.client.claimProfile({
        origin: target.origin,
        handle: target.handle,
        path: profilePath,
      });
      await refreshSystem();
      setProfileOpen(false);
      setRemoteLocation(null);
      navigate(profilePath);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setTreeBusy(false);
    }
  }, [claimPath, claimURL, home, navigate, refreshSystem]);

  const disconnectCommunity = useCallback(async () => {
    if (!confirm("Disconnect this Arbor account on this device? Local files remain in place.")) return;
    try {
      await api.client.forgetLocalAccount();
      setProfileOpen(false);
      await refreshSystem();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [refreshSystem]);

  const createDevicePairing = useCallback(async () => {
    try {
      setDeviceBusy(true);
      setError(null);
      setPairing(await api.client.createCommunityPairing());
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeviceBusy(false);
    }
  }, []);

  const revokeDevice = useCallback(async (device: CommunityDevice) => {
    if (!confirm(`Revoke ${device.label}? That device will immediately lose server access.`)) return;
    try {
      setDeviceBusy(true);
      setError(null);
      await api.revokeDevice(device.id);
      setDevices((current) => current.filter((item) => item.id !== device.id));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeviceBusy(false);
    }
  }, []);

  const placeRemoteTree = useCallback(async (tree: TreeDescriptor) => {
    const destination = prompt(`Where should ${tree.name} live on this machine?`, home ? `${home}/${tree.name}` : "");
    if (!destination) return;
    try {
      setError(null);
      await api.configure({
        op: "placeTree",
        tree: tree.id,
        path: destination,
        ...(tree.canonical?.endpoint ? { endpoint: tree.canonical?.endpoint } : {}),
        ...(tree.canonical ? { canonical: canonicalArborLocator(tree.canonical) } : {}),
      });
      await refreshSystem();
      navigate(destination);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [home, navigate, refreshSystem]);

  const homeTreeRows = useMemo(() => {
    const placed = trees.filter((tree) => tree.osPath && !tree.missing);
    const depthOf = (tree: TreeDescriptor): number => {
      const parent = placed
        .filter((candidate) => candidate.id !== tree.id && tree.osPath!.startsWith(`${candidate.osPath}/`))
        .sort((a, b) => b.osPath!.length - a.osPath!.length)[0];
      return parent ? depthOf(parent) + 1 : 0;
    };
    return [...trees].sort((a, b) => {
      if (a.osPath && b.osPath) return a.osPath.localeCompare(b.osPath);
      if (a.osPath) return -1;
      if (b.osPath) return 1;
      return a.name.localeCompare(b.name);
    }).map((tree) => ({ tree, depth: tree.osPath ? depthOf(tree) : 0 }));
  }, [trees]);

  const toggleSidebar = () => {
    if (matchMedia("(max-width: 760px)").matches) setMobileSidebarOpen((value) => !value);
    else setSidebarCollapsed((value) => !value);
  };

  const crumbs = crumbsFor(path, home);
  const collapseCrumbs = crumbs.length > 6 && !crumbsExpanded;
  const visibleCrumbs = collapseCrumbs ? [crumbs[0]!, ...crumbs.slice(-3)] : crumbs;
  const chip = node ? scopeChip(node) : null;
  const canPromoteHere = Boolean(node && isDirectoryNode(node) && (
    node.ref.tree === "local" || node.enclosingTree?.canonical === null || (node.enclosingTree && node.ref.path !== "/")
  ));
  const currentTree = node?.enclosingTree && node.enclosingTree.canonical !== null && node.ref.path === "/" ? node.enclosingTree : null;
  const nestedCanonicalPath = node?.enclosingTree?.canonical?.path && node.ref.path !== "/"
    ? `${node.enclosingTree.canonical?.path.replace(/\/$/, "")}${node.ref.path}`
    : undefined;
  const sharingTarget = !remoteLocation && currentTree?.osPath
    ? { path: currentTree.osPath, tree: currentTree, proposedCanonicalPath: undefined }
    : !remoteLocation && canPromoteHere && node
      ? {
          path: nodeUrl(node),
          tree: node.enclosingTree?.canonical === null ? node.enclosingTree : undefined,
          proposedCanonicalPath: nestedCanonicalPath,
        }
      : null;
  const sharingDisabled = !server.configured || !server.credentialAvailable || !server.profileTree;
  const sharingTitle = !server.profileTree
    ? "Claim or initialize your profile before sharing"
    : !server.credentialAvailable
      ? "Restore your community credential before sharing"
      : "Share or manage access";
  const displayedNode = remoteLocation ? remoteNode : node;
  const profileMark = server.handle ? `~${server.handle.slice(0, 1)}` : "◉";
  const lastLocation = (() => {
    try { return localStorage.getItem(LAST_LOCATION_KEY); } catch { return null; }
  })();
  const queryIsPath = query.startsWith("/") || query.startsWith("~") || query.startsWith("system:");
  const queryAsUrl = query.startsWith("~")
    ? home ? `${home}${query.slice(1)}` : null
    : query.startsWith("system:") ? `/${query}` : query;
  const navigateRemote = useCallback((targetPath: string) => {
    const canonical = remoteNode?.enclosingTree?.canonical;
    if (!canonical) return;
    const boundary = canonicalHTTPURL(canonical);
    const suffix = targetPath === "/"
      ? ""
      : `/${targetPath.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
    const nextURL = `${boundary.replace(/\/$/, "")}${suffix}`;
    const next = { url: nextURL, claimable: false };
    const appURL = new URL(location.href);
    appURL.searchParams.set("browse", nextURL);
    appURL.searchParams.delete("claimable");
    history.pushState({}, "", appURL);
    setRemoteLocation(next);
  }, [remoteNode]);

  return <div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}${mobileSidebarOpen ? " mobile-sidebar-open" : ""}${remoteLocation ? " remote-browse" : ""}`}>
    <button className="sidebar-backdrop" aria-label="Close workspace sidebar" onClick={() => setMobileSidebarOpen(false)} />
    <aside className="workspace-sidebar" id="workspace-sidebar">
      <div className="sidebar-heading">
        <button className="brand" onClick={() => navigate("")}>Arbor</button>
        <button className="sidebar-close" aria-label="Collapse workspace sidebar" title="Collapse sidebar (⌘\\)" onClick={toggleSidebar}>
          <svg aria-hidden="true" viewBox="0 0 22 22">
            <path d="m13.5 5.5-5.5 5.5 5.5 5.5" />
          </svg>
        </button>
      </div>
      <button className="search-button" onClick={() => setSearchOpen(true)}>⌘P Search</button>
      <div className="sidebar-path" title={sidebarUrl}>{sidebarUrl && home && sidebarUrl.startsWith(home) ? `~${sidebarUrl.slice(home.length)}` : sidebarUrl}</div>
      <nav aria-label="Workspace files" onContextMenu={(event) => {
        if (event.target === event.currentTarget) openSidebarMenu(event, null);
      }}>
        {sidebarUrl && sidebarUrl !== "/" && !sidebarUrl.endsWith(":") && <button className="nav-up" onClick={() => navigate(parentUrl(sidebarUrl))}><span>↑</span>Parent directory</button>}
        {sidebar && sidebarChildren.map((child) => {
          const childUrl = scopeUrl(sidebar, child.ref.path);
          return <button
            className={childUrl === path ? "active" : ""}
            key={`${child.ref.tree}:${child.ref.path}:${child.ref.stableKey ?? ""}`}
            onClick={() => navigate(childUrl)}
            onContextMenu={(event) => openSidebarMenu(event, child)}
            onKeyDown={(event) => {
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              event.preventDefault();
              const bounds = event.currentTarget.getBoundingClientRect();
              setSidebarMenu({ x: bounds.left + 20, y: bounds.bottom, target: child, mode: null, value: "" });
            }}
          ><span>{hasChildren(child) ? "▸" : "·"}</span>{child.name}{child.materialization === "placeholder" && <small>offline</small>}</button>;
        })}
      </nav>
    </aside>
    <main className="workspace-main">
      <header className="app-header">
        <div className="header-leading">
          <button
            className="sidebar-toggle"
            aria-label="Toggle workspace sidebar"
            aria-controls="workspace-sidebar"
            title="Toggle sidebar (⌘\\)"
            onClick={toggleSidebar}
          ><PanelLeft aria-hidden="true" /></button>
          {remoteLocation ? <a className="remote-location" href={remoteLocation.url} target="_blank" rel="noreferrer">{remoteLocation.url}</a> : <div className="breadcrumbs">
            {visibleCrumbs.map((crumb, index) => <span key={crumb.url} className="crumb-group">
              {collapseCrumbs && index === 1 && <button className="crumb-ellipsis" title="Show full path" onClick={() => setCrumbsExpanded(true)}>…</button>}
              <button onClick={() => navigate(crumb.url)}>{crumb.label}</button>
            </span>)}
          </div>}
        </div>
        <div className="header-trailing">
          <div className="page-actions-host" ref={setPageActionsHost} />
          {remoteNode?.enclosingTree && !trees.some((tree) => tree.id === remoteNode.enclosingTree!.id && tree.osPath)
            ? <button className="quiet" onClick={() => void placeRemoteTree(remoteNode.enclosingTree!)}>Add to workspace…</button>
            : null}
          {remoteLocation
            ? <span className="scope-chip tracked">Remote · {remoteLocation.claimable ? "Reserved" : "Read-only"}</span>
            : chip && sharingTarget
              ? <button
                  type="button"
                  className={`${chip.className} share-control${chip.iconOnly ? " icon-only" : ""}`}
                  aria-label={chip.iconOnly ? chip.label : undefined}
                  disabled={sharingDisabled}
                  title={chip.iconOnly && !sharingDisabled ? "Share this subtree" : sharingTitle}
                  onClick={() => openTreeControl(sharingTarget.path, sharingTarget.tree, sharingTarget.proposedCanonicalPath)}
                >{chip.iconOnly ? <Share aria-hidden="true" /> : chip.label}</button>
              : chip && <span className={chip.className}>{chip.label}</span>}
          {displayedNode?.capabilities.children?.schema && <span className="kind">Structured children</span>}
          <button
            className="profile-button"
            aria-label="Community and profile"
            title={server.handle ? `Profile: ~${server.handle}` : "No active profile"}
            onClick={() => setProfileOpen(true)}
          >{profileMark}</button>
        </div>
      </header>
      {remoteLocation ? remoteLocation.claimable ? <div className="remote-profile-surface">
        <span className="eyebrow">Reserved profile</span>
        <h1>~{remoteLocation.handle}</h1>
        <p>This is an empty profile reserved by its community. It has not been claimed yet.</p>
        <button className="primary" onClick={() => {
          setError(null);
          setClaimURL(remoteLocation.url);
          setProfileOpen(true);
        }}>Claim profile</button>
        <small>First successful claim wins.</small>
      </div> : error ? <div className="empty error">{error}</div> : !remoteNode ? <div className="empty">Loading…</div>
        : hasMarkdownContent(remoteNode)
          ? <ReadOnlyPage node={remoteNode} children={remoteChildren} navigate={navigateRemote} />
          : <div className="file-surface"><div className="file-glyph">◇</div><h1>{remoteNode.name}</h1><p>This remote file is not a Markdown document.</p></div>
      : !path ? <div className="home-surface">
        <h1>Arbor</h1>
        <p className="home-hint">Browse ordinary files anywhere. Claim your profile, then share a subtree at a stable community address.</p>
        <div className="home-roots">
          {homeTreeRows.map(({ tree, depth }) => <div className="home-root" key={tree.id} style={{ marginLeft: `${depth * 28}px` }}>
            <button className="home-root-open" disabled={!tree.osPath || tree.missing} onClick={() => tree.osPath && navigate(tree.osPath)}>
              <strong>{tree.name}</strong>
              <small>{tree.osPath
                ? home && tree.osPath.startsWith(home) ? `~${tree.osPath.slice(home.length)}` : tree.osPath
                : tree.canonical ? canonicalArborLocator(tree.canonical) : tree.id}</small>
            </button>
            <span className={`scope-chip ${tree.canonical === null ? "session" : "tracked"}`}>
              {tree.missing ? "missing" : tree.canonical === null ? "not shared" : tree.osPath ? tree.access === "write" ? "writable" : "read-only" : "remote"}
            </span>
            {tree.canonical === null && tree.osPath && <button className="quiet" disabled={!server.profileTree} onClick={() => openTreeControl(tree.osPath!, tree)}>Share</button>}
            {tree.canonical !== null && !tree.osPath && <button className="quiet" onClick={() => void placeRemoteTree(tree)}>Add to workspace…</button>}
            {tree.canonical !== null && tree.osPath && <button className="quiet" onClick={() => openTreeControl(tree.osPath!, tree)}>Share</button>}
          </div>)}
        </div>
        {visits.length > 0 && <div className="home-visits">
          <h2>Recently visited</h2>
          {visits.map((visit) => {
            const placed = trees.find((tree) => tree.id === visit.tree && tree.osPath);
            const remoteTree: TreeDescriptor = {
              id: visit.tree,
              name: visit.name,
              kind: "ordinary",
              access: "read",
              canonical: visit.canonical ? {
                path: `/${new URL(visit.canonical).pathname.split("/").filter(Boolean).map(decodeURIComponent).join("/")}`,
                endpoint: new URL(visit.canonical).origin,
                parentTree: null,
              } : null,
              placement: "remote",
            };
            return <div className="home-root" key={visit.id}>
              <button className="home-root-open" onClick={() => {
                history.pushState({}, "", `/render?browse=${encodeURIComponent(visit.locator)}`);
                setRemoteLocation({ url: visit.locator, claimable: false });
              }}>
                <strong>{visit.name}</strong>
                <small>{visit.locator}</small>
              </button>
              {placed
                ? <button className="quiet" onClick={() => navigate(placed.osPath!)}>Open local copy</button>
                : <button className="quiet" onClick={() => void placeRemoteTree(remoteTree)}>Add to workspace…</button>}
            </div>;
          })}
        </div>}
        {recoverable.length > 0 && <div className="home-visits">
          <h2>Recoverable across your workspace</h2>
          {recoverable.map(({ tree, entry }) => <div className="home-root" key={`${tree.id}:${entry.kind}:${entry.ref.path}:${entry.kind === "block" ? entry.hash : entry.changedAt}`}>
            <button className="home-root-open" onClick={() => tree.osPath && navigate(`${tree.osPath}${entry.kind === "trash" ? entry.originalPath : entry.ref.path}`)}>
              <strong>{entry.kind === "trash" ? entry.originalPath : entry.ref.path}</strong>
              <small>{tree.name} · {entry.kind === "trash" ? `Trash · ${entry.nodeKind}` : `${entry.status} block`}</small>
            </button>
            <button className="quiet" onClick={async () => {
              try {
                const scoped = api.scoped(tree.id);
                if (entry.kind === "trash") await scoped.restoreTrash(entry.ref);
                else await scoped.restoreBlock(entry.ref, entry.hash);
                await refreshSystem();
              } catch (restoreError) {
                setError(restoreError instanceof Error ? restoreError.message : String(restoreError));
              }
            }}>Restore</button>
          </div>)}
        </div>}
        {home && <button className="quiet home-browse" onClick={() => navigate(home)}>Browse home directory (~)</button>}
        {lastLocation && lastLocation !== path && <button className="quiet home-browse" onClick={() => navigate(lastLocation)}>Continue where you left off: {home && lastLocation.startsWith(home) ? `~${lastLocation.slice(home.length)}` : lastLocation}</button>}
      </div> : error ? <div className="empty error">{error}</div> : !node ? <div className="empty">Loading…</div> : <>
        {node.diagnostics.map((item) => <div className="diagnostic node-diagnostic" key={`${item.code}:${item.path}`}>{item.message}</div>)}
        {node.materialization === "placeholder" ? <div className="file-surface placeholder-file">
          <div className="file-glyph">☁︎</div>
          <h1>{node.name}</h1>
          <p>This file is stored by a cloud provider but is not materialized on this device.</p>
        </div> : <>
          {hasMarkdownContent(node) && nodeUpdates && <PageEditor node={node} children={nodeChildren} updates={nodeUpdates} pageActionsHost={pageActionsHost} onSaved={acceptNode} onChildrenChanged={setNodeChildren} navigate={navigateFromNode} />}
          {!hasMarkdownContent(node) && !hasChildren(node) && <div className="file-surface">
            <div className="file-glyph">◇</div>
            <h1>{node.name}</h1>
            <p>Arbor leaves this ordinary file in its native format.</p>
            <div className="file-actions">
              <a href={nodeUrl(node)} target="_blank" rel="noreferrer">Open file</a>
              <a href={nodeUrl(node)} download={node.name}>Download</a>
            </div>
          </div>}
        </>}
        {node.capabilities.children?.schema && <CollectionView
          node={node}
          items={nodeChildren}
          nextCursor={nodeChildrenCursor}
          navigate={navigateFromNode}
          loadMore={loadMoreChildren}
          refresh={() => load(path)}
        />}
      </>}
    </main>
    {sidebarMenu && <div
      className="sidebar-context-menu"
      role="menu"
      aria-label={sidebarMenu.target ? `Actions for ${sidebarMenu.target.name}` : `Actions in ${sidebarUrl}`}
      style={{ left: sidebarMenu.x, top: sidebarMenu.y }}
    >
      {sidebarMenu.mode ? <div className="sidebar-context-name">
        <input
          autoFocus
          aria-label={sidebarMenu.mode === "rename"
            ? `Rename ${sidebarMenu.target?.name}`
            : sidebarMenu.mode === "createDirectory" ? "New sidebar folder name" : "New sidebar page name"}
          placeholder={sidebarMenu.mode === "rename" ? "Name" : sidebarMenu.mode === "createDirectory" ? "Folder name" : "Page name"}
          value={sidebarMenu.value}
          onChange={(event) => setSidebarMenu({ ...sidebarMenu, value: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); void submitSidebarName(); }
            if (event.key === "Escape") { event.preventDefault(); setSidebarMenu(null); }
          }}
        />
      </div> : <>
        {(!sidebarMenu.target || hasChildren(sidebarMenu.target)) && <>
          <button role="menuitem" onClick={() => setSidebarMenu({ ...sidebarMenu, mode: "createMarkdown", value: "" })}>New Page</button>
          <button role="menuitem" onClick={() => setSidebarMenu({ ...sidebarMenu, mode: "createDirectory", value: "" })}>New Folder</button>
          <div className="menu-separator" />
        </>}
        {sidebarMenu.target && <>
          <button role="menuitem" onClick={() => setSidebarMenu({ ...sidebarMenu, mode: "rename", value: sidebarMenu.target!.name })}>Rename</button>
          <button role="menuitem" className="danger" onClick={() => void trashSidebarTarget()}>Move to Trash</button>
        </>}
      </>}
    </div>}
    {searchOpen && <div className="modal-backdrop" onMouseDown={() => setSearchOpen(false)}><div className="search-modal" onMouseDown={(event) => event.stopPropagation()}>
      <input autoFocus placeholder="Search, or type a path (/, ~, system:)" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && queryIsPath && queryAsUrl) { navigate(queryAsUrl); setSearchOpen(false); setQuery(""); }
      }} />
      <div className="search-scope">
        <button className={searchScope === "root" ? "active" : ""} disabled={!searchTree} onClick={() => setSearchScope("root")}>This tree</button>
        <button className={searchScope === "all" ? "active" : ""} onClick={() => setSearchScope("all")}>All trees</button>
      </div>
      {queryIsPath && queryAsUrl && <button onClick={() => { navigate(queryAsUrl); setSearchOpen(false); setQuery(""); }}><strong>Go to</strong><small>{query}</small></button>}
      {searchDisabled && !queryIsPath && <div className="search-untracked">
        Search begins when this subtree has durable identity.
        {canPromoteHere && node && <button className="quiet" disabled={!server.profileTree} onClick={() => { setSearchOpen(false); openTreeControl(nodeUrl(node), node.enclosingTree?.canonical === null ? node.enclosingTree : undefined, nestedCanonicalPath); }}>Share this subtree</button>}
        <button className="quiet" onClick={() => setSearchScope("all")}>Search all trees</button>
      </div>}
      {results.map((result) => <button key={result.url} onClick={() => { navigate(result.url); setSearchOpen(false); }}><strong>{result.title}</strong><small>{home && result.url.startsWith(home) ? `~${result.url.slice(home.length)}` : result.url}</small><span dangerouslySetInnerHTML={{ __html: result.excerpt }} /></button>)}
    </div></div>}
    {profileOpen && <div className="modal-backdrop" onMouseDown={() => !treeBusy && setProfileOpen(false)}><section className="tree-control-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="tree-control-heading">
        <div>
          <span className="eyebrow">Community account</span>
          <h2>{server.handle ? `~${server.handle}` : reservedProfileTarget(claimURL) ? `Claim ~${reservedProfileTarget(claimURL)!.handle}` : "No active profile"}</h2>
        </div>
        <button className="modal-close" aria-label="Close" onClick={() => setProfileOpen(false)}>×</button>
      </div>
      {server.configured ? <>
        <div className="canonical-addresses">
          {server.communityURL && <div><span>Community</span><a href={server.communityURL.replace(/^arbor:/, location.protocol)} target="_blank" rel="noreferrer">{server.communityURL}</a></div>}
          {server.profileURL && <div><span>Profile</span><code>{server.profileURL}</code><button onClick={() => void navigator.clipboard.writeText(server.profileURL!)}>Copy</button></div>}
        </div>
        <p className="tree-control-intro">Your public profile is a complete tree. Writable community, profile, and group namespaces appear here and on Arbor’s home screen.</p>
        {!server.credentialAvailable && server.origin && <p className="control-error" role="alert">This device’s credential is unavailable. Run <code>arbor connect {server.origin}</code>, then return to Arbor.</p>}
        {server.credentialAvailable && <section className="access-builder" aria-labelledby="device-management-title">
          <div className="access-builder-heading">
            <div><h3 id="device-management-title">Devices</h3><p>Each paired device has its own revocable credential.</p></div>
            <button disabled={deviceBusy} onClick={() => void createDevicePairing()}>Pair a device</button>
          </div>
          {devices.map((device) => <div className="access-rule" key={device.id}>
            <span className="access-subject"><strong>{device.label}</strong><small>{device.revokedAt ? "Revoked" : device.lastUsedAt ? `Last used ${new Date(device.lastUsedAt).toLocaleString()}` : `Added ${new Date(device.createdAt).toLocaleString()}`}</small></span>
            <span className="access-permission">{device.revokedAt ? "No access" : "Active"}</span>
            {!device.revokedAt && <button className="access-remove" disabled={deviceBusy} aria-label={`Revoke ${device.label}`} onClick={() => void revokeDevice(device)}>×</button>}
          </div>)}
          {pairing && server.origin && <div className="url-preview">
            <strong>Confirmation code: {pairing.confirmationCode}</strong>
            <small>Expires {new Date(pairing.expiresAt).toLocaleString()}. Confirm the same code on the new device.</small>
            <button onClick={() => void navigator.clipboard.writeText(JSON.stringify({ version: 1, origin: server.origin, pairing: { id: pairing.id, secret: pairing.secret } }))}>Copy pairing data</button>
            <button className="quiet" onClick={() => setPairing(null)}>Hide</button>
          </div>}
        </section>}
        {trees.filter((tree) => tree.access === "write" && (tree.canonical?.path === "/" || tree.canonical?.path?.startsWith("/~"))).map((tree) =>
          <button className="profile-namespace" key={tree.id} onClick={() => {
            if (tree.osPath) navigate(tree.osPath);
            else void placeRemoteTree(tree);
            setProfileOpen(false);
          }}>
            <strong>{tree.canonical?.path === "/" ? "Community" : tree.canonical?.path}</strong>
            <small>{tree.osPath ?? "Choose a local folder…"}</small>
          </button>
        )}
        <div className="modal-actions">
          <button className="quiet danger" onClick={() => void disconnectCommunity()}>Disconnect</button>
          {server.profileURL && <a className="primary link-button" href={server.profileURL.replace(/^arbor:/, location.protocol)} target="_blank" rel="noreferrer">View public profile</a>}
        </div>
      </> : claimURL ? <>
        <p className="tree-control-intro">Choose where this public profile should live on this device. Arbor will create the folder if it does not exist.</p>
        <label className="control-field"><span>Local profile folder</span><input autoFocus placeholder="~/.arbor/profile" value={claimPath} onChange={(event) => setClaimPath(event.target.value)} /></label>
        {error && <p className="control-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button className="primary" disabled={treeBusy || !claimPath.trim()} onClick={() => void claimProfile()}>{treeBusy ? "Claiming…" : "Claim profile"}</button>
        </div>
      </> : <p className="tree-control-intro">No profile is active on this device. Browse a reserved profile address to claim it.</p>}
    </section></div>}
    {treeControl && <div className="modal-backdrop" onMouseDown={() => !treeBusy && setTreeControl(null)}><section className="tree-control-modal" onMouseDown={(event) => event.stopPropagation()}>
      {treeControl.tree && treeControl.tree.canonical !== null ? <>
        <div className="tree-control-heading">
          <div>
            <span className="eyebrow">Share</span>
            <h2>{treeControl.tree.canonical?.path ?? treeControl.tree.name}</h2>
          </div>
          <button className="modal-close" aria-label="Close" onClick={() => setTreeControl(null)}>×</button>
        </div>
        <div className="canonical-addresses">
          {treeControl.tree.canonical && <div><span>Web</span><a href={canonicalHTTPURL(treeControl.tree.canonical)} target="_blank" rel="noreferrer">{canonicalHTTPURL(treeControl.tree.canonical)}</a><button onClick={() => void navigator.clipboard.writeText(canonicalHTTPURL(treeControl.tree!.canonical!))}>Copy</button></div>}
          {treeControl.tree.canonical && <div><span>Arbor</span><code>{canonicalArborLocator(treeControl.tree.canonical)}</code><button onClick={() => void navigator.clipboard.writeText(canonicalArborLocator(treeControl.tree!.canonical!))}>Copy</button></div>}
          <div><span>Identity</span><code>arbor://tree/{treeControl.tree.id}</code><button onClick={() => void navigator.clipboard.writeText(`arbor://tree/${treeControl.tree!.id}`)}>Copy</button></div>
        </div>
        <div className="sync-status">
          <strong>Sync</strong>
          <span className={`sync-dot ${treeControl.tree.sync ?? "idle"}`} />
          <span>{treeControl.tree.sync === "syncing" ? "Syncing…" : treeControl.tree.sync === "error" || treeControl.tree.sync === "conflict" ? "Needs attention" : treeControl.tree.sync === "offline" ? "Offline" : "Up to date"}</span>
        </div>
        <section className="access-builder" aria-labelledby="access-builder-title">
          <div className="access-builder-heading">
            <div><h3 id="access-builder-title">Access</h3><p>Rules are additive. People may receive access directly or through a group.</p></div>
          </div>
          <div className="access-rule locked">
            <span className="access-subject"><strong>Profile writers</strong><small>Always retained</small></span>
            <span className="access-permission">Can edit</span>
            <span className="access-lock" aria-label="Required access">●</span>
          </div>
          {everyoneAccess(treeControl.tree) !== "none" && <div className="access-rule">
            <span className="access-subject"><strong>Everyone</strong><small>Public access</small></span>
            <select aria-label="Everyone permission" value={everyoneAccess(treeControl.tree)} disabled={treeBusy} onChange={(event) => void setPublicAccess(treeControl.tree!, event.target.value as AccessPermission)}>
              <option value="read">Can view</option>
              <option value="write">Can edit</option>
            </select>
            <button className="access-remove" aria-label="Remove everyone" disabled={treeBusy} onClick={() => void setPublicAccess(treeControl.tree!, "none")}>×</button>
          </div>}
          {treeControl.tree.accessEntries?.filter((entry) =>
            entry.subject.kind !== "everyone"
            && !(entry.subject.kind === "profile" && entry.access === "write" && entry.subject.locator === server.profileURL)
          ).map((entry) => <div className="access-rule" key={entry.id}>
            <span className="access-subject"><strong>{entry.subject.kind === "link" ? "Anyone with this private link" : profileLabel(entry.subject.kind === "profile" ? entry.subject.locator ?? "Unavailable profile" : "Everyone")}</strong><small>{entry.subject.kind === "link" ? "Secret link" : "Person or group"}</small></span>
            {entry.subject.kind === "profile" && entry.subject.locator ? <select aria-label={`${profileLabel(entry.subject.locator)} permission`} value={entry.access} disabled={treeBusy} onChange={(event) => void setProfileAccess(treeControl.tree!, entry.subject.kind === "profile" ? entry.subject.locator! : "", event.target.value as AccessPermission)}>
              <option value="read">Can view</option>
              <option value="write">Can edit</option>
            </select> : <span className="access-permission">{entry.access === "write" ? "Can edit" : "Can view"}</span>}
            <button className="access-remove" aria-label={`Remove ${entry.subject.kind === "link" ? "private link" : profileLabel(entry.subject.kind === "profile" ? entry.subject.locator ?? "profile" : "everyone")}`} disabled={treeBusy} onClick={() => void revokeAccessEntry(treeControl.tree!, entry.id)}>×</button>
          </div>)}
          <div className="access-rule access-rule-draft">
            <div className="access-subject-editor">
              <select aria-label="New audience" value={accessDraftKind} disabled={treeBusy} onChange={(event) => setAccessDraftKind(event.target.value as ExistingAccessSubjectKind)}>
                <option value="">Choose an audience…</option>
                <option value="everyone" disabled={everyoneAccess(treeControl.tree) !== "none"}>Everyone</option>
                <option value="profile">A person or group</option>
                <option value="link" disabled={!treeControl.tree.canonical}>Anyone with a private link</option>
              </select>
              {accessDraftKind === "profile" && <input aria-label="Person or group" placeholder="~alice or ~editors" value={profileLocator} onChange={(event) => setProfileLocator(event.target.value)} />}
            </div>
            <select aria-label="New audience permission" value={accessDraftPermission} disabled={treeBusy || !accessDraftKind} onChange={(event) => setAccessDraftPermission(event.target.value as AccessPermission)}>
              <option value="read">Can view</option>
              <option value="write">Can edit</option>
            </select>
            <button className="access-add" disabled={treeBusy || !accessDraftKind || (accessDraftKind === "profile" && !profileLocator.trim())} onClick={() => void addAccessEntry(treeControl.tree!)}>Add</button>
          </div>
          {linkURL && <div className="url-preview"><span>{linkURL}</span><small>This private link has been copied and is shown once.</small><button className="quiet" onClick={() => void revokeLink(treeControl.tree!)}>Revoke this link</button></div>}
        </section>
        {error && <p className="control-error" role="alert">{error}</p>}
      </> : <>
        <div className="tree-control-heading">
          <div>
            <span className="eyebrow">Share</span>
            <h2>Share this subtree</h2>
          </div>
          <button className="modal-close" aria-label="Close" onClick={() => setTreeControl(null)}>×</button>
        </div>
        <p className="tree-control-intro">This promotes the visible subtree in place into its own identity, sync, history, and permission boundary. Its files stay where they are.</p>
        <label className="control-field"><span>Local subtree</span><input readOnly value={treeControl.path} /></label>
        <label className="control-field"><span>Canonical path</span><input autoFocus placeholder="/~alice/notes" pattern="/[~a-z0-9][a-z0-9~/-]*" value={treeSlug} onChange={(event) => setTreeSlug(`/${event.target.value.replace(/^\/+/, "").toLowerCase().replace(/[^a-z0-9~/-]/g, "")}`)} /><small>Choose an available child path beneath a profile or group you can write.</small></label>
        {server.origin && treeSlug && <div className="url-preview">
          <span>{server.origin.replace(/\/$/, "")}{treeSlug}</span>
          <span>arbor://{server.origin.replace(/^https?:\/\//, "").split("/")[0]}{treeSlug}</span>
        </div>}
        <section className="access-builder" aria-labelledby="new-access-builder-title">
          <div className="access-builder-heading">
            <div><h3 id="new-access-builder-title">Access</h3><p>Add everyone, individual people, or groups. Rules are additive.</p></div>
            <small>Required</small>
          </div>
          <div className="access-rule locked">
            <span className="access-subject"><strong>Profile writers</strong><small>Always retained</small></span>
            <span className="access-permission">Can edit</span>
            <span className="access-lock" aria-label="Required access">●</span>
          </div>
          {sharePrivate ? <div className="access-rule private-rule">
            <span className="access-subject"><strong>Private</strong><small>No additional access</small></span>
            <span className="access-permission">Profile writers only</span>
            <button className="access-remove" aria-label="Change private access" disabled={treeBusy} onClick={() => { setSharePrivate(false); setShareRules([emptyAccessRule()]); }}>×</button>
          </div> : <>
            {shareRules.map((rule, index) => <div className="access-rule access-rule-draft" key={rule.id}>
              <div className="access-subject-editor">
                <select aria-label={`Audience ${index + 1}`} value={rule.subject} disabled={treeBusy} onChange={(event) => {
                  const subject = event.target.value as AccessSubjectKind;
                  setShareRules((current) => current.map((item) => item.id === rule.id ? { ...item, subject, locator: "" } : item));
                }}>
                  <option value="">Choose an audience…</option>
                  <option value="everyone" disabled={shareRules.some((item) => item.id !== rule.id && item.subject === "everyone")}>Everyone</option>
                  <option value="profile">A person or group</option>
                </select>
                {rule.subject === "profile" && <input aria-label={`Person or group ${index + 1}`} placeholder="~alice or ~editors" value={rule.locator} onChange={(event) => setShareRules((current) => current.map((item) => item.id === rule.id ? { ...item, locator: event.target.value } : item))} />}
              </div>
              <select aria-label={`Audience ${index + 1} permission`} value={rule.access} disabled={treeBusy || !rule.subject} onChange={(event) => setShareRules((current) => current.map((item) => item.id === rule.id ? { ...item, access: event.target.value as AccessPermission } : item))}>
                <option value="read">Can view</option>
                <option value="write">Can edit</option>
              </select>
              <button className="access-remove" aria-label={`Remove audience ${index + 1}`} disabled={treeBusy} onClick={() => setShareRules((current) => current.filter((item) => item.id !== rule.id))}>×</button>
            </div>)}
            <div className="access-builder-actions">
              <button disabled={treeBusy} onClick={() => setShareRules((current) => [...current, emptyAccessRule()])}>+ Add another audience</button>
              <button disabled={treeBusy} onClick={() => { setShareRules([]); setSharePrivate(true); }}>Keep private instead</button>
            </div>
          </>}
        </section>
        {error && <p className="control-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button className="quiet" disabled={treeBusy} onClick={() => setTreeControl(null)}>Cancel</button>
          <button className="primary" disabled={treeBusy || !treeSlug || !shareAccessValid} onClick={() => void promoteTree()}>{treeBusy ? "Sharing…" : "Share"}</button>
        </div>
      </>}
    </section></div>}
  </div>;
}
