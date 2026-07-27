import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BlockNoteEditor, getNodeId } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { filterSuggestionItems, SideMenuExtension } from "@blocknote/core/extensions";
import { TextSelection } from "@tiptap/pm/state";
import { FormattingToolbarController, SideMenuController, SuggestionMenuController } from "@blocknote/react";
import type { ArborBlock, BacklinkEntry, ProjectedDocument, RecoveryEntry } from "@arbor/core";
import type {
  NodeRef,
  NodeSnapshot,
  ProjectedNodeUpdate,
  StructuralWorkspaceOperation,
} from "@arbor/client";
import { canonicalNodePath } from "@arbor/core/logical-path";
import { resolveLogicalURL } from "@arbor/core/logical-url";
import { isSyntheticRowBlockID } from "@arbor/core/projection";
import { resolveStructuralRowPath, transformStructuralRows } from "@arbor/core/structural-rows";
import { api, type BrowserMutationResult } from "./api.ts";
import {
  EditorCoordinator,
  frontmatterPatch,
  type DocumentSnapshot,
  type HistoryEntry,
} from "./editor-coordinator.ts";
import { importEntries } from "./file-drop.ts";
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

function inverseMoves(moved: BrowserMutationResult["moved"]): StructuralWorkspaceOperation[] {
  const byParent = new Map<string, string[]>();
  for (const item of moved) {
    const paths = byParent.get(parentPath(item.from)) ?? [];
    paths.push(item.to);
    byParent.set(parentPath(item.from), paths);
  }
  return [...byParent].map(([destination, paths]) => ({
    op: "move",
    refs: paths.map((path) => ({ path })),
    destination: { path: destination },
  }));
}

export function PageEditor({ node, projection, updates, onSaved, navigate }: {
  node: NodeSnapshot;
  projection: ProjectedDocument | null;
  updates: AsyncIterable<ProjectedNodeUpdate>;
  onSaved: (node: NodeSnapshot) => void;
  navigate: (target: string | NodeRef) => void;
}) {
  const authored = node.document?.blocks ?? [];
  const isDirectory = node.kind === "directory" || node.kind === "collection";
  const physicalChildren = node.children ?? [];
  const childrenRevision = physicalChildren.map((child) => `${child.path}:${child.kind}:${child.materialization}`).join("\0");
  const childrenByPath = useMemo(() => new Map(physicalChildren.map((child) => [child.path, child])), [childrenRevision]);
  // The manifest-driven projected view: stored/authored blocks plus one
  // synthetic row per unmatched child, derived by the shared client
  // projection — never assembled locally.
  const initial = projection?.visibleBlocks ?? authored;
  const rowByBlockID = useMemo(
    () => new Map((projection?.managedChildren ?? []).map((row) => [row.blockID, row])),
    [projection],
  );
  const managedOrder = (projection?.managedChildren ?? []).map((row) => row.ref.path);
  const originals = useMemo(() => originalMap(initial), [node.contentRevision, childrenRevision]);
  const pageDirectory = isDirectory ? node.path : parentPath(node.path);
  const pageDirectoryRef = useRef(pageDirectory);
  pageDirectoryRef.current = pageDirectory;
  // Every reference this editor issues stays in the node's tree scope, so
  // an in-flight save never follows a navigation into another root.
  const sapi = useMemo(() => api.scoped(node.tree), [node.tree]);
  const sapiRef = useRef(sapi);
  sapiRef.current = sapi;
  const nodeReference: NodeRef = node.ref.pageID
    ? { tree: node.tree, pageID: node.ref.pageID, pathHint: node.path }
    : { tree: node.tree, path: node.path };
  const nodeIdentity = useRef(node.ref.pageID ?? node.path).current;
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
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>({ ...(node.document?.frontmatter ?? {}) });
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
    if (node.tree === "local") {
      setBacklinks([]);
      return;
    }
    sapiRef.current.backlinks(nodeReference).then(
      (entries) => { if (!cancelled) setBacklinks(entries); },
      () => { if (!cancelled) setBacklinks([]); },
    );
    return () => { cancelled = true; };
  }, [node.path, node.ref.pageID, node.tree]);

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
  }, [node.path, node.contentRevision, childrenRevision]);

  useEffect(() => {
    setSelected(new Set());
    setSelectionAnchor(null);
    setCreating(null);
    setRenamingPath(null);
  }, [node.path]);

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
  const stripSyntheticRows = useCallback((value: DocumentSnapshot): DocumentSnapshot => ({
    ...value,
    blocks: value.blocks.filter((block) => !isSyntheticRowBlockID(block.id)),
  }), []);
  const coordinator = useMemo(() => new EditorCoordinator({
    path: node.path,
    revision: node.contentRevision!,
    baseBlocks: authored,
    baseFrontmatter: node.document?.frontmatter ?? {},
    initialSnapshot: { blocks: initial, frontmatter: node.document?.frontmatter ?? {} },
    capture: () => snapshotRef.current(),
    toPersisted: stripSyntheticRows,
    write: (_path, baseRevision, value, base) => sapiRef.current.write(nodeReference, {
      baseContentRevision: baseRevision,
      frontmatterPatch: frontmatterPatch(base.frontmatter, value.frontmatter),
      blocks: value.blocks,
    }),
    applySnapshot: replaceEditorSnapshot,
    acceptNode: onSavedPreservingScroll,
    notify: () => renderCoordinator((value) => value + 1),
  }), [editor, nodeIdentity]);
  coordinator.configure({
    capture: () => snapshotRef.current(),
    toPersisted: stripSyntheticRows,
    write: (_path, baseRevision, value, base) => sapiRef.current.write(nodeReference, {
      baseContentRevision: baseRevision,
      frontmatterPatch: frontmatterPatch(base.frontmatter, value.frontmatter),
      blocks: value.blocks,
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
      frontmatter: { ...(node.document?.frontmatter ?? {}) },
    });
  }, [childrenRevision, coordinator, node.contentRevision]);

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
  }, [editor, node.path]);

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
            if (update.snapshot.contentRevision !== currentNode.contentRevision) {
              coordinator.observeExternal(update.snapshot);
            } else {
              observedOnSaved.current(update.snapshot);
            }
            continue;
          }
          const event = update.event;
          if (event.mutationID && api.client.isOwnMutation(event.mutationID)) continue;
          if (event.tree !== undefined && currentNode.tree !== undefined && event.tree !== currentNode.tree) continue;
          const affectsNode = event.path === currentNode.path
            || event.previousPath === currentNode.path
            || Boolean(currentNode.ref.pageID && event.pageID === currentNode.ref.pageID);
          const currentIsDirectory = currentNode.kind === "directory" || currentNode.kind === "collection";
          const affectsChildren = currentIsDirectory && (
            parentPath(event.path) === currentNode.path
            || (event.previousPath !== undefined && parentPath(event.previousPath) === currentNode.path)
          );
          if (!affectsNode && !affectsChildren) continue;
          const ref = !currentNode.ref.pageID && event.previousPath === currentNode.path && event.kind === "moved"
            ? { path: event.path } satisfies NodeRef
            : currentNode.ref.pageID
              ? { pageID: currentNode.ref.pageID, pathHint: currentNode.path }
              : { path: currentNode.path };
          const loaded = await sapiRef.current.node(ref);
          if (affectsNode) coordinator.observeExternal(loaded);
          else observedOnSaved.current(loaded);
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
    if (node.tree !== "local") return;
    let inflight = false;
    const revalidate = async () => {
      if (inflight || document.hidden) return;
      inflight = true;
      try {
        const currentNode = observedNode.current;
        const loaded = await sapiRef.current.node(
          "path" in nodeReference ? { ...nodeReference, path: currentNode.path } : nodeReference,
        );
        if (loaded.contentRevision !== observedNode.current.contentRevision) {
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
  }, [coordinator, node.tree]);

  const reload = useCallback(async (nextSelection: string[] = []) => {
    const loaded = await sapiRef.current.node(nodeReference);
    onSavedPreservingScroll(loaded);
    const visible = new Set((loaded.children ?? []).map((child) => child.path));
    const retained = nextSelection.filter((path) => visible.has(path));
    setSelected(new Set(retained));
    setSelectionAnchor(retained.at(-1) ?? null);
  }, [node.path, onSavedPreservingScroll]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  const runMutation = useCallback(async (
    operations: Parameters<typeof api.mutate>[0]["operations"],
    nextSelection: string[] = [],
    beforeBlocksOverride?: ArborBlock[],
  ) => {
    try {
      setMessage(null);
      flushDocumentHistory();
      await flushAutosave();
      const beforeOrder = [...managedOrder];
      const beforeBlocks = beforeBlocksOverride ?? currentBlocks();
      const result = await sapiRef.current.mutate({ operations });
      await reload(nextSelection);
      let undoOperations: StructuralWorkspaceOperation[] = [];
      let redoOperations: StructuralWorkspaceOperation[] = operations;
      let undoSelection: string[] = [];
      let redoSelection = nextSelection;
      if (result.created.length) {
        undoOperations = [{ op: "trash", refs: result.created.map((path) => ({ path })) }];
        redoOperations = [{ op: "restore", refs: result.created.map(trashedPath).map((path) => ({ path })) }];
        redoSelection = result.created;
      } else if (result.deleted.length) {
        undoOperations = [{ op: "restore", refs: result.deleted.map(trashedPath).map((path) => ({ path })) }];
        undoSelection = result.deleted;
      } else if (result.moved.length) {
        undoOperations = inverseMoves(result.moved);
        undoSelection = result.moved.map((item) => item.from);
        redoSelection = result.moved.map((item) => item.to);
      } else {
        const reorder = operations.find((operation): operation is Extract<StructuralWorkspaceOperation, { op: "move" }> => operation.op === "move");
        const reorderPaths = reorder?.refs.flatMap((ref) => "path" in ref ? [ref.path] : []) ?? [];
        const reorderDestination = reorder && "path" in reorder.destination ? reorder.destination.path : null;
        if (reorder && reorderDestination && reorderPaths.length === reorder.refs.length && reorderPaths.every((path) => parentPath(path) === reorderDestination)) {
          const selectedPaths = new Set(reorderPaths);
          const lastIndex = Math.max(...reorderPaths.map((path) => beforeOrder.indexOf(path)));
          const beforePath = beforeOrder.slice(lastIndex + 1).find((path) => !selectedPaths.has(path));
          const selectedBlockIndexes = beforeBlocks.flatMap((block, index) => {
            const path = block.type === "standaloneLink" ? resolveStructuralRowPath(node.path, String(block.props?.path ?? "")) : null;
            return path && selectedPaths.has(path) ? [index] : [];
          });
          const beforeBlockId = beforeBlocks.slice(Math.max(...selectedBlockIndexes, -1) + 1).find((block) => {
            const path = block.type === "standaloneLink" ? resolveStructuralRowPath(node.path, String(block.props?.path ?? "")) : null;
            return !path || !selectedPaths.has(path);
          })?.id;
          undoOperations = [{
            op: "move",
            refs: beforeOrder.filter((path) => selectedPaths.has(path)).map((path) => ({ path })),
            destination: { path: reorderDestination },
            beforePath,
            // Synthetic row IDs are projection artifacts; the path anchor suffices.
            beforeBlockID: beforeBlockId && !isSyntheticRowBlockID(beforeBlockId) ? beforeBlockId : undefined,
          }];
          undoSelection = reorderPaths;
        }
      }
      if (undoOperations.length) {
        const execute = async (request: StructuralWorkspaceOperation[], selection: string[]) => {
          await flushAutosave();
          const prepared = await Promise.all(request.map(async (operation) => {
            if (
              operation.op !== "move"
              || operation.baseDirectoryRevision === undefined && !operation.beforePath && !operation.beforeBlockID
            ) return operation;
            if (!("path" in operation.destination)) return operation;
            return {
              ...operation,
              baseDirectoryRevision: (await sapiRef.current.node(operation.destination.path)).directoryRevision,
            };
          }));
          await sapiRef.current.mutate({ operations: prepared });
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
      const nextSelection = destination === node.path ? importedTopLevel(destination, entries) : [];
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
          undo: () => execute([{ op: "trash", refs: created.map((path) => ({ path })) }], []),
          redo: () => execute([{ op: "restore", refs: created.map(trashedPath).map((path) => ({ path })) }], created),
        });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [flushAutosave, flushDocumentHistory, node.path, pushHistory, reload]);

  const runOptimisticMove = useCallback(async (
    paths: string[],
    beforePath?: string,
    beforeBlockId?: string,
  ) => {
    flushDocumentHistory();
    await flushAutosave();
    const before = currentBlocks();
    const previewResult = transformStructuralRows(before, {
      directory: node.path,
      removePaths: paths,
      insertMoves: paths.map((path) => ({ oldPath: path, newPath: path })),
      beforePath,
      beforeBlockId,
    });
    if (previewResult.anchor === "missing") throw new Error("The insertion target is no longer present.");
    const preview = previewResult.blocks;
    coordinator.applyNormalizationSnapshot({ blocks: preview, frontmatter });
    // Synthetic managed-row IDs never cross the wire: an anchor on a
    // synthetic row is translated to that child's path.
    let wireBeforePath = beforePath;
    let wireBeforeBlockID = beforeBlockId;
    if (wireBeforeBlockID && isSyntheticRowBlockID(wireBeforeBlockID)) {
      wireBeforePath ??= rowByBlockID.get(wireBeforeBlockID)?.ref.path;
      wireBeforeBlockID = undefined;
      if (!wireBeforePath) throw new Error("The insertion target is no longer present.");
    }
    try {
      return await runMutation(
        [{
          op: "move",
          refs: paths.map((path) => ({ path })),
          destination: { path: node.path },
          placement: "authored",
          beforePath: wireBeforePath,
          beforeBlockID: wireBeforeBlockID,
          baseDirectoryRevision: coordinator.currentRevision,
        }],
        paths,
        before,
      );
    } catch (error) {
      coordinator.applyNormalizationSnapshot({ blocks: before, frontmatter });
      throw error;
    }
  }, [coordinator, flushAutosave, flushDocumentHistory, frontmatter, node.path, rowByBlockID, runMutation]);

  const drop = useCallback(async (targetPath: string, position: "before" | "after" | "inside", event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const raw = event.dataTransfer.getData(ARBOR_DRAG_TYPE);
    if (!raw) {
      await importDrop(event, position === "inside" ? targetPath : node.path);
      return;
    }
    const paths = JSON.parse(raw) as string[];
    if (position === "inside") {
      const moved = paths.map((path) => childPath(targetPath, path.slice(path.lastIndexOf("/") + 1)));
      await runMutation([{
        op: "move",
        refs: paths.map((path) => ({ path })),
        destination: { path: targetPath },
        placement: "natural",
      }], moved);
      return;
    }
    const targetIndex = managedOrder.indexOf(targetPath);
    const beforePath = position === "before" ? targetPath : managedOrder[targetIndex + 1];
    try { await runOptimisticMove(paths, beforePath); } catch {}
  }, [importDrop, managedOrder.join("\0"), node.path, runMutation, runOptimisticMove]);
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
      const kind = childKindsRef.current.get(targetPath)?.kind;
      const position = kind === "directory" || kind === "collection"
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
      const kind = childKindsRef.current.get(targetPath)?.kind;
      const position = kind === "directory" || kind === "collection"
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
    const path = childPath(node.path, value);
    try {
      await runMutation([{ op: creating === "directory" ? "createDirectory" : "createMarkdown", path }], [path]);
      setCreating(null);
      setCreateValue("");
    } catch {}
  }, [createValue, creating, node.path, runMutation]);

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
    try { await runMutation([{ op: "rename", ref: { path }, name }], [next]); } catch {}
  }, [renameValue, renamingPath, runMutation]);

  const trashSelection = useCallback(async (focusPath?: string) => {
    const paths = focusPath && !selected.has(focusPath)
      ? [focusPath]
      : managedOrder.filter((path) => selected.has(path));
    if (!paths.length || !confirm(`Move ${paths.length === 1 ? paths[0] : `${paths.length} items`} to Trash?`)) return;
    try { await runMutation([{ op: "trash", refs: paths.map((path) => ({ path })) }]); } catch {}
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
    resolve: (rawPath) => {
      const path = resolveStructuralRowPath(node.path, rawPath);
      return path && childrenByPath.has(path) ? path : null;
    },
    kind: (path) => childrenByPath.get(path)?.kind ?? null,
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
  }), [beginRename, childrenByPath, commitRename, drop, node.path, renameValue, renamingPath, selectRow, selected, trashSelection]);

  const keys = Object.keys(frontmatter);
  const openInternalLink = (event: React.MouseEvent) => {
    const anchor = (event.target as Element).closest("a");
    const href = anchor?.getAttribute("href");
    if (!href) return;
    // Every document resolves links from its canonical logical address as a
    // directory-like base, regardless of leaf/directory/_index.md backing.
    const link = resolveLogicalURL(node.path, href);
    if (link?.kind === "external") return;
    event.preventDefault();
    if (link?.kind === "local") {
      navigate(link.pageID ? { pageID: link.pageID, pathHint: link.path } : link.path);
    } else if (link?.kind === "fragment") {
      navigate({ pageID: link.pageID });
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

  return <div className="editor-shell">
    <details className="properties">
      <summary><span>Properties</span><small>{keys.length}</small></summary>
      <div className="properties-grid">
        {keys.map((key) => <label key={key}><span>{key}</span><input value={String(frontmatter[key] ?? "")} disabled={key === "id"} onChange={(event) => {
          const next = { ...frontmatter, [key]: event.target.value };
          setFrontmatter(next);
          recordDocumentSnapshot(snapshot(next));
        }} /></label>)}
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
    <details className="page-actions-menu" ref={pageActionsMenu}>
      <summary aria-label="Page actions" title="Page actions">•••</summary>
      <div role="menu">
        <button role="menuitem" disabled={!coordinator.canUndo} title="Undo (⌘Z)" onClick={() => { closePageActions(); void undo(); }}>Undo</button>
        <button role="menuitem" disabled={!coordinator.canRedo} title="Redo (⇧⌘Z)" onClick={() => { closePageActions(); void redo(); }}>Redo</button>
        {node.tree !== "local" && <button role="menuitem" onClick={async () => {
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
    </details>
    <div className={`editor-status${saveState === "saved" && !message ? " editor-status-saved" : ""}`}>
      {message && <span className="warning">{message}</span>}
      {saveState === "conflict" && <button onClick={async () => {
        const local = snapshot();
        const loaded = await sapiRef.current.node(nodeReference);
        const disk: DocumentSnapshot = {
          blocks: loaded.document?.blocks ?? [],
          frontmatter: { ...(loaded.document?.frontmatter ?? {}) },
        };
        coordinator.useDisk(loaded, local, disk);
      }}>Use disk</button>}
      {saveState === "conflict" && <button onClick={async () => save((await sapiRef.current.node(nodeReference)).contentRevision)}>Keep mine</button>}
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
                refs: paths.map((path) => ({ path })),
                destination: { path: node.path },
              }], paths);
              return;
            }
            const bounds = block.getBoundingClientRect();
            const beforeBlockId = (event.clientY - bounds.top) / Math.max(1, bounds.height) > 0.5
              ? block.nextElementSibling instanceof HTMLElement ? block.nextElementSibling.dataset.id : undefined
              : block.dataset.id;
            void dropInDocument(paths, beforeBlockId);
          } else void importDrop(event, node.path);
        }}
        onClickCapture={openInternalLink}
      >
        <style>{footnoteLayout.css}</style>
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
