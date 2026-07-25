import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchResult, TreeChild, TreeNode } from "@arbor/core";
import { canonicalNodePath } from "@arbor/core/logical-path";
import { api } from "./api.ts";
import { CollectionView } from "./CollectionView.tsx";
import { PageEditor } from "./PageEditor.tsx";

const SIDEBAR_STORAGE_KEY = "arbor.sidebar.collapsed";

type SidebarMenuMode = "createDirectory" | "createMarkdown" | "rename" | null;

interface SidebarMenuState {
  x: number;
  y: number;
  target: TreeChild | null;
  mode: SidebarMenuMode;
  value: string;
}

function pathFromLocation(): string {
  const value = decodeURIComponent(location.pathname.replace(/^\/render/, ""));
  return value || "/";
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function childPath(parent: string, name: string): string {
  return canonicalNodePath(`${parent === "/" ? "" : parent}/${name}`);
}

function isDirectoryNode(node: TreeNode): boolean {
  return node.kind === "directory" || node.kind === "collection";
}

function storedSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function App() {
  const [path, setPath] = useState(pathFromLocation);
  const [node, setNode] = useState<TreeNode | null>(null);
  const [sidebar, setSidebar] = useState<TreeNode | null>(null);
  const [sidebarMenu, setSidebarMenu] = useState<SidebarMenuState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(storedSidebarCollapsed);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const nodeRequest = useRef(0);
  const sidebarRequest = useRef(0);
  const load = useCallback(async (next: string) => {
    const request = ++nodeRequest.current;
    try {
      setError(null);
      const loaded = await api.node(next);
      if (request !== nodeRequest.current) return;
      if (loaded.path !== next) {
        history.replaceState({}, "", `/render${loaded.path === "/" ? "/" : loaded.path}`);
        setPath(loaded.path);
      }
      setNode(loaded);
    }
    catch (error) {
      if (request === nodeRequest.current) setError(error instanceof Error ? error.message : String(error));
    }
  }, []);
  const navigate = useCallback((next: string) => {
    setMobileSidebarOpen(false);
    if (next === path) return;
    nodeRequest.current += 1;
    sidebarRequest.current += 1;
    history.pushState({}, "", `/render${next === "/" ? "/" : next}`);
    setPath(next); setNode(null);
  }, [path]);
  useEffect(() => {
    if (node?.path === path) return;
    void load(path);
    return () => { nodeRequest.current += 1; };
  }, [load, node?.path, path]);
  const sidebarPath = node && isDirectoryNode(node)
    ? node.path
    : parentPath(path);
  const refreshSidebar = useCallback(async () => {
    const request = ++sidebarRequest.current;
    try {
      const loaded = await api.node(sidebarPath);
      if (request === sidebarRequest.current) setSidebar(loaded);
    }
    catch {
      if (request === sidebarRequest.current) setSidebar(null);
    }
  }, [sidebarPath]);
  useEffect(() => {
    if (!node) return;
    if (isDirectoryNode(node)) {
      sidebarRequest.current += 1;
      setSidebar((current) => current === node ? current : node);
      return;
    }
    if (sidebar?.path === sidebarPath) return;
    const request = ++sidebarRequest.current;
    api.node(sidebarPath).then(
      (loaded) => { if (request === sidebarRequest.current) setSidebar(loaded); },
      () => { if (request === sidebarRequest.current) setSidebar(null); },
    );
    return () => {
      if (request === sidebarRequest.current) sidebarRequest.current += 1;
    };
  }, [node, sidebar?.path, sidebarPath]);
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
    addEventListener("keydown", listener, true); addEventListener("popstate", () => setPath(pathFromLocation()));
    return () => removeEventListener("keydown", listener, true);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
    } catch {}
  }, [sidebarCollapsed]);
  useEffect(() => { const timer = setTimeout(() => query ? api.search(query).then(setResults) : setResults([]), 120); return () => clearTimeout(timer); }, [query]);

  const openSidebarMenu = useCallback((event: React.MouseEvent, target: TreeChild | null) => {
    event.preventDefault();
    event.stopPropagation();
    setSidebarMenu({ x: event.clientX, y: event.clientY, target, mode: null, value: "" });
  }, []);

  const submitSidebarName = useCallback(async () => {
    if (!sidebarMenu?.mode) return;
    const name = sidebarMenu.value.trim();
    if (!name) return;
    try {
      setError(null);
      if (sidebarMenu.mode === "rename" && sidebarMenu.target) {
        const oldPath = sidebarMenu.target.path;
        const nextPath = childPath(parentPath(oldPath), name);
        await api.mutate({ operations: [{ op: "rename", path: oldPath, name }] });
        setSidebarMenu(null);
        if (path === oldPath || path.startsWith(`${oldPath}/`)) {
          navigate(`${nextPath}${path.slice(oldPath.length)}`);
        } else {
          await refreshSidebar();
        }
        return;
      }
      const destination = sidebarMenu.target?.kind === "directory" || sidebarMenu.target?.kind === "collection"
        ? sidebarMenu.target.path
        : sidebarPath;
      const createdPath = childPath(destination, name);
      const operation = sidebarMenu.mode === "createDirectory"
        ? { op: "createDirectory" as const, path: createdPath }
        : { op: "createMarkdown" as const, path: createdPath };
      await api.mutate({ operations: [operation] });
      setSidebarMenu(null);
      if (destination === sidebarPath) await refreshSidebar();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [navigate, path, refreshSidebar, sidebarMenu, sidebarPath]);

  const trashSidebarTarget = useCallback(async () => {
    const target = sidebarMenu?.target;
    if (!target || !confirm(`Move ${target.name} to Trash?`)) return;
    try {
      setError(null);
      await api.mutate({ operations: [{ op: "trash", paths: [target.path] }] });
      setSidebarMenu(null);
      if (path === target.path || path.startsWith(`${target.path}/`)) navigate(parentPath(target.path));
      else await refreshSidebar();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [navigate, path, refreshSidebar, sidebarMenu]);

  const toggleSidebar = () => {
    if (matchMedia("(max-width: 760px)").matches) setMobileSidebarOpen((value) => !value);
    else setSidebarCollapsed((value) => !value);
  };

  return <div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}${mobileSidebarOpen ? " mobile-sidebar-open" : ""}`}>
    <button className="sidebar-backdrop" aria-label="Close workspace sidebar" onClick={() => setMobileSidebarOpen(false)} />
    <aside className="workspace-sidebar" id="workspace-sidebar">
      <div className="sidebar-heading">
        <button className="brand" onClick={() => navigate("/")}>Arbor</button>
        <button className="sidebar-close" aria-label="Collapse workspace sidebar" title="Collapse sidebar (⌘\\)" onClick={toggleSidebar}>
          <svg aria-hidden="true" viewBox="0 0 22 22">
            <path d="m13.5 5.5-5.5 5.5 5.5 5.5" />
          </svg>
        </button>
      </div>
      <button className="search-button" onClick={() => setSearchOpen(true)}>⌘P Search</button>
      <div className="sidebar-path">{sidebarPath}</div>
      <nav aria-label="Workspace files" onContextMenu={(event) => {
        if (event.target === event.currentTarget) openSidebarMenu(event, null);
      }}>
        {sidebarPath !== "/" && <button className="nav-up" onClick={() => navigate(sidebarPath.slice(0, sidebarPath.lastIndexOf("/")) || "/")}><span>↑</span>Parent directory</button>}
        {sidebar?.children?.map((child) => <button
          className={child.path === path ? "active" : ""}
          key={child.path}
          onClick={() => navigate(child.path)}
          onContextMenu={(event) => openSidebarMenu(event, child)}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            setSidebarMenu({ x: bounds.left + 20, y: bounds.bottom, target: child, mode: null, value: "" });
          }}
        ><span>{child.kind === "directory" || child.kind === "collection" ? "▸" : "·"}</span>{child.name}{child.materialization === "placeholder" && <small>offline</small>}</button>)}
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
          <div className="breadcrumbs">{path.split("/").filter(Boolean).map((part, index, parts) => <button key={index} onClick={() => navigate(`/${parts.slice(0, index + 1).join("/")}`)}>{part}</button>)}</div>
        </div>
        {node && <span className="kind">
          {node.document && (node.kind === "markdown" || node.kind === "directory" || node.kind === "collection") ? "ArborNote · " : ""}
          {node.kind}{node.collection ? ` · ${node.collection.backing}` : ""}
        </span>}
      </header>
      {error ? <div className="empty error">{error}</div> : !node ? <div className="empty">Loading…</div> : <>
        {node.diagnostics.map((item) => <div className="diagnostic node-diagnostic" key={`${item.code}:${item.path}`}>{item.message}</div>)}
        {(node.kind === "markdown" || node.kind === "directory" || node.kind === "collection") && node.document && <PageEditor node={node} onSaved={setNode} navigate={navigate} />}
        {node.kind === "collection" && <CollectionView node={node} navigate={navigate} refresh={() => load(path)} />}
      </>}
    </main>
    {sidebarMenu && <div
      className="sidebar-context-menu"
      role="menu"
      aria-label={sidebarMenu.target ? `Actions for ${sidebarMenu.target.name}` : `Actions in ${sidebarPath}`}
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
    {searchOpen && <div className="modal-backdrop" onMouseDown={() => setSearchOpen(false)}><div className="search-modal" onMouseDown={(event) => event.stopPropagation()}><input autoFocus placeholder="Search paths and contents" value={query} onChange={(event) => setQuery(event.target.value)} />{results.map((result) => <button key={result.path} onClick={() => { navigate(result.path); setSearchOpen(false); }}><strong>{result.title}</strong><small>{result.path}</small><span dangerouslySetInnerHTML={{ __html: result.excerpt }} /></button>)}</div></div>}
  </div>;
}
