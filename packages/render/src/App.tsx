import { useCallback, useEffect, useState } from "react";
import type { SearchResult, TreeNode } from "@arbor/core";
import { api } from "./api.ts";
import { CollectionView } from "./CollectionView.tsx";
import { PageEditor } from "./PageEditor.tsx";

function pathFromLocation(): string {
  const value = decodeURIComponent(location.pathname.replace(/^\/render/, ""));
  return value || "/";
}

export function App() {
  const [path, setPath] = useState(pathFromLocation);
  const [node, setNode] = useState<TreeNode | null>(null);
  const [sidebar, setSidebar] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const load = useCallback(async (next = path) => {
    try {
      setError(null);
      const loaded = await api.node(next);
      if (loaded.path !== next) {
        history.replaceState({}, "", `/render${loaded.path === "/" ? "/" : loaded.path}`);
        setPath(loaded.path);
      }
      setNode(loaded);
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }, [path]);
  const navigate = useCallback((next: string) => {
    if (next === path) return;
    history.pushState({}, "", `/render${next === "/" ? "/" : next}`);
    setPath(next); setNode(null); setSidebar(null);
  }, [path]);
  useEffect(() => { load(); }, [path]);
  const sidebarPath = node && (node.kind === "directory" || node.kind === "collection")
    ? node.path
    : path.slice(0, path.lastIndexOf("/")) || "/";
  useEffect(() => { api.node(sidebarPath).then(setSidebar).catch(() => setSidebar(null)); }, [sidebarPath, node?.revision]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") { event.preventDefault(); setSearchOpen(true); }
      if (event.key === "Escape") setSearchOpen(false);
    };
    addEventListener("keydown", listener, true); addEventListener("popstate", () => setPath(pathFromLocation()));
    return () => removeEventListener("keydown", listener, true);
  }, []);
  useEffect(() => { const timer = setTimeout(() => query ? api.search(query).then(setResults) : setResults([]), 120); return () => clearTimeout(timer); }, [query]);
  return <div className="app">
    <aside>
      <button className="brand" onClick={() => navigate("/")}>Arbor</button>
      <button className="search-button" onClick={() => setSearchOpen(true)}>⌘P Search</button>
      <div className="sidebar-path">{sidebarPath}</div>
      <nav>
        {sidebarPath !== "/" && <button className="nav-up" onClick={() => navigate(sidebarPath.slice(0, sidebarPath.lastIndexOf("/")) || "/")}><span>↑</span>Parent directory</button>}
        {sidebar?.children?.map((child) => <button className={child.path === path ? "active" : ""} key={child.path} onClick={() => navigate(child.path)}><span>{child.kind === "directory" || child.kind === "collection" ? "▸" : "·"}</span>{child.name}{child.materialization === "placeholder" && <small>offline</small>}</button>)}
      </nav>
    </aside>
    <main>
      <header><div className="breadcrumbs">{path.split("/").filter(Boolean).map((part, index, parts) => <button key={index} onClick={() => navigate(`/${parts.slice(0, index + 1).join("/")}`)}>{part}</button>)}</div>{node && <span className="kind">{node.kind}{node.collection ? ` · ${node.collection.backing}` : ""}</span>}</header>
      {error ? <div className="empty error">{error}</div> : !node ? <div className="empty">Loading…</div> : <>
        {node.diagnostics.map((item) => <div className="diagnostic node-diagnostic" key={`${item.code}:${item.path}`}>{item.message}</div>)}
        {(node.kind === "markdown" || node.kind === "directory" || node.kind === "collection") && node.document && <PageEditor node={node} onSaved={setNode} navigate={navigate} onDeleted={() => navigate(path.slice(0, path.lastIndexOf("/")) || "/")} />}
        {node.kind === "collection" && <CollectionView node={node} navigate={navigate} refresh={() => load(path)} />}
      </>}
    </main>
    {searchOpen && <div className="modal-backdrop" onMouseDown={() => setSearchOpen(false)}><div className="search-modal" onMouseDown={(event) => event.stopPropagation()}><input autoFocus placeholder="Search paths and contents" value={query} onChange={(event) => setQuery(event.target.value)} />{results.map((result) => <button key={result.path} onClick={() => { navigate(result.path); setSearchOpen(false); }}><strong>{result.title}</strong><small>{result.path}</small><span dangerouslySetInnerHTML={{ __html: result.excerpt }} /></button>)}</div></div>}
  </div>;
}
