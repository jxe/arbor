import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectedDocument, PublicationMode, SearchResult, TreeChild, TreeDescriptor } from "@arbor/core";
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
      label: node.enclosingTree.legacy ? `▣ ${node.enclosingTree.name} · needs URL` : `▣ ${node.enclosingTree.name} · ${node.enclosingTree.publication ?? "private"}`,
      className: `scope-chip ${node.enclosingTree.legacy ? "session" : "tracked"}`,
    };
  }
  return null;
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
  const [server, setServer] = useState<{ configured: boolean; origin?: string }>({ configured: false });
  const [treeControl, setTreeControl] = useState<{ path: string; tree?: TreeDescriptor } | null>(null);
  const [treeSlug, setTreeSlug] = useState("");
  const [serverOrigin, setServerOrigin] = useState("");
  const [ownerToken, setOwnerToken] = useState("");
  const [treeBusy, setTreeBusy] = useState(false);
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
        api.node({ tree: "system", path: "/server" }),
        api.node({ tree: "system", path: "/trees" }),
      ]);
      const deviceHome = device.document?.frontmatter.home;
      setHome(typeof deviceHome === "string" ? deviceHome : null);
      const configured = serverNode.document?.frontmatter.configured === true;
      const origin = serverNode.document?.frontmatter.origin;
      setServer({ configured, ...(typeof origin === "string" ? { origin } : {}) });
      if (typeof origin === "string") setServerOrigin(origin);
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
          ...(typeof values.publication === "string" ? { publication: values.publication as PublicationMode } : {}),
          ...(values.access === "read" || values.access === "write" ? { access: values.access } : {}),
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

  const openTreeControl = useCallback((osPath: string, tree?: TreeDescriptor) => {
    setTreeSlug("");
    setOwnerToken("");
    setTreeControl({ path: osPath, tree });
  }, []);

  const promoteTree = useCallback(async () => {
    if (!treeControl || !treeSlug.trim()) return;
    try {
      setTreeBusy(true);
      setError(null);
      if (!server.configured) {
        await api.system({ op: "configureServer", origin: serverOrigin.trim(), ownerToken });
      }
      await api.system({ op: "promoteTree", path: treeControl.path, slug: treeSlug.trim() });
      setTreeControl(null);
      await refreshSystem();
      if (path) await load(path);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setTreeBusy(false);
    }
  }, [load, ownerToken, path, refreshSystem, server.configured, serverOrigin, treeControl, treeSlug]);

  const setPublication = useCallback(async (tree: TreeDescriptor, publication: PublicationMode) => {
    if (publication === "public-write" && !confirm("Anyone can create, edit, move, and trash content in this tree. Publish read/write?")) return;
    try {
      setTreeBusy(true);
      setError(null);
      await api.system({ op: "setTreePublication", tree: tree.id, publication });
      await refreshSystem();
      setTreeControl((current) => current?.tree?.id === tree.id
        ? { ...current, tree: { ...tree, publication } }
        : current);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setTreeBusy(false);
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
  const lastLocation = (() => {
    try { return localStorage.getItem(LAST_LOCATION_KEY); } catch { return null; }
  })();
  const queryIsPath = query.startsWith("/") || query.startsWith("~") || query.startsWith("system:");
  const queryAsUrl = query.startsWith("~")
    ? home ? `${home}${query.slice(1)}` : null
    : query.startsWith("system:") ? `/${query}` : query;

  return <div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}${mobileSidebarOpen ? " mobile-sidebar-open" : ""}`}>
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
          <div className="breadcrumbs">
            {visibleCrumbs.map((crumb, index) => <span key={crumb.url} className="crumb-group">
              {collapseCrumbs && index === 1 && <button className="crumb-ellipsis" title="Show full path" onClick={() => setCrumbsExpanded(true)}>…</button>}
              <button onClick={() => navigate(crumb.url)}>{crumb.label}</button>
            </span>)}
          </div>
        </div>
        <div className="header-trailing">
          {currentTree?.osPath && <button className="track-button" onClick={() => openTreeControl(currentTree.osPath!, currentTree)}>Canonical tree</button>}
          {canPromoteHere && node && <button
            className="track-button"
            title="Give this subtree durable identity, private sync, and a canonical address"
            onClick={() => openTreeControl(nodeUrl(node), node.enclosingTree?.legacy ? node.enclosingTree : undefined)}
          >Give this subtree a URL</button>}
          {chip && <span className={chip.className}>{chip.label}</span>}
          {node && <span className="kind">
            {node.document && (node.kind === "markdown" || node.kind === "directory" || node.kind === "collection") ? "ArborNote · " : ""}
            {node.kind}{node.collection ? ` · ${node.collection.backing}` : ""}
          </span>}
        </div>
      </header>
      {!path ? <div className="home-surface">
        <h1>Arbor</h1>
        <p className="home-hint">Browse ordinary files anywhere. Give a subtree a URL when you want durable identity, private sync, and publication.</p>
        <div className="home-roots">
          {trees.map((tree) => <div className="home-root" key={tree.id}>
            <button className="home-root-open" disabled={!tree.osPath || tree.missing} onClick={() => tree.osPath && navigate(tree.osPath)}>
              <strong>{tree.name}</strong>
              <small>{tree.osPath
                ? home && tree.osPath.startsWith(home) ? `~${tree.osPath.slice(home.length)}` : tree.osPath
                : tree.canonical ?? tree.id}</small>
            </button>
            <span className={`scope-chip ${tree.legacy ? "session" : "tracked"}`}>
              {tree.missing ? "missing" : tree.legacy ? "needs URL" : tree.osPath ? tree.publication ?? "private" : "remote"}
            </span>
            <button className="quiet" onClick={() => navigate(`/system:trees/${tree.id}`)}>record</button>
            {tree.legacy && tree.osPath && <button className="quiet" onClick={() => openTreeControl(tree.osPath!, tree)}>Give URL</button>}
            {!tree.legacy && !tree.osPath && <button className="quiet" onClick={() => void placeRemoteTree(tree)}>Sync here…</button>}
            {!tree.legacy && tree.osPath && <button className="quiet" onClick={() => openTreeControl(tree.osPath!, tree)}>manage</button>}
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
        {canPromoteHere && node && <button className="quiet" onClick={() => { setSearchOpen(false); openTreeControl(nodeUrl(node), node.enclosingTree?.legacy ? node.enclosingTree : undefined); }}>Give this subtree a URL</button>}
        <button className="quiet" onClick={() => setSearchScope("all")}>Search all trees</button>
      </div>}
      {results.map((result) => <button key={result.url} onClick={() => { navigate(result.url); setSearchOpen(false); }}><strong>{result.title}</strong><small>{home && result.url.startsWith(home) ? `~${result.url.slice(home.length)}` : result.url}</small><span dangerouslySetInnerHTML={{ __html: result.excerpt }} /></button>)}
    </div></div>}
    {treeControl && <div className="modal-backdrop" onMouseDown={() => !treeBusy && setTreeControl(null)}><section className="tree-control-modal" onMouseDown={(event) => event.stopPropagation()}>
      {treeControl.tree && !treeControl.tree.legacy ? <>
        <div className="tree-control-heading">
          <div>
            <span className="eyebrow">Canonical tree</span>
            <h2>{treeControl.tree.name}</h2>
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
        <fieldset className="publication-control" disabled={treeBusy}>
          <legend>Publication</legend>
          {([
            ["private", "Private", "Only your Arbor devices"],
            ["public-read", "Public read", "Anyone with the URL can read"],
            ["public-write", "Public read/write", "Anyone can change current content"],
          ] as const).map(([mode, label, detail]) => <label key={mode}>
            <input type="radio" name="publication" checked={(treeControl.tree!.publication ?? "private") === mode} onChange={() => void setPublication(treeControl.tree!, mode)} />
            <span><strong>{label}</strong><small>{detail}</small></span>
          </label>)}
        </fieldset>
        <section className="sharing-placeholder" aria-disabled="true">
          <div><h3>Sharing</h3><span>Coming next</span></div>
          <p>Sharing with people is not available yet.</p>
          <div className="sharing-preview">
            <input disabled placeholder="Name or email address" />
            <button disabled>Invite</button>
          </div>
        </section>
      </> : <>
        <div className="tree-control-heading">
          <div>
            <span className="eyebrow">{treeControl.tree?.legacy ? "Needs a URL" : "Canonical tree"}</span>
            <h2>Give this subtree a URL</h2>
          </div>
          <button className="modal-close" aria-label="Close" onClick={() => setTreeControl(null)}>×</button>
        </div>
        <p className="tree-control-intro">This creates durable identity and begins private sync. You can publish it after the initial upload completes.</p>
        <label className="control-field"><span>Local subtree</span><input readOnly value={treeControl.path} /></label>
        {!server.configured && <>
          <label className="control-field"><span>Personal server</span><input autoFocus type="url" placeholder="https://arbor.example.com" value={serverOrigin} onChange={(event) => setServerOrigin(event.target.value)} /></label>
          <label className="control-field"><span>Owner token</span><input type="password" autoComplete="new-password" value={ownerToken} onChange={(event) => setOwnerToken(event.target.value)} /><small>Stored in the operating system credential store, never Arbor’s journal.</small></label>
        </>}
        <label className="control-field"><span>URL name</span><input autoFocus={server.configured} placeholder="notes" pattern="[a-z0-9][a-z0-9-]*" value={treeSlug} onChange={(event) => setTreeSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} /></label>
        {(server.origin ?? serverOrigin) && treeSlug && <div className="url-preview">
          <span>{(server.origin ?? serverOrigin).replace(/\/$/, "")}/{treeSlug}</span>
          <span>arbor://{(server.origin ?? serverOrigin).replace(/^https?:\/\//, "").split("/")[0]}/{treeSlug}</span>
        </div>}
        <div className="modal-actions">
          <button className="quiet" disabled={treeBusy} onClick={() => setTreeControl(null)}>Cancel</button>
          <button className="primary" disabled={treeBusy || !treeSlug || (!server.configured && (!serverOrigin || !ownerToken))} onClick={() => void promoteTree()}>{treeBusy ? "Creating…" : "Create URL and sync"}</button>
        </div>
      </>}
    </section></div>}
  </div>;
}
