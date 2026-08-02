import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectedDocument, PublicAccess, SearchResult, ShareAudience, TreeChild, TreeDescriptor } from "@arbor/core";
import type { NodeRef, NodeSnapshot, ProjectedNodeUpdate, ProjectedNodeView } from "@arbor/client";
import { canonicalNodePath } from "@arbor/core/logical-path";
import { projectSnapshot } from "@arbor/client";
import { api } from "./api.ts";
import { CollectionView } from "./CollectionView.tsx";
import { PageEditor } from "./PageEditor.tsx";

const SIDEBAR_STORAGE_KEY = "arbor.sidebar.collapsed";
const LAST_LOCATION_KEY = "arbor.lastLocation";
const SYSTEM_URL_PREFIX = "/system:";

type SidebarMenuMode = "createDirectory" | "createMarkdown" | "rename" | null;

interface SidebarMenuState {
  x: number;
  y: number;
  target: TreeChild | null;
  mode: SidebarMenuMode;
  value: string;
}

/**
 * The browser location is URL-space: "" is the home surface, an absolute
 * OS path browses the local filesystem (canonicalized into shared trees
 * by arbord), and "/system:…" addresses the read-only control scope.
 */
function pathFromLocation(): string {
  const value = decodeURIComponent(location.pathname.replace(/^\/render/, ""));
  if (!value || value === "/") return "";
  return value;
}

function urlToRef(url: string): NodeRef {
  if (url.startsWith(SYSTEM_URL_PREFIX)) {
    return { tree: "system", path: `/${url.slice(SYSTEM_URL_PREFIX.length)}` || "/" };
  }
  return { tree: "local", path: url };
}

/** The URL-space spelling of a loaded node. */
function nodeUrl(node: NodeSnapshot): string {
  if (node.tree === "system") {
    return node.path === "/" ? SYSTEM_URL_PREFIX.slice(0, -1) + ":" : `${SYSTEM_URL_PREFIX}${node.path.slice(1)}`;
  }
  if (node.enclosingTree?.osPath) {
    return `${node.enclosingTree.osPath}${node.path === "/" ? "" : node.path}`;
  }
  return node.path;
}

/** Compose a scope-relative path from `container`'s scope into URL space. */
function scopeUrl(container: NodeSnapshot, scopePath: string): string {
  if (container.tree === "system") {
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
  return node.kind === "directory" || node.kind === "collection";
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

function scopeChip(node: NodeSnapshot): { label: string; className: string } | null {
  if (node.tree === "local") return { label: "untracked", className: "scope-chip untracked" };
  if (node.tree === "system") return { label: "system · read-only", className: "scope-chip system" };
  if (node.enclosingTree) {
    return {
      label: node.enclosingTree.legacy ? `▣ ${node.enclosingTree.name} · not shared` : `▣ ${node.enclosingTree.name} · ${node.enclosingTree.publicAccess === "none" ? "private" : `public ${node.enclosingTree.publicAccess ?? "read"}`}`,
      className: `scope-chip ${node.enclosingTree.legacy ? "session" : "tracked"}`,
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
  const [projection, setProjection] = useState<ProjectedDocument | null>(null);
  const [nodeUpdates, setNodeUpdates] = useState<AsyncIterable<ProjectedNodeUpdate> | null>(null);
  const [sidebar, setSidebar] = useState<NodeSnapshot | null>(null);
  const [sidebarMenu, setSidebarMenu] = useState<SidebarMenuState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<SearchResult & { url: string }>>([]);
  const [searchScope, setSearchScope] = useState<"root" | "all">("root");
  const [trees, setTrees] = useState<TreeDescriptor[]>([]);
  const [home, setHome] = useState<string | null>(null);
  const [systemCursor, setSystemCursor] = useState<string | null>(null);
  const [server, setServer] = useState<{
    configured: boolean;
    origin?: string;
    handle?: string;
    profileTree?: string;
    profileURL?: string;
    communityURL?: string;
  }>({ configured: false });
  const [treeControl, setTreeControl] = useState<{ path: string; tree?: TreeDescriptor } | null>(null);
  const [treeSlug, setTreeSlug] = useState("");
  const [remoteLocation, setRemoteLocation] = useState<RemoteLocation | null>(launchedRemoteLocation);
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
  const [crumbsExpanded, setCrumbsExpanded] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(storedSidebarCollapsed);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const nodeRequest = useRef(0);
  const nodeView = useRef<ProjectedNodeView | null>(null);
  const pendingRef = useRef<NodeRef | null>(null);
  const sidebarRequest = useRef(0);
  const refreshSystem = useCallback(async () => {
    try {
      const [device, serverNode, treeDirectory] = await Promise.all([
        api.node({ tree: "system", path: "/device" }),
        api.node({ tree: "system", path: "/community" }),
        api.node({ tree: "system", path: "/trees" }),
      ]);
      const deviceHome = device.document?.frontmatter.home;
      setHome(typeof deviceHome === "string" ? deviceHome : null);
      const community = serverNode.document?.frontmatter ?? {};
      const configured = community.connected === true;
      const origin = community.origin;
      setServer({
        configured,
        ...(typeof origin === "string" ? { origin } : {}),
        ...(typeof community.handle === "string" ? { handle: community.handle } : {}),
        ...(typeof community.profileTree === "string" ? { profileTree: community.profileTree } : {}),
        ...(typeof community.profileURL === "string" ? { profileURL: community.profileURL } : {}),
        ...(typeof community.communityURL === "string" ? { communityURL: community.communityURL } : {}),
      });
      const records = await Promise.all((treeDirectory.children ?? []).map((child) =>
        api.node({ tree: "system", path: child.path })
      ));
      setTrees(records.flatMap((record): TreeDescriptor[] => {
        const values = record.document?.frontmatter;
        if (!values || typeof values.id !== "string" || typeof values.placement !== "string") return [];
        return [{
          id: values.id,
          name: typeof values.name === "string" ? values.name : record.name,
          placement: values.placement as TreeDescriptor["placement"],
          ...(typeof values.path === "string" ? { osPath: values.path } : {}),
          ...(typeof values.canonical === "string" ? { canonical: values.canonical } : {}),
          ...(typeof values.http === "string" ? { httpURL: values.http } : {}),
          ...(typeof values.endpoint === "string" ? { endpoint: values.endpoint } : {}),
          ...(typeof values.canonicalPath === "string" ? { canonicalPath: values.canonicalPath } : {}),
          ...(values.publicAccess === "none" || values.publicAccess === "read" || values.publicAccess === "write"
            ? { publicAccess: values.publicAccess as PublicAccess }
            : {}),
          ...(values.access === "read" || values.access === "write" ? { access: values.access } : {}),
          ...(Array.isArray(values.accessEntries)
            ? { accessEntries: values.accessEntries as TreeDescriptor["accessEntries"] }
            : {}),
          ...(typeof values.sync === "string" ? { sync: values.sync as TreeDescriptor["sync"] } : {}),
          ...(values.legacy === true ? { legacy: true } : {}),
        }];
      }));
      setSystemCursor(treeDirectory.observedThrough);
    } catch {}
  }, []);
  useEffect(() => { void refreshSystem(); }, [refreshSystem]);
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
      // A durable-ID reference wins over the (possibly stale) path; arbord
      // resolves it and returns the current location, which is written back
      // through the history correction below.
      const target = pendingRef.current ?? urlToRef(next);
      pendingRef.current = null;
      const view = await api.openProjectedNodeView(target);
      if (request !== nodeRequest.current) {
        view.close();
        return;
      }
      nodeView.current?.close();
      nodeView.current = view;
      const loaded = view.snapshot;
      setNodeUpdates(view.updates);
      setProjection(view.projection);
      const url = nodeUrl(loaded);
      if (url !== next) {
        history.replaceState({}, "", `/render${url}`);
        setPath(url);
      }
      try { localStorage.setItem(LAST_LOCATION_KEY, url); } catch {}
      setNode(loaded);
    }
    catch (error) {
      if (request === nodeRequest.current) setError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const navigate = useCallback((target: string | NodeRef) => {
    setMobileSidebarOpen(false);
    setCrumbsExpanded(false);
    const next = typeof target === "string"
      ? target
      : target.tree === undefined && "pageID" in target
        ? path
        : "path" in target ? target.path : target.pathHint ?? path;
    pendingRef.current = typeof target === "string" ? null : target;
    if (next === path && !pendingRef.current) return;
    nodeRequest.current += 1;
    nodeView.current?.close();
    nodeView.current = null;
    setNodeUpdates(null);
    setProjection(null);
    sidebarRequest.current += 1;
    history.pushState({}, "", `/render${next || "/"}`);
    setPath(next); setNode(null);
    if (!next) setSidebar(null);
  }, [path]);

  /** Navigation from inside a node's scope (editor links, collection rows). */
  const navigateFromNode = useCallback((target: string | NodeRef) => {
    const container = node;
    if (typeof target === "string") {
      navigate(container ? scopeUrl(container, canonicalNodePath(target)) : target);
      return;
    }
    if (target.tree === undefined && container?.tree !== undefined) {
      navigate({ ...target, tree: container.tree });
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
    setProjection(projectSnapshot(loaded));
    setNode(loaded);
  }, [path]);

  useEffect(() => {
    if (!path) {
      nodeView.current?.close();
      nodeView.current = null;
      setNode(null);
      setNodeUpdates(null);
      setProjection(null);
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
      if (request === sidebarRequest.current) setSidebar(loaded);
    }
    catch {
      if (request === sidebarRequest.current) setSidebar(null);
    }
  }, [sidebarUrl]);
  useEffect(() => {
    if (!node) return;
    if (isDirectoryNode(node)) {
      sidebarRequest.current += 1;
      setSidebar((current) => current === node ? current : node);
      return;
    }
    if (sidebar && nodeUrl(sidebar) === sidebarUrl) return;
    if (!sidebarUrl) return;
    const request = ++sidebarRequest.current;
    api.node(urlToRef(sidebarUrl)).then(
      (loaded) => { if (request === sidebarRequest.current) setSidebar(loaded); },
      () => { if (request === sidebarRequest.current) setSidebar(null); },
    );
    return () => {
      if (request === sidebarRequest.current) sidebarRequest.current += 1;
    };
  }, [node, sidebar, sidebarUrl]);

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
          setResults(found.map((result) => ({ ...result, url: `${rootPath}${result.path}` })));
          return;
        }
        const tracked = trees.filter((tree) => tree.placement === "shared" && tree.osPath && !tree.missing);
        const pages = await Promise.all(tracked.map(async (root) => {
          try {
            return { root, found: await api.search(query, root.id) };
          } catch {
            return { root, found: [] as SearchResult[] };
          }
        }));
        setResults(
          pages
            .flatMap(({ root, found }) => found.map((result) => ({ ...result, url: `${root.osPath!}${result.path}` })))
            .sort((a, b) => b.score - a.score)
            .slice(0, 30),
        );
      } catch {
        setResults([]);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [node, query, searchDisabled, searchScope, searchTree, sidebar, trees]);

  const openSidebarMenu = useCallback((event: React.MouseEvent, target: TreeChild | null) => {
    event.preventDefault();
    event.stopPropagation();
    setSidebarMenu({ x: event.clientX, y: event.clientY, target, mode: null, value: "" });
  }, []);

  const sidebarApi = useMemo(() => api.scoped(sidebar?.tree), [sidebar?.tree]);

  const submitSidebarName = useCallback(async () => {
    if (!sidebarMenu?.mode || !sidebar) return;
    const name = sidebarMenu.value.trim();
    if (!name) return;
    try {
      setError(null);
      if (sidebarMenu.mode === "rename" && sidebarMenu.target) {
        const oldPath = sidebarMenu.target.path;
        const nextPath = childPath(oldPath.slice(0, oldPath.lastIndexOf("/")) || "/", name);
        await sidebarApi.mutate({ operations: [{ op: "rename", ref: { path: oldPath }, name }] });
        setSidebarMenu(null);
        const oldUrl = scopeUrl(sidebar, oldPath);
        if (path === oldUrl || path.startsWith(`${oldUrl}/`)) {
          navigate(`${scopeUrl(sidebar, nextPath)}${path.slice(oldUrl.length)}`);
        } else {
          await refreshSidebar();
        }
        return;
      }
      const destination = sidebarMenu.target?.kind === "directory" || sidebarMenu.target?.kind === "collection"
        ? sidebarMenu.target.path
        : sidebar.path;
      const createdPath = childPath(destination, name);
      const operation = sidebarMenu.mode === "createDirectory"
        ? { op: "createDirectory" as const, path: createdPath }
        : { op: "createMarkdown" as const, path: createdPath };
      await sidebarApi.mutate({ operations: [operation] });
      setSidebarMenu(null);
      if (destination === sidebar.path) await refreshSidebar();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [navigate, path, refreshSidebar, sidebar, sidebarApi, sidebarMenu]);

  const trashSidebarTarget = useCallback(async () => {
    const target = sidebarMenu?.target;
    if (!target || !sidebar || !confirm(`Move ${target.name} to Trash?`)) return;
    try {
      setError(null);
      await sidebarApi.mutate({ operations: [{ op: "trash", refs: [{ path: target.path }] }] });
      setSidebarMenu(null);
      const targetUrl = scopeUrl(sidebar, target.path);
      if (path === targetUrl || path.startsWith(`${targetUrl}/`)) navigate(parentUrl(targetUrl));
      else await refreshSidebar();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [navigate, path, refreshSidebar, sidebar, sidebarApi, sidebarMenu]);

  const openTreeControl = useCallback((osPath: string, tree?: TreeDescriptor, proposedCanonicalPath?: string) => {
    const current = tree ? trees.find((candidate) => candidate.id === tree.id) : undefined;
    const controlledTree = tree && current ? { ...tree, ...current } : tree;
    const profilePath = server.profileURL ? new URL(server.profileURL).pathname.replace(/\/$/, "") : "";
    const suggested = osPath.split("/").filter(Boolean).at(-1)?.toLowerCase().replace(/[^a-z0-9-]+/g, "-") ?? "shared";
    setTreeSlug(controlledTree?.canonicalPath ?? proposedCanonicalPath ?? (profilePath ? `${profilePath}/${suggested}` : ""));
    setSharePrivate(false);
    setShareRules([emptyAccessRule()]);
    setProfileLocator("");
    setAccessDraftKind("");
    setAccessDraftPermission("read");
    setLinkURL("");
    setLinkSecret("");
    setTreeControl({ path: osPath, tree: controlledTree });
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
      await api.system({
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
    const record = await api.node({ tree: "system", path: `/trees/${tree.id}` });
    const values = record.document?.frontmatter ?? {};
    const publicAccess = values.publicAccess === "read" || values.publicAccess === "write" ? values.publicAccess : "none";
    const accessEntries = Array.isArray(values.accessEntries)
      ? values.accessEntries as NonNullable<TreeDescriptor["accessEntries"]>
      : [];
    setTreeControl((current) => current?.tree?.id === tree.id
      ? { ...current, tree: { ...current.tree, publicAccess, accessEntries } }
      : current);
  }, [refreshSystem]);

  const setPublicAccess = useCallback(async (tree: TreeDescriptor, access: PublicAccess): Promise<boolean> => {
    if (access === "write" && !confirm("Anyone can create, edit, move, and trash content in this tree. Allow public write access?")) return false;
    try {
      setTreeBusy(true);
      setError(null);
      await api.system({ op: "setTreeAccess", tree: tree.id, subject: { kind: "everyone" }, access });
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
      await api.system({
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
    if (!tree.httpURL) return false;
    const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    try {
      setTreeBusy(true);
      setError(null);
      await api.system({
        op: "setTreeAccess",
        tree: tree.id,
        subject: { kind: "link", secret },
        access,
      });
      const url = new URL(tree.httpURL);
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
      await api.system({
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
      await api.system({
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
      await api.system({
        op: "claimProfile",
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
      await api.system({ op: "disconnectCommunity" });
      setProfileOpen(false);
      await refreshSystem();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [refreshSystem]);

  const placeRemoteTree = useCallback(async (tree: TreeDescriptor) => {
    const destination = prompt(`Where should ${tree.name} live on this machine?`, home ? `${home}/${tree.name}` : "");
    if (!destination) return;
    try {
      setError(null);
      await api.system({ op: "placeTree", tree: tree.id, path: destination });
      await refreshSystem();
      navigate(destination);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [home, navigate, refreshSystem]);

  const toggleSidebar = () => {
    if (matchMedia("(max-width: 760px)").matches) setMobileSidebarOpen((value) => !value);
    else setSidebarCollapsed((value) => !value);
  };

  const crumbs = crumbsFor(path, home);
  const collapseCrumbs = crumbs.length > 6 && !crumbsExpanded;
  const visibleCrumbs = collapseCrumbs ? [crumbs[0]!, ...crumbs.slice(-3)] : crumbs;
  const chip = node ? scopeChip(node) : null;
  const canPromoteHere = Boolean(node && isDirectoryNode(node) && (
    node.tree === "local" || node.enclosingTree?.legacy || (node.enclosingTree && node.path !== "/")
  ));
  const currentTree = node?.enclosingTree && !node.enclosingTree.legacy && node.path === "/" ? node.enclosingTree : null;
  const nestedCanonicalPath = node?.enclosingTree?.canonicalPath && node.path !== "/"
    ? `${node.enclosingTree.canonicalPath.replace(/\/$/, "")}${node.path}`
    : undefined;
  const lastLocation = (() => {
    try { return localStorage.getItem(LAST_LOCATION_KEY); } catch { return null; }
  })();
  const queryIsPath = query.startsWith("/") || query.startsWith("~") || query.startsWith("system:");
  const queryAsUrl = query.startsWith("~")
    ? home ? `${home}${query.slice(1)}` : null
    : query.startsWith("system:") ? `/${query}` : query;

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
        {sidebar?.children?.map((child) => {
          const childUrl = scopeUrl(sidebar, child.path);
          return <button
            className={childUrl === path ? "active" : ""}
            key={child.path}
            onClick={() => navigate(childUrl)}
            onContextMenu={(event) => openSidebarMenu(event, child)}
            onKeyDown={(event) => {
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              event.preventDefault();
              const bounds = event.currentTarget.getBoundingClientRect();
              setSidebarMenu({ x: bounds.left + 20, y: bounds.bottom, target: child, mode: null, value: "" });
            }}
          ><span>{child.kind === "directory" || child.kind === "collection" ? "▸" : "·"}</span>{child.name}{child.materialization === "placeholder" && <small>offline</small>}</button>;
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
          ><span aria-hidden="true">☰</span></button>
          {remoteLocation ? <a className="remote-location" href={remoteLocation.url} target="_blank" rel="noreferrer">{remoteLocation.url}</a> : <div className="breadcrumbs">
            {visibleCrumbs.map((crumb, index) => <span key={crumb.url} className="crumb-group">
              {collapseCrumbs && index === 1 && <button className="crumb-ellipsis" title="Show full path" onClick={() => setCrumbsExpanded(true)}>…</button>}
              <button onClick={() => navigate(crumb.url)}>{crumb.label}</button>
            </span>)}
          </div>}
        </div>
        <div className="header-trailing">
          {currentTree?.osPath && <button
            className="track-button"
            disabled={!server.configured || !server.profileTree}
            title={!server.profileTree ? "Claim or initialize your profile before sharing" : "Manage sharing"}
            onClick={() => openTreeControl(currentTree.osPath!, currentTree)}
          >Share</button>}
          {canPromoteHere && node && <button
            className="track-button"
            disabled={!server.configured || !server.profileTree}
            title={!server.configured || !server.profileTree
              ? "Claim or initialize your profile before sharing"
              : "Share this subtree at a stable community address"}
            onClick={() => openTreeControl(
              nodeUrl(node),
              node.enclosingTree?.legacy ? node.enclosingTree : undefined,
              nestedCanonicalPath,
            )}
          >Share</button>}
          {chip && <span className={chip.className}>{chip.label}</span>}
          {node && <span className="kind">
            {node.document && (node.kind === "markdown" || node.kind === "directory" || node.kind === "collection") ? "ArborNote · " : ""}
            {node.kind}{node.collection ? ` · ${node.collection.backing}` : ""}
          </span>}
          <button
            className="profile-button"
            aria-label="Community and profile"
            title={server.handle ? `Profile: ~${server.handle}` : "No active profile"}
            onClick={() => setProfileOpen(true)}
          >{server.handle ? `~${server.handle}` : "◉"}</button>
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
      </div> : <iframe className="remote-browser-frame" title={remoteLocation.url} src={remoteLocation.url} /> : !path ? <div className="home-surface">
        <h1>Arbor</h1>
        <p className="home-hint">Browse ordinary files anywhere. Claim your profile, then share a subtree at a stable community address.</p>
        <div className="home-roots">
          {trees.map((tree) => <div className="home-root" key={tree.id}>
            <button className="home-root-open" disabled={!tree.osPath || tree.missing} onClick={() => tree.osPath && navigate(tree.osPath)}>
              <strong>{tree.name}</strong>
              <small>{tree.osPath
                ? home && tree.osPath.startsWith(home) ? `~${tree.osPath.slice(home.length)}` : tree.osPath
                : tree.canonical ?? tree.id}</small>
            </button>
            <span className={`scope-chip ${tree.legacy ? "session" : "tracked"}`}>
              {tree.missing ? "missing" : tree.legacy ? "not shared" : tree.osPath ? tree.publicAccess === "none" ? "private" : `public ${tree.publicAccess ?? "read"}` : "remote"}
            </span>
            <button className="quiet" onClick={() => navigate(`/system:trees/${tree.id}`)}>record</button>
            {tree.legacy && tree.osPath && <button className="quiet" disabled={!server.profileTree} onClick={() => openTreeControl(tree.osPath!, tree)}>Share</button>}
            {!tree.legacy && !tree.osPath && <button className="quiet" onClick={() => void placeRemoteTree(tree)}>Sync here…</button>}
            {!tree.legacy && tree.osPath && <button className="quiet" onClick={() => openTreeControl(tree.osPath!, tree)}>Share</button>}
          </div>)}
        </div>
        {home && <button className="quiet home-browse" onClick={() => navigate(home)}>Browse home directory (~)</button>}
        {lastLocation && lastLocation !== path && <button className="quiet home-browse" onClick={() => navigate(lastLocation)}>Continue where you left off: {home && lastLocation.startsWith(home) ? `~${lastLocation.slice(home.length)}` : lastLocation}</button>}
      </div> : error ? <div className="empty error">{error}</div> : !node ? <div className="empty">Loading…</div> : <>
        {node.diagnostics.map((item) => <div className="diagnostic node-diagnostic" key={`${item.code}:${item.path}`}>{item.message}</div>)}
        {node.materialization === "placeholder" ? <div className="file-surface placeholder-file">
          <div className="file-glyph">☁︎</div>
          <h1>{node.name}</h1>
          <p>This file is stored by a cloud provider but is not materialized on this device.</p>
        </div> : <>
          {(node.kind === "markdown" || node.kind === "directory" || node.kind === "collection") && node.document && nodeUpdates && <PageEditor node={node} projection={projection} updates={nodeUpdates} onSaved={acceptNode} navigate={navigateFromNode} />}
          {node.kind === "file" && <div className="file-surface">
            <div className="file-glyph">◇</div>
            <h1>{node.name}</h1>
            <p>Arbor leaves this ordinary file in its native format.</p>
            <div className="file-actions">
              <a href={nodeUrl(node)} target="_blank" rel="noreferrer">Open file</a>
              <a href={nodeUrl(node)} download={node.name}>Download</a>
            </div>
          </div>}
        </>}
        {node.kind === "collection" && <CollectionView node={node} navigate={navigateFromNode} refresh={() => load(path)} />}
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
        {(!sidebarMenu.target || sidebarMenu.target.kind === "directory" || sidebarMenu.target.kind === "collection") && <>
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
        {canPromoteHere && node && <button className="quiet" disabled={!server.profileTree} onClick={() => { setSearchOpen(false); openTreeControl(nodeUrl(node), node.enclosingTree?.legacy ? node.enclosingTree : undefined, nestedCanonicalPath); }}>Share this subtree</button>}
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
        <p className="tree-control-intro">Your public profile is a complete tree. Writable profile and group namespaces appear on Arbor’s home screen.</p>
        {trees.filter((tree) => tree.access === "write" && tree.canonicalPath?.startsWith("/~")).map((tree) =>
          <button className="profile-namespace" key={tree.id} onClick={() => {
            if (tree.osPath) navigate(tree.osPath);
            else void placeRemoteTree(tree);
            setProfileOpen(false);
          }}>
            <strong>{tree.canonicalPath}</strong>
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
      {treeControl.tree && !treeControl.tree.legacy ? <>
        <div className="tree-control-heading">
          <div>
            <span className="eyebrow">Share</span>
            <h2>{treeControl.tree.canonicalPath ?? treeControl.tree.name}</h2>
          </div>
          <button className="modal-close" aria-label="Close" onClick={() => setTreeControl(null)}>×</button>
        </div>
        <div className="canonical-addresses">
          {treeControl.tree.httpURL && <div><span>Web</span><a href={treeControl.tree.httpURL} target="_blank" rel="noreferrer">{treeControl.tree.httpURL}</a><button onClick={() => void navigator.clipboard.writeText(treeControl.tree!.httpURL!)}>Copy</button></div>}
          {treeControl.tree.canonical && <div><span>Arbor</span><code>{treeControl.tree.canonical}</code><button onClick={() => void navigator.clipboard.writeText(treeControl.tree!.canonical!)}>Copy</button></div>}
          <div><span>Identity</span><code>arbor://tree/{treeControl.tree.id}</code><button onClick={() => void navigator.clipboard.writeText(`arbor://tree/${treeControl.tree!.id}`)}>Copy</button></div>
        </div>
        <div className="sync-status">
          <strong>Sync</strong>
          <span className={`sync-dot ${treeControl.tree.sync ?? "idle"}`} />
          <span>{treeControl.tree.sync === "pushing" || treeControl.tree.sync === "pulling" ? "Syncing…" : treeControl.tree.sync === "error" || treeControl.tree.sync === "conflict" ? "Needs attention" : treeControl.tree.sync === "offline" ? "Offline" : "Up to date"}</span>
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
          {(treeControl.tree.publicAccess ?? "none") !== "none" && <div className="access-rule">
            <span className="access-subject"><strong>Everyone</strong><small>Public access</small></span>
            <select aria-label="Everyone permission" value={treeControl.tree.publicAccess} disabled={treeBusy} onChange={(event) => void setPublicAccess(treeControl.tree!, event.target.value as AccessPermission)}>
              <option value="read">Can view</option>
              <option value="write">Can edit</option>
            </select>
            <button className="access-remove" aria-label="Remove everyone" disabled={treeBusy} onClick={() => void setPublicAccess(treeControl.tree!, "none")}>×</button>
          </div>}
          {treeControl.tree.accessEntries?.filter((entry) =>
            entry.kind !== "everyone"
            && !(entry.kind === "profile" && entry.access === "write" && entry.locator === server.profileURL)
          ).map((entry) => <div className="access-rule" key={entry.id}>
            <span className="access-subject"><strong>{entry.kind === "link" ? "Anyone with this private link" : profileLabel(entry.locator ?? "Unavailable profile")}</strong><small>{entry.kind === "link" ? "Secret link" : "Person or group"}</small></span>
            {entry.kind === "profile" && entry.locator ? <select aria-label={`${profileLabel(entry.locator)} permission`} value={entry.access} disabled={treeBusy} onChange={(event) => void setProfileAccess(treeControl.tree!, entry.locator!, event.target.value as AccessPermission)}>
              <option value="read">Can view</option>
              <option value="write">Can edit</option>
            </select> : <span className="access-permission">{entry.access === "write" ? "Can edit" : "Can view"}</span>}
            <button className="access-remove" aria-label={`Remove ${entry.kind === "link" ? "private link" : profileLabel(entry.locator ?? "profile")}`} disabled={treeBusy} onClick={() => void revokeAccessEntry(treeControl.tree!, entry.id)}>×</button>
          </div>)}
          <div className="access-rule access-rule-draft">
            <div className="access-subject-editor">
              <select aria-label="New audience" value={accessDraftKind} disabled={treeBusy} onChange={(event) => setAccessDraftKind(event.target.value as ExistingAccessSubjectKind)}>
                <option value="">Choose an audience…</option>
                <option value="everyone" disabled={(treeControl.tree.publicAccess ?? "none") !== "none"}>Everyone</option>
                <option value="profile">A person or group</option>
                <option value="link" disabled={!treeControl.tree.httpURL}>Anyone with a private link</option>
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
        <div className="modal-actions">
          <button className="quiet" disabled={treeBusy} onClick={() => setTreeControl(null)}>Cancel</button>
          <button className="primary" disabled={treeBusy || !treeSlug || !shareAccessValid} onClick={() => void promoteTree()}>{treeBusy ? "Sharing…" : "Share"}</button>
        </div>
      </>}
    </section></div>}
  </div>;
}
