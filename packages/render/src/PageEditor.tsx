import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ellipsis } from "lucide-react";
import { BlockNoteEditor, getNodeId } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { filterSuggestionItems, SideMenuExtension } from "@blocknote/core/extensions";
import { TextSelection } from "@tiptap/pm/state";
import { FormattingToolbarController, SideMenuController, SuggestionMenuController } from "@blocknote/react";
import type { ArborBlock, BacklinkEntry, NodeSummary, RecoveryEntry } from "@arbor/core";
import type {
  NodeRef,
  NodeSnapshot,
  ObservedNodeUpdate,
  StructuralWorkspaceOperation,
} from "@arbor/client";
import { canonicalNodePath } from "@arbor/core/logical-path";
import { legacyPageIDCandidate, resolveLogicalURL } from "@arbor/core/logical-url";
import { pageIDFromStableKey, pageIDStableKey } from "@arbor/core/node-key";
import { placeDirectoryChildren, reorderChildLinks, resolveChildLinkPath, serializeMarkdown } from "@arbor/editor";
import { api, type BrowserMutationResult } from "./api.ts";
import {
  EditorCoordinator,
  frontmatterPatch,
  type DocumentSnapshot,
  type HistoryEntry,
} from "./editor-coordinator.ts";
import { importEntries } from "./file-drop.ts";
import { hasChildren, nodeDocument, presentationKind } from "./node-presentation.ts";
import {
  arborSchema,
  arborEditorExtensions,
  ArborFormattingToolbar,
  ArborSideMenu,
  fromBlockNote,
  getArborSlashMenuItems,
  ManagedRowsContext,
  originalMap,
  toBlockNote,
  type ArborEditorBlock,
  type ManagedRowsController,
} from "./blocks.tsx";

const ARBOR_DRAG_TYPE = "application/x-arbor-logical-paths";
const PROFILE_HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function communityArborOrigin(canonical: string | undefined): string | null {
  if (!canonical) return null;
  try {
    const value = new URL(canonical);
    return value.protocol === "arbor:" && value.hostname !== "tree" ? `arbor://${value.host}` : null;
  } catch {
    return null;
  }
}

function normalizeMemberLocator(input: string, communityOrigin: string | null): string | null {
  const value = input.trim();
  const handle = value.startsWith("~") ? value.slice(1) : value;
  if (communityOrigin && PROFILE_HANDLE.test(handle)) return `${communityOrigin}/~${handle}`;
  try {
    const locator = new URL(value);
    const match = /^\/~([a-z0-9][a-z0-9-]{0,62})\/?$/.exec(locator.pathname);
    if (locator.protocol !== "arbor:" || locator.hostname === "tree" || !match) return null;
    return `arbor://${locator.host}/~${match[1]}`;
  } catch {
    return null;
  }
}

function memberLabel(locator: string, communityOrigin: string | null): string {
  return communityOrigin && locator.startsWith(`${communityOrigin}/~`)
    ? locator.slice(communityOrigin.length + 1)
    : locator;
}

function StringListProperty({
  property,
  values,
  onChange,
  communityOrigin,
  communityMembers,
}: {
  property: string;
  values: string[];
  onChange: (values: string[]) => void;
  communityOrigin: string | null;
  communityMembers: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const members = property === "members";
  const normalizedDraft = members ? normalizeMemberLocator(draft, communityOrigin) : draft.trim() || null;
  const duplicate = normalizedDraft !== null && values.includes(normalizedDraft);
  const addLabel = communityMembers ? "Add person" : members ? "Add member" : "Add item";
  const commit = () => {
    if (!normalizedDraft || duplicate) return;
    onChange([...values, normalizedDraft]);
    setDraft("");
    setAdding(false);
  };
  return <div className="property-list-row">
    <span className="property-name">{property}</span>
    <div className="property-list">
      {values.map((value, index) => <div className="property-list-item" key={index}>
        {members
          ? <code>{memberLabel(value, communityOrigin)}</code>
          : <input aria-label={`${property} item ${index + 1}`} value={value} onChange={(event) => {
              const next = [...values];
              next[index] = event.target.value;
              onChange(next);
            }} />}
        <button className="quiet property-list-remove" aria-label={`Remove ${members ? "member" : "item"} ${memberLabel(value, communityOrigin)}`} onClick={() => {
          if (members && !confirm(communityMembers
            ? `Remove ${memberLabel(value, communityOrigin)}? Removing a person from this community disables that account.`
            : `Remove ${memberLabel(value, communityOrigin)} from this group?`)) return;
          onChange(values.filter((_, itemIndex) => itemIndex !== index));
        }}>Remove</button>
      </div>)}
      {adding ? <div className="property-list-add">
        <input
          autoFocus
          aria-label={members ? "Person handle or profile" : `New ${property} item`}
          placeholder={members ? "~alice" : "Value"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); commit(); }
            if (event.key === "Escape") { setAdding(false); setDraft(""); }
          }}
        />
        <button className="quiet" disabled={!normalizedDraft || duplicate} onClick={commit}>Add</button>
        <button className="quiet" onClick={() => { setAdding(false); setDraft(""); }}>Cancel</button>
        {duplicate && <small>This person is already listed.</small>}
        {members && draft.trim() && !normalizedDraft && <small>Use a handle such as ~alice or a complete arbor:// profile address.</small>}
      </div> : <button className="quiet property-list-add-button" onClick={() => setAdding(true)}>+ {addLabel}</button>}
      {communityMembers && <small>Adding a person reserves their profile address. The first successful claim wins.</small>}
    </div>
  </div>;
}

interface TextSelectionPoint {
  textblockIndex: number;
  offset: number;
}

function captureTextSelectionPoint(document: any, position: number): TextSelectionPoint | null {
  let textblockIndex = 0;
  let result: TextSelectionPoint | null = null;
  document.descendants((node: any, nodePosition: number) => {
    if (result !== null) return false;
    if (!node.isTextblock) return true;
    const start = nodePosition + 1;
    const end = start + node.content.size;
    if (position >= start && position <= end) {
      result = { textblockIndex, offset: position - start };
      return false;
    }
    textblockIndex += 1;
    return false;
  });
  return result;
}

function resolveTextSelectionPoint(document: any, point: TextSelectionPoint): number | null {
  let textblockIndex = 0;
  let result: number | null = null;
  document.descendants((node: any, nodePosition: number) => {
    if (result !== null) return false;
    if (!node.isTextblock) return true;
    if (textblockIndex === point.textblockIndex) {
      result = nodePosition + 1 + Math.min(point.offset, node.content.size);
      return false;
    }
    textblockIndex += 1;
    return false;
  });
  return result;
}

interface FootnoteLayout {
  mode: "margin" | "endnotes";
  css: string;
}

function layoutFootnotes(surface: HTMLElement): FootnoteLayout {
  const editorElement = surface.querySelector<HTMLElement>(".bn-editor");
  if (!editorElement) return { mode: "endnotes", css: "" };
  const definitions = [...surface.querySelectorAll<HTMLElement>(".footnote-definition")].map((definition) => ({
    definition,
    outer: definition.closest<HTMLElement>(".bn-block-outer"),
    label: definition.dataset.footnoteLabel ?? "",
    blockID: definition.dataset.footnoteBlock ?? "",
  })).filter((item): item is { definition: HTMLElement; outer: HTMLElement; label: string; blockID: string } =>
    Boolean(item.outer && item.blockID)
  );
  const references = [...surface.querySelectorAll<HTMLElement>(".footnote-reference")];
  const firstReference = new Map<string, HTMLElement>();
  const firstReferenceOrder = new Map<string, number>();
  for (const [index, reference] of references.entries()) {
    const label = reference.dataset.footnoteLabel ?? "";
    if (label && !firstReference.has(label)) {
      firstReference.set(label, reference);
      firstReferenceOrder.set(label, index);
    }
  }

  if (!definitions.length) return { mode: "endnotes", css: "" };

  const editorRect = editorElement.getBoundingClientRect();
  const workspaceRight = surface.closest(".workspace-main")?.getBoundingClientRect().right ?? window.innerWidth;
  const available = workspaceRight - editorRect.right - 24;
  const marginWidth = Math.min(264, available - 20);
  const referenced = definitions.filter((item) => firstReference.has(item.label));
  const orphans = definitions.filter((item) => !firstReference.has(item.label));
  const useMargin = editorRect.width >= 600 && marginWidth >= 210 && referenced.length > 0;

  if (!useMargin) {
    const ordered = referenced.map((item) => ({
      ...item,
      reference: firstReference.get(item.label)!,
      height: item.outer.getBoundingClientRect().height,
    })).sort((left, right) =>
      firstReferenceOrder.get(left.label)! - firstReferenceOrder.get(right.label)!
    );
    const definitionOuters = new Set(definitions.map((item) => item.outer));
    const contentBottom = [...surface.querySelectorAll<HTMLElement>(".bn-block-outer")]
      .filter((outer) => ![...definitionOuters].some((definition) =>
        definition === outer || definition.contains(outer)
      ))
      .reduce((bottom, outer) => Math.max(bottom, outer.getBoundingClientRect().bottom - editorRect.top), 0);
    let nextTop = contentBottom + 30;
    const endnoteRules: string[] = [];
    for (const item of [...ordered, ...orphans.map((orphan) => ({
      ...orphan,
      height: orphan.outer.getBoundingClientRect().height,
    }))]) {
      endnoteRules.push(
        `.body-drop-surface[data-footnote-layout="endnotes"] .bn-block-outer:has(.footnote-definition[data-footnote-block="${item.blockID}"]){--arbor-footnote-top:${nextTop}px}`,
      );
      nextTop += item.height + 8;
    }
    const first = ordered[0] ?? orphans[0]!;
    endnoteRules.push(
      `.body-drop-surface[data-footnote-layout="endnotes"] .bn-editor{min-height:${nextTop + 18}px}`,
      `.body-drop-surface[data-footnote-layout="endnotes"] .bn-block-outer:has(.footnote-definition[data-footnote-block="${first.blockID}"]){padding-top:17px;border-top:1px solid var(--arbor-divider)}`,
    );
    return {
      mode: "endnotes",
      css: endnoteRules.join(""),
    };
  }

  const ordered = referenced.map((item) => ({
    ...item,
    reference: firstReference.get(item.label)!,
    height: item.outer.getBoundingClientRect().height,
  })).sort((left, right) =>
    firstReferenceOrder.get(left.label)! - firstReferenceOrder.get(right.label)!
  );
  let nextTop = 0;
  const rules: string[] = [];
  for (const item of ordered) {
    const desiredTop = item.reference.getBoundingClientRect().top - editorRect.top - 3;
    const top = Math.max(0, desiredTop, nextTop);
    nextTop = top + item.height + 14;
    rules.push(
      `.body-drop-surface[data-footnote-layout="margin"] .bn-block-outer:has(.footnote-definition[data-footnote-block="${item.blockID}"]){--arbor-footnote-top:${top}px;--arbor-footnote-width:${marginWidth}px}`,
    );
  }
  if (orphans[0]) {
    rules.push(
      `.body-drop-surface[data-footnote-layout="margin"] .bn-block-outer:has(.footnote-definition[data-footnote-block="${orphans[0].blockID}"]){margin-top:30px!important;padding-top:17px;border-top:1px solid var(--arbor-divider)}`,
    );
  }
  return { mode: "margin", css: rules.join("") };
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function childPath(parent: string, name: string): string {
  return canonicalNodePath(`${parent === "/" ? "" : parent}/${name}`);
}

function importedTopLevel(destination: string, entries: Array<{ path: string }>): string[] {
  return [...new Set(entries.map((entry) => entry.path.split("/")[0]).filter(Boolean).map((name) => childPath(destination, name!)))];
}

function trashedPath(path: string): string {
  return canonicalNodePath(`/Trash${path}`);
}

interface ChildDocumentRow {
  blockID: string;
  ref: NodeRef;
  kind: string;
  materialization: string;
}

function childDocumentRows(directory: string, blocks: readonly ArborBlock[], children: readonly NodeSummary[]): ChildDocumentRow[] {
  const childByPath = new Map(children.map((child) => [canonicalNodePath(child.ref.path), child]));
  const childByPageID = new Map(children.flatMap((child) => {
    const pageID = pageIDFromStableKey(child.ref.stableKey);
    return pageID ? [[pageID, child] as const] : [];
  }));
  const matched = new Set<NodeSummary>();
  const rows: ChildDocumentRow[] = [];
  const walk = (items: readonly ArborBlock[]): void => {
    for (const block of items) {
      if (block.type === "standaloneLink") {
        const link = resolveLogicalURL(directory, String(block.props?.path ?? ""));
        const pageID = link ? legacyPageIDCandidate(link) : null;
        const child = link?.kind === "local"
          ? (pageID && childByPageID.get(pageID)) || childByPath.get(link.path)
          : undefined;
        if (child && !matched.has(child)) {
          matched.add(child);
          rows.push({
            blockID: block.id,
            ref: child.ref,
            kind: presentationKind(child),
            materialization: child.materialization,
          });
        }
      }
      walk(block.children);
    }
  };
  walk(blocks);
  return rows;
}

function inverseMoves(moved: BrowserMutationResult["moved"], tree: string): StructuralWorkspaceOperation[] {
  const byParent = new Map<string, string[]>();
  for (const item of moved) {
    const paths = byParent.get(parentPath(item.from)) ?? [];
    paths.push(item.to);
    byParent.set(parentPath(item.from), paths);
  }
  return [...byParent].map(([destination, paths]) => ({
    op: "move",
    refs: paths.map((path) => ({ tree, path, stableKey: null })),
    destination: { tree, path: destination, stableKey: null },
  }));
}

export function PageEditor({ node, children, updates, pageActionsHost, onSaved, onChildrenChanged, navigate }: {
  node: NodeSnapshot;
  children: NodeSummary[];
  updates: AsyncIterable<ObservedNodeUpdate>;
  pageActionsHost: HTMLDivElement | null;
  onSaved: (node: NodeSnapshot) => void;
  onChildrenChanged: (children: NodeSummary[]) => void;
  navigate: (target: string | NodeRef) => void;
}) {
  const markdownDocument = useMemo(() => nodeDocument(node), [node.capabilities.content?.revision, node.content?.source]);
  const authored = markdownDocument?.blocks ?? [];
  const isDirectory = hasChildren(node);
  const physicalChildren = children;
  const childrenRevision = physicalChildren.map((child) => `${child.ref.path}:${presentationKind(child)}:${child.materialization}`).join("\0");
  const childrenByPath = useMemo(() => new Map(physicalChildren.map((child) => [child.ref.path, child])), [childrenRevision]);
  const placedDocument = useMemo(() => markdownDocument && isDirectory
    ? placeDirectoryChildren(node.ref.path, markdownDocument, physicalChildren.map((child) => ({
      name: child.name,
      path: child.ref.path,
      stableKey: child.ref.stableKey,
    }))).document
    : markdownDocument,
  [node.capabilities.content?.revision, childrenRevision, isDirectory]);
  const initial = placedDocument?.blocks ?? authored;
  const childRows = useMemo(
    () => childDocumentRows(node.ref.path, initial, physicalChildren),
    [node.capabilities.content?.revision, childrenRevision],
  );
  const managedOrder = childRows.map((row) => row.ref.path);
  const originals = useMemo(() => originalMap(initial), [node.capabilities.content?.revision, childrenRevision]);
  const pageDirectory = isDirectory ? node.ref.path : parentPath(node.ref.path);
  const pageDirectoryRef = useRef(pageDirectory);
  pageDirectoryRef.current = pageDirectory;
  // Every reference this editor issues stays in the node's tree scope, so
  // an in-flight save never follows a navigation into another root.
  const sapi = useMemo(() => api.scoped(node.ref.tree), [node.ref.tree]);
  const sapiRef = useRef(sapi);
  sapiRef.current = sapi;
  const nodeReference: NodeRef = node.ref;
  const nodeIdentity = useRef(node.ref.stableKey ?? node.ref.path).current;
  const blockDropPosition = useRef<{ pos: number; orientation: string } | null>(null);
  const editor = useMemo(() => {
    const instance = BlockNoteEditor.create({
      schema: arborSchema,
      initialContent: [{ type: "paragraph" }],
      extensions: arborEditorExtensions,
      dropCursor: {
        hooks: {
          computeDropPosition: ({ defaultPosition }) => {
            blockDropPosition.current = defaultPosition;
            return defaultPosition;
          },
        },
      },
      uploadFile: async (file) => (await sapiRef.current.asset(pageDirectoryRef.current, file)).markdownPath,
    });
    instance.transact((transaction) => {
      transaction.setMeta("addToHistory", false);
      instance.replaceBlocks(
        instance.document,
        initial.length ? initial.map((block) => toBlockNote(block, instance)) : [{ type: "paragraph" }],
      );
    });
    (window as any).ProseMirror = instance._tiptapEditor;
    return instance;
  }, [nodeIdentity]);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const [, renderCoordinator] = useState(0);
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>({ ...(markdownDocument?.frontmatter ?? {}) });
  const [backlinks, setBacklinks] = useState<BacklinkEntry[]>([]);
  const [recovery, setRecovery] = useState<RecoveryEntry[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [creating, setCreating] = useState<"directory" | "markdown" | null>(null);
  const [createValue, setCreateValue] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragPreview, setDragPreview] = useState<{ paths: string[]; x: number; y: number } | null>(null);
  const [footnoteLayout, setFootnoteLayout] = useState<FootnoteLayout>({ mode: "endnotes", css: "" });
  const bodySurface = useRef<HTMLDivElement>(null);
  const pageActionsMenu = useRef<HTMLDetailsElement>(null);
  const pendingScrollRestore = useRef<{ x: number; y: number } | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onSavedPreservingScroll = useCallback((loaded: NodeSnapshot) => {
    pendingScrollRestore.current = { x: window.scrollX, y: window.scrollY };
    onSaved(loaded);
  }, [onSaved]);

  useEffect(() => {
    let cancelled = false;
    if (node.ref.tree === "local") {
      setBacklinks([]);
      return;
    }
    sapiRef.current.backlinks(nodeReference).then(
      (entries) => { if (!cancelled) setBacklinks(entries); },
      () => { if (!cancelled) setBacklinks([]); },
    );
    return () => { cancelled = true; };
  }, [node.ref.path, node.ref.stableKey, node.ref.tree]);

  useLayoutEffect(() => {
    const target = pendingScrollRestore.current;
    if (!target) return;
    pendingScrollRestore.current = null;
    let secondFrame = 0;
    window.scrollTo(target.x, target.y);
    const firstFrame = requestAnimationFrame(() => {
      window.scrollTo(target.x, target.y);
      secondFrame = requestAnimationFrame(() => window.scrollTo(target.x, target.y));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [node.ref.path, node.capabilities.content?.revision, childrenRevision]);

  useEffect(() => {
    setSelected(new Set());
    setSelectionAnchor(null);
    setCreating(null);
    setRenamingPath(null);
  }, [node.ref.path]);

  const currentBlocks = () => editor.document.map((block) => fromBlockNote(block as ArborEditorBlock, originals, editor));
  const snapshot = (nextFrontmatter = frontmatter): DocumentSnapshot => ({
    blocks: currentBlocks(),
    frontmatter: structuredClone(nextFrontmatter),
  });
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const replaceEditorSnapshot = useCallback((value: DocumentSnapshot) => {
    editor.transact((transaction) => {
      const anchor = captureTextSelectionPoint(transaction.doc, transaction.selection.anchor);
      const head = captureTextSelectionPoint(transaction.doc, transaction.selection.head);
      transaction.setMeta("addToHistory", false);
      editor.replaceBlocks(
        editor.document,
        value.blocks.length ? value.blocks.map((block) => toBlockNote(block, editor)) : [{ type: "paragraph" }],
      );
      if (anchor && head) {
        const nextAnchor = resolveTextSelectionPoint(transaction.doc, anchor);
        const nextHead = resolveTextSelectionPoint(transaction.doc, head);
        if (nextAnchor !== null && nextHead !== null) {
          transaction.setSelection(TextSelection.create(transaction.doc, nextAnchor, nextHead));
        }
      }
    });
    setFrontmatter(structuredClone(value.frontmatter));
  }, [editor]);
  const coordinator = useMemo(() => new EditorCoordinator({
    path: node.ref.path,
    revision: node.capabilities.content?.revision!,
    baseBlocks: authored,
    baseFrontmatter: markdownDocument?.frontmatter ?? {},
    initialSnapshot: { blocks: initial, frontmatter: markdownDocument?.frontmatter ?? {} },
    capture: () => snapshotRef.current(),
    write: (_path, baseRevision, value, base) => sapiRef.current.write(nodeReference, {
      baseContentRevision: baseRevision,
      source: serializeMarkdown(markdownDocument!, value.blocks, frontmatterPatch(base.frontmatter, value.frontmatter)),
    }),
    applySnapshot: replaceEditorSnapshot,
    acceptNode: onSavedPreservingScroll,
    notify: () => renderCoordinator((value) => value + 1),
  }), [editor, nodeIdentity]);
  coordinator.configure({
    capture: () => snapshotRef.current(),
    write: (_path, baseRevision, value, base) => sapiRef.current.write(nodeReference, {
      baseContentRevision: baseRevision,
      source: serializeMarkdown(markdownDocument!, value.blocks, frontmatterPatch(base.frontmatter, value.frontmatter)),
    }),
    applySnapshot: replaceEditorSnapshot,
    acceptNode: onSavedPreservingScroll,
    notify: () => renderCoordinator((value) => value + 1),
  });
  const saveState = coordinator.saveState;
  const message = coordinator.message;
  const setMessage = useCallback((value: string | null) => coordinator.setMessage(value), [coordinator]);
  const save = useCallback((forceRevision?: string) => coordinator.save(forceRevision), [coordinator]);
  const flushAutosave = useCallback(() => coordinator.flush(), [coordinator]);
  const flushDocumentHistory = useCallback(() => coordinator.flushHistory(), [coordinator]);
  const recordDocumentSnapshot = useCallback((value: DocumentSnapshot) => coordinator.markAuthored(value), [coordinator]);
  const pushHistory = useCallback((entry: HistoryEntry) => coordinator.pushHistory(entry), [coordinator]);
  const undo = useCallback(() => coordinator.undo(), [coordinator]);
  const redo = useCallback(() => coordinator.redo(), [coordinator]);

  useLayoutEffect(() => {
    coordinator.reconcileServer(node, {
      blocks: initial,
      frontmatter: { ...(markdownDocument?.frontmatter ?? {}) },
    });
  }, [childrenRevision, coordinator, node.capabilities.content?.revision]);

  useEffect(() => () => coordinator.dispose(), [coordinator]);

  useLayoutEffect(() => {
    const surface = bodySurface.current;
    if (!surface) return;
    let frame = 0;
    let mutationObserver: MutationObserver;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = layoutFootnotes(surface);
        setFootnoteLayout((current) => current.mode === next.mode && current.css === next.css ? current : next);
        mutationObserver.takeRecords();
      });
    };
    const stopEditorObserver = editor.onChange(schedule);
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(surface);
    const workspaceMain = surface.closest<HTMLElement>(".workspace-main");
    if (workspaceMain) resizeObserver.observe(workspaceMain);
    mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(surface, {
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", schedule);
    void document.fonts?.ready.then(schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      stopEditorObserver();
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [editor, node.ref.path]);

  const observedNode = useRef(node);
  observedNode.current = node;
  const observedOnSaved = useRef(onSavedPreservingScroll);
  observedOnSaved.current = onSavedPreservingScroll;
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        for await (const update of updates) {
          if (!active) return;
          const currentNode = observedNode.current;
          if (update.kind === "resync") {
            if (update.snapshot.capabilities.content?.revision !== currentNode.capabilities.content?.revision) {
              coordinator.observeExternal(update.snapshot);
            } else {
              observedOnSaved.current(update.snapshot);
            }
            continue;
          }
          const event = update.event;
          if (event.change.mutationID && api.client.isOwnMutation(event.change.mutationID)) continue;
          if (event.tree !== undefined && event.tree !== currentNode.ref.tree) continue;
          const currentPageID = pageIDFromStableKey(currentNode.ref.stableKey);
          const affectsNode = event.change.path === currentNode.ref.path
            || event.change.previousPath === currentNode.ref.path
            || Boolean(currentPageID && event.change.pageID === currentPageID);
          const currentIsDirectory = hasChildren(currentNode);
          const affectsChildren = currentIsDirectory && (
            parentPath(event.change.path) === currentNode.ref.path
            || (event.change.previousPath !== undefined && parentPath(event.change.previousPath) === currentNode.ref.path)
          );
          if (!affectsNode && !affectsChildren) continue;
          const ref = !currentNode.ref.stableKey && event.change.previousPath === currentNode.ref.path && event.kind === "moved"
            ? { tree: currentNode.ref.tree, path: event.change.path, stableKey: null } satisfies NodeRef
            : currentNode.ref;
          const loaded = await sapiRef.current.node(ref);
          if (affectsNode) coordinator.observeExternal(loaded);
          else {
            observedOnSaved.current(loaded);
            onChildrenChanged((await sapiRef.current.children(loaded.ref)).items);
          }
        }
      } catch (error) {
        if (active) coordinator.setMessage(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { active = false; };
  }, [coordinator, updates]);

  // Untracked (`local`) scope has no watcher: revalidate on focus and apply
  // clean external revisions through the same coordinator path events use.
  useEffect(() => {
    if (node.ref.tree !== "local") return;
    let inflight = false;
    const revalidate = async () => {
      if (inflight || document.hidden) return;
      inflight = true;
      try {
        const currentNode = observedNode.current;
        const loaded = await sapiRef.current.node(
          { ...nodeReference, path: currentNode.ref.path },
        );
        if (loaded.capabilities.content?.revision !== observedNode.current.capabilities.content?.revision) {
          coordinator.observeExternal(loaded);
        }
      } catch {} finally {
        inflight = false;
      }
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [coordinator, node.ref.tree]);

  const reload = useCallback(async (nextSelection: string[] = []) => {
    const loaded = await sapiRef.current.node(nodeReference);
    onSavedPreservingScroll(loaded);
    const loadedChildren = hasChildren(loaded) ? (await sapiRef.current.children(loaded.ref)).items : [];
    onChildrenChanged(loadedChildren);
    const visible = new Set(loadedChildren.map((child) => child.ref.path));
    const retained = nextSelection.filter((path) => visible.has(path));
    setSelected(new Set(retained));
    setSelectionAnchor(retained.at(-1) ?? null);
  }, [node.ref.path, onChildrenChanged, onSavedPreservingScroll]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  const runMutation = useCallback(async (
    operations: Parameters<typeof api.mutate>[0]["operations"],
    nextSelection: string[] = [],
  ) => {
    try {
      setMessage(null);
      flushDocumentHistory();
      await flushAutosave();
      const result = await sapiRef.current.mutate({ operations });
      await reload(nextSelection);
      let undoOperations: StructuralWorkspaceOperation[] = [];
      let redoOperations: StructuralWorkspaceOperation[] = operations;
      let undoSelection: string[] = [];
      let redoSelection = nextSelection;
      if (result.created.length) {
        undoOperations = [{ op: "trash", refs: result.created.map((path) => ({ tree: node.ref.tree, path, stableKey: null })) }];
        redoOperations = [{ op: "restore", refs: result.created.map(trashedPath).map((path) => ({ tree: node.ref.tree, path, stableKey: null })) }];
        redoSelection = result.created;
      } else if (result.deleted.length) {
        undoOperations = [{ op: "restore", refs: result.deleted.map(trashedPath).map((path) => ({ tree: node.ref.tree, path, stableKey: null })) }];
        undoSelection = result.deleted;
      } else if (result.moved.length) {
        undoOperations = inverseMoves(result.moved, node.ref.tree);
        undoSelection = result.moved.map((item) => item.from);
        redoSelection = result.moved.map((item) => item.to);
      }
      if (undoOperations.length) {
        const execute = async (request: StructuralWorkspaceOperation[], selection: string[]) => {
          await flushAutosave();
          await sapiRef.current.mutate({ operations: request });
          await reloadRef.current(selection);
        };
        pushHistory({
          label: operations[0]?.op ?? "filesystem change",
          undo: () => execute(undoOperations, undoSelection),
          redo: () => execute(redoOperations, redoSelection),
        });
      }
      return result;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [flushAutosave, flushDocumentHistory, managedOrder.join("\0"), pushHistory, reload]);

  const selectRow = useCallback((path: string, event: React.MouseEvent) => {
    if (event.shiftKey && selectionAnchor) {
      const start = managedOrder.indexOf(selectionAnchor);
      const end = managedOrder.indexOf(path);
      if (start >= 0 && end >= 0) {
        const range = managedOrder.slice(Math.min(start, end), Math.max(start, end) + 1);
        setSelected(new Set(event.metaKey || event.ctrlKey ? [...selectedRef.current, ...range] : range));
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(selectedRef.current);
      if (next.has(path)) next.delete(path); else next.add(path);
      setSelected(next);
      setSelectionAnchor(path);
      return;
    }
    setSelected(new Set([path]));
    setSelectionAnchor(path);
  }, [managedOrder.join("\0"), selectionAnchor]);

  const dragStart = useCallback((path: string, event: React.DragEvent) => {
    event.stopPropagation();
    const paths = selectedRef.current.has(path) ? managedOrder.filter((item) => selectedRef.current.has(item)) : [path];
    if (!selectedRef.current.has(path)) {
      setSelected(new Set([path]));
      setSelectionAnchor(path);
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(ARBOR_DRAG_TYPE, JSON.stringify(paths));
    event.dataTransfer.setData("text/plain", paths.join("\n"));
  }, [managedOrder.join("\0")]);

  const importDrop = useCallback(async (event: React.DragEvent, destination: string) => {
    const entries = await importEntries(event.dataTransfer);
    if (!entries.length) return;
    try {
      setMessage(null);
      flushDocumentHistory();
      await flushAutosave();
      const result = await sapiRef.current.import(destination, entries);
      const nextSelection = destination === node.ref.path ? importedTopLevel(destination, entries) : [];
      await reload(nextSelection);
      if (result.created.length) {
        const created = result.created;
        const execute = async (operations: StructuralWorkspaceOperation[], selection: string[]) => {
          await flushAutosave();
          await sapiRef.current.mutate({ operations });
          await reloadRef.current(selection);
        };
        pushHistory({
          label: "import",
          undo: () => execute([{ op: "trash", refs: created.map((path) => ({ tree: node.ref.tree, path, stableKey: null })) }], []),
          redo: () => execute([{ op: "restore", refs: created.map(trashedPath).map((path) => ({ tree: node.ref.tree, path, stableKey: null })) }], created),
        });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [flushAutosave, flushDocumentHistory, node.ref.path, pushHistory, reload]);

  const runOptimisticMove = useCallback(async (
    paths: string[],
    beforePath?: string,
    beforeBlockId?: string,
  ) => {
    flushDocumentHistory();
    await flushAutosave();
    const before = currentBlocks();
    const previewResult = reorderChildLinks(before, {
      directory: node.ref.path,
      removePaths: paths,
      insertMoves: paths.map((path) => ({ oldPath: path, newPath: path })),
      beforePath,
      beforeBlockId,
    });
    if (previewResult.anchor === "missing") throw new Error("The insertion target is no longer present.");
    const next = { blocks: previewResult.blocks, frontmatter };
    replaceEditorSnapshot(next);
    recordDocumentSnapshot(next);
    flushDocumentHistory();
    await flushAutosave();
    setSelected(new Set(paths));
    setSelectionAnchor(paths.at(-1) ?? null);
  }, [flushAutosave, flushDocumentHistory, frontmatter, recordDocumentSnapshot, replaceEditorSnapshot]);

  const drop = useCallback(async (targetPath: string, position: "before" | "after" | "inside", event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const raw = event.dataTransfer.getData(ARBOR_DRAG_TYPE);
    if (!raw) {
      await importDrop(event, position === "inside" ? targetPath : node.ref.path);
      return;
    }
    const paths = JSON.parse(raw) as string[];
    if (position === "inside") {
      const moved = paths.map((path) => childPath(targetPath, path.slice(path.lastIndexOf("/") + 1)));
      await runMutation([{
        op: "move",
        refs: paths.map((path) => ({ tree: node.ref.tree, path, stableKey: null })),
        destination: { tree: node.ref.tree, path: targetPath, stableKey: null },
      }], moved);
      return;
    }
    const targetIndex = managedOrder.indexOf(targetPath);
    const beforePath = position === "before" ? targetPath : managedOrder[targetIndex + 1];
    try { await runOptimisticMove(paths, beforePath); } catch {}
  }, [importDrop, managedOrder.join("\0"), node.ref.path, runMutation, runOptimisticMove]);
  const dropInDocument = useCallback(async (paths: string[], beforeBlockId?: string) => {
    try { await runOptimisticMove(paths, undefined, beforeBlockId); } catch {}
  }, [runOptimisticMove]);
  const dragStartRef = useRef(dragStart);
  const dropRef = useRef(drop);
  const dropInDocumentRef = useRef(dropInDocument);
  const childKindsRef = useRef(childrenByPath);
  const selectRowRef = useRef(selectRow);
  const managedOrderRef = useRef(managedOrder);
  dragStartRef.current = dragStart;
  dropRef.current = drop;
  dropInDocumentRef.current = dropInDocument;
  childKindsRef.current = childrenByPath;
  selectRowRef.current = selectRow;
  managedOrderRef.current = managedOrder;

  useEffect(() => {
    const surface = bodySurface.current;
    if (!surface) return;
    const managedRow = (target: EventTarget | null) => {
      const row = target instanceof Element ? target.closest<HTMLElement>("[data-managed-row]") : null;
      return row && surface.contains(row) ? row : null;
    };
    const managedHandlePath = (target: EventTarget | null) =>
      target instanceof Element
        ? target.closest<HTMLElement>("[data-arbor-managed-handle]")?.dataset.arborManagedHandle ?? null
        : null;
    const onDragStart = (event: DragEvent) => {
      if ((event as DragEvent & { arborManagedAnnouncement?: boolean }).arborManagedAnnouncement) return;
      const row = managedRow(event.target);
      const path = row?.dataset.managedRow ?? managedHandlePath(event.target);
      if (!path) return;
      blockDropPosition.current = null;
      dragStartRef.current(path, event as unknown as React.DragEvent);
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onDragOver = (event: DragEvent) => {
      if (!managedRow(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onDrop = (event: DragEvent) => {
      const row = managedRow(event.target);
      const targetPath = row?.dataset.managedRow;
      if (!row || !targetPath) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const bounds = row.getBoundingClientRect();
      const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height);
      const targetNode = childKindsRef.current.get(targetPath);
      const position = targetNode && hasChildren(targetNode)
        ? ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside"
        : ratio > 0.5 ? "after" : "before";
      void dropRef.current(targetPath, position, event as unknown as React.DragEvent);
    };
    let pointer: {
      path: string;
      paths: string[];
      x: number;
      y: number;
      moved: boolean;
      viaHandle: boolean;
      handleButton: HTMLButtonElement | null;
      transfer: DataTransfer;
      blockId: string | null;
      blockDragAnnounced: boolean;
    } | null = null;
    let suppressHandleClickUntil = 0;
    const hideNativeDropTarget = () => {
      editorRef.current.prosemirrorView.dom.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
    };
    const finishNativeBlockDrag = (announced: boolean) => {
      editorRef.current.prosemirrorView.dom.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
      if (announced) editorRef.current.getExtension(SideMenuExtension)?.blockDragEnd();
    };
    const updateNativeDropTarget = (event: PointerEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const editorDOM = editorRef.current.prosemirrorView.dom;
      if (!(target instanceof Element) || !editorDOM.contains(target)) {
        hideNativeDropTarget();
        return;
      }
      target.dispatchEvent(new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
        dataTransfer: pointer?.transfer ?? null,
      }));
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.target instanceof Element && event.target.closest("a, input")) return;
      const row = managedRow(event.target);
      const handlePath = managedHandlePath(event.target);
      const path = row?.dataset.managedRow ?? handlePath;
      if (!path) return;
      blockDropPosition.current = null;
      const visiblySelected = new Set([...surface.querySelectorAll<HTMLElement>("[data-managed-row].selected")]
        .flatMap((item) => item.dataset.managedRow ? [item.dataset.managedRow] : []));
      const paths = visiblySelected.has(path)
        ? managedOrderRef.current.filter((item) => visiblySelected.has(item))
        : [path];
      const handleButton = handlePath && event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button")
        : null;
      const sourceRow = row ?? [...surface.querySelectorAll<HTMLElement>("[data-managed-row]")]
        .find((item) => item.dataset.managedRow === path) ?? null;
      const blockId = sourceRow?.closest<HTMLElement>('[data-node-type="blockContainer"][data-id]')?.dataset.id ?? null;
      if (handleButton) handleButton.draggable = false;
      pointer = {
        path,
        paths,
        x: event.clientX,
        y: event.clientY,
        moved: false,
        viaHandle: Boolean(handlePath),
        handleButton,
        transfer: new DataTransfer(),
        blockId,
        blockDragAnnounced: false,
      };
      if (!handlePath) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!pointer) return;
      event.preventDefault();
      if (!pointer.moved) {
        if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 5) return;
        pointer.moved = true;
        if (pointer.paths.length === 1 && !selectedRef.current.has(pointer.path)) {
          selectedRef.current = new Set([pointer.path]);
          setSelected(new Set([pointer.path]));
          setSelectionAnchor(pointer.path);
        }
        setDragPreview({ paths: pointer.paths, x: event.clientX + 14, y: event.clientY + 14 });
        document.body.classList.add("arbor-pointer-dragging");
        const activeEditor = editorRef.current;
        const draggedBlock = pointer.blockId ? activeEditor.getBlock(pointer.blockId) : undefined;
        const sideMenu = activeEditor.getExtension(SideMenuExtension);
        const source = pointer.blockId
          ? activeEditor.prosemirrorView.dom.querySelector<HTMLElement>(`[data-node-type="blockContainer"][data-id="${CSS.escape(pointer.blockId)}"]`)
          : null;
        if (draggedBlock && sideMenu && source) {
          activeEditor.setTextCursorPosition(draggedBlock.id, "start");
          sideMenu.blockDragStart({ dataTransfer: pointer.transfer, clientY: event.clientY }, draggedBlock);
          const announcement = new DragEvent("dragstart", {
            bubbles: true,
            cancelable: true,
            clientX: event.clientX,
            clientY: event.clientY,
            dataTransfer: pointer.transfer,
          }) as DragEvent & { arborManagedAnnouncement?: boolean };
          announcement.arborManagedAnnouncement = true;
          source.dispatchEvent(announcement);
          pointer.blockDragAnnounced = true;
        }
      }
      updateNativeDropTarget(event);
    };
    const updateDragPreview = (event: PointerEvent) => {
      if (!pointer?.moved) return;
      setDragPreview((value) => value ? { ...value, x: event.clientX + 14, y: event.clientY + 14 } : value);
    };
    const onPointerUp = (event: PointerEvent) => {
      const current = pointer;
      pointer = null;
      const resolvedDropPosition = blockDropPosition.current;
      blockDropPosition.current = null;
      if (current?.handleButton) current.handleButton.draggable = true;
      setDragPreview(null);
      document.body.classList.remove("arbor-pointer-dragging");
      finishNativeBlockDrag(Boolean(current?.blockDragAnnounced));
      if (!current) return;
      if (!current.moved) {
        if (current.viaHandle) return;
        const sourceRow = [...surface.querySelectorAll<HTMLElement>("[data-managed-row]")]
          .find((row) => row.dataset.managedRow === current.path);
        if (sourceRow) {
          sourceRow.dataset.suppressClick = "true";
          setTimeout(() => { delete sourceRow.dataset.suppressClick; }, 0);
        }
        selectRowRef.current(current.path, event as unknown as React.MouseEvent);
        return;
      }
      if (current.viaHandle) suppressHandleClickUntil = performance.now() + 250;
      const paths = current.paths;
      const pointTarget = document.elementFromPoint(event.clientX, event.clientY);
      const target = managedRow(pointTarget);
      const targetPath = target?.dataset.managedRow;
      if (!target || !targetPath) {
        if (resolvedDropPosition?.orientation === "block-horizontal") {
          const document = editorRef.current.prosemirrorView.state.doc;
          const nodeAfter = document.resolve(resolvedDropPosition.pos).nodeAfter;
          const beforeBlockId = nodeAfter?.type.isInGroup("bnBlock")
            ? getNodeId(nodeAfter, document)
            : undefined;
          void dropInDocumentRef.current(paths, beforeBlockId);
          return;
        }
        const block = pointTarget?.closest<HTMLElement>('[data-node-type="blockContainer"][data-id]');
        let beforeBlockId: string | undefined;
        if (block) {
          const bounds = block.getBoundingClientRect();
          beforeBlockId = block.dataset.id;
          if ((event.clientY - bounds.top) / Math.max(1, bounds.height) > 0.5) {
            const outer = block.closest<HTMLElement>('[data-node-type="blockOuter"][data-id]');
            const nextOuter = outer?.nextElementSibling;
            beforeBlockId = nextOuter instanceof HTMLElement
              ? nextOuter.querySelector<HTMLElement>('[data-node-type="blockContainer"][data-id]')?.dataset.id
              : undefined;
          }
        } else {
          const group = pointTarget?.closest<HTMLElement>('[data-node-type="blockGroup"]')
            ?? editorRef.current.prosemirrorView.dom.querySelector<HTMLElement>(
              ':scope > [data-node-type="blockGroup"]',
            );
          if (!group) return;
          const nextOuter = [...group.children].find((child) => {
            if (!(child instanceof HTMLElement) || child.dataset.nodeType !== "blockOuter") return false;
            const bounds = child.getBoundingClientRect();
            return event.clientY < bounds.top + bounds.height / 2;
          });
          beforeBlockId = nextOuter instanceof HTMLElement
            ? nextOuter.querySelector<HTMLElement>('[data-node-type="blockContainer"][data-id]')?.dataset.id
            : undefined;
        }
        void dropInDocumentRef.current(paths, beforeBlockId);
        return;
      }
      if (paths.includes(targetPath)) return;
      const transfer = new DataTransfer();
      transfer.setData(ARBOR_DRAG_TYPE, JSON.stringify(paths));
      const dragEvent = new DragEvent("drop", { dataTransfer: transfer, clientX: event.clientX, clientY: event.clientY });
      const bounds = target.getBoundingClientRect();
      const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height);
      const targetNode = childKindsRef.current.get(targetPath);
      const position = targetNode && hasChildren(targetNode)
        ? ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside"
        : ratio > 0.5 ? "after" : "before";
      void dropRef.current(targetPath, position, dragEvent as unknown as React.DragEvent);
    };
    const onClick = (event: MouseEvent) => {
      if (performance.now() > suppressHandleClickUntil || !managedHandlePath(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointermove", updateDragPreview, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("dragstart", onDragStart, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", onDrop, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointermove", updateDragPreview, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("dragstart", onDragStart, true);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drop", onDrop, true);
      document.body.classList.remove("arbor-pointer-dragging");
    };
  }, []);

  const commitCreate = useCallback(async () => {
    const value = createValue.trim();
    if (!creating || !value) return;
    const path = childPath(node.ref.path, value);
    try {
      await runMutation([{ op: creating === "directory" ? "createDirectory" : "createMarkdown", tree: node.ref.tree, path }], [path]);
      setCreating(null);
      setCreateValue("");
    } catch {}
  }, [createValue, creating, node.ref.path, runMutation]);

  const beginRename = useCallback((path: string) => {
    if (!selectedRef.current.has(path) || selectedRef.current.size !== 1) {
      setSelected(new Set([path]));
      setSelectionAnchor(path);
    }
    setRenamingPath(path);
    setRenameValue(path.slice(path.lastIndexOf("/") + 1));
  }, []);
  const startRename = useCallback(() => {
    const path = [...selected][0];
    if (selected.size !== 1 || !path) return;
    beginRename(path);
  }, [beginRename, selected]);

  const commitRename = useCallback(async () => {
    const path = renamingPath;
    const name = renameValue.trim();
    if (!path || !name) { setRenamingPath(null); return; }
    if (name === path.slice(path.lastIndexOf("/") + 1)) { setRenamingPath(null); return; }
    const next = childPath(parentPath(path), name);
    setRenamingPath(null);
    try { await runMutation([{ op: "rename", ref: { tree: node.ref.tree, path, stableKey: null }, name }], [next]); } catch {}
  }, [renameValue, renamingPath, runMutation]);

  const trashSelection = useCallback(async (focusPath?: string) => {
    const paths = focusPath && !selected.has(focusPath)
      ? [focusPath]
      : managedOrder.filter((path) => selected.has(path));
    if (!paths.length || !confirm(`Move ${paths.length === 1 ? paths[0] : `${paths.length} items`} to Trash?`)) return;
    try { await runMutation([{ op: "trash", refs: paths.map((path) => ({ tree: node.ref.tree, path, stableKey: null })) }]); } catch {}
  }, [managedOrder.join("\0"), runMutation, selected]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = target.matches("input, textarea") || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void (event.shiftKey ? redo() : undo());
        return;
      }
      if (event.key === "Escape" && !editing) {
        setSelected(new Set());
        setSelectionAnchor(null);
      }
      if (!isDirectory || editing) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault(); setCreating("directory"); setCreateValue("");
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault(); setCreating("markdown"); setCreateValue("");
      } else if (event.key === "Enter" && selectedRef.current.size === 1) {
        event.preventDefault(); startRename();
      } else if ((event.metaKey || event.ctrlKey) && event.key === "Backspace" && selectedRef.current.size) {
        event.preventDefault(); void trashSelection();
      }
    };
    addEventListener("keydown", listener, true);
    return () => removeEventListener("keydown", listener, true);
  }, [isDirectory, redo, startRename, trashSelection, undo]);

  const managedRows = useMemo<ManagedRowsController>(() => ({
    resolve: (rawPath, blockID) => {
      const path = resolveChildLinkPath(node.ref.path, rawPath);
      if (!path || !childrenByPath.has(path)) return null;
      const firstClaimingBlockID = (blocks: readonly any[]): string | null => {
        for (const block of blocks) {
          if (
            block.type === "standaloneLink"
            && resolveChildLinkPath(node.ref.path, String(block.props?.path ?? "")) === path
          ) {
            return String(block.id);
          }
          const nested = firstClaimingBlockID(block.children ?? []);
          if (nested) return nested;
        }
        return null;
      };
      return firstClaimingBlockID(editor.document) === blockID ? path : null;
    },
    kind: (path) => {
      const child = childrenByPath.get(path);
      return child ? presentationKind(child) : null;
    },
    selected: (path) => selected.has(path),
    select: selectRow,
    rename: beginRename,
    trash: (path) => { void trashSelection(path); },
    drop,
    renamingPath,
    renameValue,
    setRenameValue,
    commitRename: () => { void commitRename(); },
    cancelRename: () => setRenamingPath(null),
  }), [beginRename, childrenByPath, commitRename, drop, editor, node.ref.path, renameValue, renamingPath, selectRow, selected, trashSelection]);

  const keys = Object.keys(frontmatter);
  const propertyKeys = frontmatter.type === "group" && !("members" in frontmatter) ? [...keys, "members"] : keys;
  const memberOrigin = communityArborOrigin(node.enclosingTree?.canonical?.locator);
  const openInternalLink = (event: React.MouseEvent) => {
    const anchor = (event.target as Element).closest("a");
    const href = anchor?.getAttribute("href");
    if (!href) return;
    // Every document resolves links from its canonical logical address as a
    // directory-like base, regardless of leaf/directory/_index.md backing.
    const link = resolveLogicalURL(node.ref.path, href);
    if (link?.kind === "external") return;
    event.preventDefault();
    if (link?.kind === "local") {
      const pageID = legacyPageIDCandidate(link);
      navigate(pageID ? { tree: node.ref.tree, path: link.path, stableKey: pageIDStableKey(pageID) } : link.path);
    } else if (link?.kind === "fragment") {
      navigate({ tree: node.ref.tree, path: node.ref.path, stableKey: pageIDStableKey(legacyPageIDCandidate(link)!) });
    }
    // arbor://, system:, and local: destinations wait on mount/visit resolution.
  };
  const closePageActions = () => {
    if (pageActionsMenu.current) pageActionsMenu.current.open = false;
  };
  const saveStateLabel = saveState === "saving" ? "Saving…"
    : saveState === "changed" ? "Changes pending"
      : saveState === "external" ? "External changes"
        : saveState === "conflict" ? "Conflict"
          : saveState === "error" ? "Save failed"
            : "Saved";
  const firstBlock = editor.document[0] as ArborEditorBlock | undefined;
  const beginsWithTitle = firstBlock?.type === "heading" && Number(firstBlock.props.level) === 1;
  const addPageTitle = () => {
    const first = editor.document[0] as ArborEditorBlock | undefined;
    if (!first) return;
    const reusesStarterParagraph = editor.document.length === 1
      && first.type === "paragraph"
      && Array.isArray(first.content)
      && first.content.length === 0
      && first.children.length === 0;
    editor.transact(() => {
      const title = reusesStarterParagraph
        ? editor.updateBlock(first, { type: "heading", props: { level: 1 } })
        : editor.insertBlocks([{ type: "heading", props: { level: 1 } }], first, "before")[0]!;
      editor.setTextCursorPosition(title, "start");
    });
    editor.focus();
  };

  return <div className="editor-shell">
    <details className="properties">
      <summary><span>Properties</span><small>{propertyKeys.length}</small></summary>
      <div className="properties-grid">
        {propertyKeys.map((key) => {
          const value = frontmatter[key] ?? (key === "members" ? [] : "");
          if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
            return <StringListProperty
              key={key}
              property={key}
              values={value}
              communityOrigin={memberOrigin}
              communityMembers={key === "members" && node.enclosingTree?.canonical?.path === "/"}
              onChange={(items) => {
                const next = { ...frontmatter, [key]: items };
                setFrontmatter(next);
                recordDocumentSnapshot(snapshot(next));
              }}
            />;
          }
          return <label key={key}><span>{key}</span><input value={typeof value === "object" ? JSON.stringify(value) : String(value ?? "")} disabled={key === "id" || typeof value === "object"} onChange={(event) => {
            const next = { ...frontmatter, [key]: event.target.value };
            setFrontmatter(next);
            recordDocumentSnapshot(snapshot(next));
          }} /></label>;
        })}
        <button className="quiet" onClick={() => {
          const key = prompt("Property name");
          if (key) {
            const next = { ...frontmatter, [key]: "" };
            setFrontmatter(next);
            recordDocumentSnapshot(snapshot(next));
          }
        }}>+ property</button>
      </div>
    </details>
    {pageActionsHost && createPortal(<details className="page-actions-menu" ref={pageActionsMenu}>
      <summary aria-label="Page actions" title="Page actions"><Ellipsis aria-hidden="true" /></summary>
      <div role="menu">
        <button role="menuitem" disabled={!coordinator.canUndo} title="Undo (⌘Z)" onClick={() => { closePageActions(); void undo(); }}>Undo</button>
        <button role="menuitem" disabled={!coordinator.canRedo} title="Redo (⇧⌘Z)" onClick={() => { closePageActions(); void redo(); }}>Redo</button>
        {node.ref.tree !== "local" && <button role="menuitem" onClick={async () => {
          closePageActions();
          setRecovery(await sapiRef.current.recovery(nodeReference, isDirectory));
        }}>{isDirectory ? "Recover subtree…" : "Recover…"}</button>}
        {isDirectory && <>
          <div className="menu-separator" />
          <button role="menuitem" title="New Markdown Page (⌘N)" onClick={() => { closePageActions(); setCreating("markdown"); setCreateValue(""); }}>New Page</button>
          <button role="menuitem" title="New Folder (⇧⌘N)" onClick={() => { closePageActions(); setCreating("directory"); setCreateValue(""); }}>New Folder</button>
          <div className="menu-separator" />
          <button role="menuitem" title="Rename (Enter)" disabled={selected.size !== 1} onClick={() => { closePageActions(); startRename(); }}>Rename selected page</button>
          <button role="menuitem" title="Move to Trash (⌘⌫)" disabled={!selected.size} className="danger" onClick={() => { closePageActions(); void trashSelection(); }}>Move selected page to Trash</button>
        </>}
      </div>
    </details>, pageActionsHost)}
    <div className={`editor-status${saveState === "saved" && !message ? " editor-status-saved" : ""}`}>
      {message && <span className="warning">{message}</span>}
      {saveState === "conflict" && <button onClick={async () => {
        const local = snapshot();
        const loaded = await sapiRef.current.node(nodeReference);
        const loadedDocument = nodeDocument(loaded);
        const disk: DocumentSnapshot = {
          blocks: loadedDocument?.blocks ?? [],
          frontmatter: { ...(loadedDocument?.frontmatter ?? {}) },
        };
        coordinator.useDisk(loaded, local, disk);
      }}>Use disk</button>}
      {saveState === "conflict" && <button onClick={async () => save((await sapiRef.current.node(nodeReference)).capabilities.content?.revision)}>Keep mine</button>}
      {(saveState === "error" || saveState === "external") && <button className="retry-save" onClick={() => void save()}>Retry</button>}
      <span className={`save-state ${saveState}`} role="status">{saveStateLabel}</span>
    </div>
    {creating && <div className="provisional-child-page">
      <span>{creating === "directory" ? "▸" : "↗"}</span>
      <input
        autoFocus
        aria-label={creating === "directory" ? "New folder name" : "New page name"}
        placeholder={creating === "directory" ? "Folder name" : "Page name"}
        value={createValue}
        onChange={(event) => setCreateValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); void commitCreate(); }
          if (event.key === "Escape") { event.preventDefault(); setCreating(null); setCreateValue(""); }
        }}
      />
    </div>}
    <ManagedRowsContext.Provider value={managedRows}>
      <div
        ref={bodySurface}
        className="body-drop-surface"
        data-footnote-layout={footnoteLayout.mode}
        onClick={(event) => {
          if (event.target === event.currentTarget || (event.target as Element).classList.contains("bn-editor")) {
            setSelected(new Set()); setSelectionAnchor(null);
          }
        }}
        onDragOver={(event) => {
          if (!(event.target as Element).closest("[data-managed-row]")) event.preventDefault();
        }}
        onDrop={(event) => {
          if ((event.target as Element).closest("[data-managed-row]")) return;
          event.preventDefault();
          const raw = event.dataTransfer.getData(ARBOR_DRAG_TYPE);
          if (raw) {
            const paths = JSON.parse(raw) as string[];
            const block = (event.target as Element).closest<HTMLElement>('[data-node-type="blockContainer"][data-id]');
            if (!block) {
              void runMutation([{
                op: "move",
                refs: paths.map((path) => ({ tree: node.ref.tree, path, stableKey: null })),
                destination: { tree: node.ref.tree, path: node.ref.path, stableKey: null },
              }], paths);
              return;
            }
            const bounds = block.getBoundingClientRect();
            const beforeBlockId = (event.clientY - bounds.top) / Math.max(1, bounds.height) > 0.5
              ? block.nextElementSibling instanceof HTMLElement ? block.nextElementSibling.dataset.id : undefined
              : block.dataset.id;
            void dropInDocument(paths, beforeBlockId);
          } else void importDrop(event, node.ref.path);
        }}
        onClickCapture={openInternalLink}
      >
        <style>{footnoteLayout.css}</style>
        {!beginsWithTitle && <button type="button" className="add-page-title" aria-label="Add page title" onClick={addPageTitle}>
          Add title
        </button>}
        <BlockNoteView editor={editor} sideMenu={false} formattingToolbar={false} slashMenu={false} onChange={(_editor, { getChanges }) => {
          if (coordinator.isApplying) return;
          if (!getChanges().some((change) => change.source.type !== "yjs-remote")) return;
          recordDocumentSnapshot(snapshot());
        }} data-theming-css-variables-demo>
          <FormattingToolbarController formattingToolbar={ArborFormattingToolbar} />
          <SideMenuController sideMenu={ArborSideMenu} />
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) => filterSuggestionItems(getArborSlashMenuItems(editor), query)}
          />
        </BlockNoteView>
      </div>
    </ManagedRowsContext.Provider>
    {dragPreview && <div className="managed-drag-preview" style={{ left: dragPreview.x, top: dragPreview.y }}>
      <span>↗</span>
      {dragPreview.paths.length === 1 ? dragPreview.paths[0]!.slice(dragPreview.paths[0]!.lastIndexOf("/") + 1) : `${dragPreview.paths.length} pages`}
    </div>}
    {!!backlinks.length && <section className="backlinks">
      <strong>Linked from</strong>
      {backlinks.map((entry) => <button key={`${entry.ref.path}:${entry.context}`} onClick={() => navigate(entry.ref)}>
        <span>{entry.title}</span>
        <small>{entry.context}</small>
      </button>)}
    </section>}
    {recovery && <div className="recovery">
      <div className="recovery-title"><strong>{isDirectory ? "Recover subtree" : "Recover blocks"}</strong><button className="quiet" onClick={() => setRecovery(null)}>Close</button></div>
      {!recovery.length && <p>Nothing recoverable here.</p>}
      {recovery.map((entry) => entry.kind === "block"
        ? <div className="recovery-entry" key={`block:${entry.ref.path}:${entry.hash}`}>
          <div><span>{entry.status} · {entry.ref.path}</span><pre>{entry.markdown}</pre></div>
          <button onClick={async () => {
            await sapiRef.current.restoreBlock(entry.ref, entry.hash);
            onSavedPreservingScroll(await sapiRef.current.node(nodeReference));
            setRecovery(await sapiRef.current.recovery(nodeReference, isDirectory));
          }}>Restore</button>
        </div>
        : <div className="recovery-entry" key={`trash:${entry.ref.path}`}>
          <div><span>Trash · {entry.nodeKind}</span><p>{entry.originalPath}</p></div>
          <button onClick={async () => {
            await sapiRef.current.restoreTrash(entry.ref);
            onSavedPreservingScroll(await sapiRef.current.node(nodeReference));
            setRecovery(await sapiRef.current.recovery(nodeReference, isDirectory));
          }}>Restore</button>
        </div>)}
    </div>}
  </div>;
}
