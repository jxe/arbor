import { useEffect, useMemo, useRef, useState } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import type { ArborBlock, TreeNode } from "@arbor/core";
import { canonicalNodePath } from "@arbor/core/logical-path";
import { mergeBlocks } from "@arbor/editor";
import { api } from "./api.ts";
import { arborSchema, blockText, fromBlockNote, originalMap, toBlockNote, type ArborEditorBlock } from "./blocks.tsx";

export function PageEditor({ node, onSaved, onDeleted, navigate }: { node: TreeNode; onSaved: (node: TreeNode) => void; onDeleted: () => void; navigate: (path: string) => void }) {
  const authored = node.document?.blocks ?? [];
  const implicitChildren: ArborBlock[] = node.kind === "directory" || node.kind === "collection"
    ? (node.children ?? []).filter((child) => !authored.some((block) => block.type === "childPage" && canonicalNodePath(String(block.props?.path ?? "")) === child.path)).map((child, index) => ({
      id: `implicit-${index}-${child.name}`,
      type: "childPage",
      content: child.name,
      props: { path: child.path },
      children: [],
    }))
    : [];
  const initial = [...authored, ...implicitChildren];
  const originals = useMemo(() => originalMap(initial), [node.revision]);
  const pageDirectory = node.kind === "directory" || node.kind === "collection" ? node.path : node.path.slice(0, node.path.lastIndexOf("/")) || "/";
  const editor = useCreateBlockNote({
    schema: arborSchema,
    initialContent: initial.length ? initial.map(toBlockNote) : [{ type: "paragraph" }],
    uploadFile: async (file) => (await api.asset(pageDirectory, file)).markdownPath,
  }, [node.path, node.revision]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>({ ...(node.document?.frontmatter ?? {}) });
  const [recovery, setRecovery] = useState<Array<{ hash: string; markdown: string; status: string; changedAt: number }> | null>(null);
  const baseBlocks = useRef(authored);

  useEffect(() => {
    const source = new EventSource("/v/events");
    source.onmessage = () => {};
    source.addEventListener("updated", async (event) => {
      const update = JSON.parse((event as MessageEvent).data) as { path: string; classification?: string };
      if (update.path !== node.path || update.classification === "echo" || dirty) return;
      onSaved(await api.node(node.path));
    });
    return () => source.close();
  }, [node.path, dirty, onSaved]);

  const currentBlocks = () => editor.document.map((block) => fromBlockNote(block as ArborEditorBlock, originals));
  const patch = () => {
    const result: Record<string, unknown | null> = {};
    const before = node.document?.frontmatter ?? {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(frontmatter)])) {
      if (!(key in frontmatter)) result[key] = null;
      else if (JSON.stringify(before[key]) !== JSON.stringify(frontmatter[key])) result[key] = frontmatter[key];
    }
    return result;
  };

  const save = async (forceRevision?: string) => {
    setSaving(true); setMessage(null);
    const local = currentBlocks();
    try {
      const saved = await api.write(node.path, { baseRevision: forceRevision ?? node.revision, frontmatterPatch: patch(), blocks: local });
      setDirty(false); baseBlocks.current = saved.document?.blocks ?? [];
      onSaved(saved);
    } catch (error) {
      const conflict = error as Error & { status?: number; payload?: { current?: TreeNode } };
      if (conflict.status === 409 && conflict.payload?.current?.document) {
        const current = conflict.payload.current;
        const merged = mergeBlocks(baseBlocks.current, local, current.document!.blocks);
        if (!merged.conflicts.length) {
          const saved = await api.write(node.path, { baseRevision: current.revision, frontmatterPatch: patch(), blocks: merged.blocks });
          setDirty(false); onSaved(saved); setMessage("Merged an external edit.");
        } else {
          setMessage(`${merged.conflicts.length} block conflict${merged.conflicts.length === 1 ? "" : "s"}. Reload the disk version or keep your local version.`);
        }
      } else setMessage(conflict.message);
    } finally { setSaving(false); }
  };

  const keys = Object.keys(frontmatter);
  const openInternalLink = (event: React.MouseEvent) => {
    const anchor = (event.target as Element).closest("a");
    const href = anchor?.getAttribute("href");
    if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    event.preventDefault();
    const base = node.kind === "directory" || node.kind === "collection"
      ? `${node.path === "/" ? "" : node.path}/`
      : `${node.path.slice(0, node.path.lastIndexOf("/")) || ""}/`;
    const resolved = new URL(href.split("#")[0]!, `http://arbor${base}`).pathname;
    navigate(canonicalNodePath(resolved));
  };
  return <div className="editor-shell">
    <div className="properties">
      <div className="properties-heading">Properties</div>
      {keys.map((key) => <label key={key}><span>{key}</span><input value={String(frontmatter[key] ?? "")} disabled={key === "id"} onChange={(event) => { setFrontmatter({ ...frontmatter, [key]: event.target.value }); setDirty(true); }} /></label>)}
      <button className="quiet" onClick={() => { const key = prompt("Property name"); if (key) { setFrontmatter({ ...frontmatter, [key]: "" }); setDirty(true); } }}>+ property</button>
    </div>
    <div onClickCapture={openInternalLink}><BlockNoteView editor={editor} onChange={() => {
      const shorthand = editor.document.find((block) => block.type === "paragraph" && blockText(block as ArborEditorBlock).startsWith("▸ ")) as ArborEditorBlock | undefined;
      if (shorthand) editor.updateBlock(shorthand, { type: "toggleListItem", content: blockText(shorthand).slice(2) });
      setDirty(true);
    }} data-theming-css-variables-demo /></div>
    <div className="editor-actions">
      {message && <span className="warning">{message}</span>}
      {message?.includes("conflict") && <button onClick={async () => onSaved(await api.node(node.path))}>Use disk</button>}
      {message?.includes("conflict") && <button onClick={async () => save((await api.node(node.path)).revision)}>Keep mine</button>}
      <button className="quiet" onClick={async () => setRecovery(await api.recovery(node.path))}>Recover</button>
      {node.path !== "/" && <button className="quiet danger" onClick={async () => { if (confirm(`Move ${node.name} to Trash?`)) { await api.trash(node.path); onDeleted(); } }}>Trash</button>}
      <button disabled={!dirty || saving} onClick={() => save()}>{saving ? "Saving…" : dirty ? "Save" : "Saved"}</button>
    </div>
    {recovery && <div className="recovery"><div className="recovery-title"><strong>Recover blocks</strong><button className="quiet" onClick={() => setRecovery(null)}>Close</button></div>{!recovery.length && <p>Nothing recoverable for this page.</p>}{recovery.map((entry) => <div className="recovery-entry" key={entry.hash}><div><span>{entry.status}</span><pre>{entry.markdown}</pre></div><button onClick={async () => { onSaved(await api.restoreBlock(node.path, entry.hash)); setRecovery(await api.recovery(node.path)); }}>Restore</button></div>)}</div>}
  </div>;
}
