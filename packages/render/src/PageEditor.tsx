import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { SideMenuController, useCreateBlockNote } from "@blocknote/react";
import type { ArborBlock, TreeNode } from "@arbor/core";
import { canonicalNodePath } from "@arbor/core/logical-path";
import type { FsMutation, FsMutationResult } from "@arbor/fs";
import { mergeBlocks } from "@arbor/editor";
import { api } from "./api.ts";
import { importEntries } from "./file-drop.ts";
import {
  arborSchema,
  ArborSideMenu,
  blockText,
  fromBlockNote,
  ManagedRowsContext,
  originalMap,
  toBlockNote,
  type ArborEditorBlock,
  type ManagedRowsController,
} from "./blocks.tsx";

const ARBOR_DRAG_TYPE = "application/x-arbor-logical-paths";
const AUTOSAVE_DELAY_MS = 750;

type SaveState = "saved" | "changed" | "saving" | "external" | "conflict" | "error";

interface DocumentSnapshot {
  blocks: ArborBlock[];
  frontmatter: Record<string, unknown>;
}

interface HistoryEntry {
  label: string;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function childPath(parent: string, name: string): string {
  return canonicalNodePath(`${parent === "/" ? "" : parent}/${name}`);
}

function resolveChildReference(parent: string, raw: string): string | null {
  if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const base = parent === "/" ? "/" : `${parent}/`;
  return canonicalNodePath(new URL(raw.split("#")[0]!, `http://arbor${base}`).pathname);
}

function importedTopLevel(destination: string, entries: Array<{ path: string }>): string[] {
  return [...new Set(entries.map((entry) => entry.path.split("/")[0]).filter(Boolean).map((name) => childPath(destination, name!)))];
}

function trashedPath(path: string): string {
  return canonicalNodePath(`/Trash${path}`);
}

function inverseMoves(moved: FsMutationResult["moved"]): FsMutation[] {
  const byParent = new Map<string, string[]>();
  for (const item of moved) {
    const paths = byParent.get(parentPath(item.from)) ?? [];
    paths.push(item.to);
    byParent.set(parentPath(item.from), paths);
  }
  return [...byParent].map(([destination, paths]) => ({ op: "move", paths, destination }));
}

function moveManagedRows(
  blocks: ArborBlock[],
  directory: string,
  paths: string[],
  beforePath?: string,
  beforeBlockId?: string,
): ArborBlock[] {
  const selected = new Set(paths);
  const rows = new Map<string, ArborBlock>();
  const collect = (items: ArborBlock[]) => {
    for (const block of items) {
      const path = block.type === "childPage"
        ? resolveChildReference(directory, String(block.props?.path ?? ""))
        : null;
      if (path && selected.has(path)) rows.set(path, block);
      collect(block.children);
    }
  };
  collect(blocks);
  const moved = paths.flatMap((path) => rows.get(path) ? [rows.get(path)!] : []);
  if (!moved.length) return blocks;
  const strip = (items: ArborBlock[]): ArborBlock[] => items.flatMap((block) => {
    const path = block.type === "childPage"
      ? resolveChildReference(directory, String(block.props?.path ?? ""))
      : null;
    if (path && selected.has(path)) return [];
    return [{ ...block, children: strip(block.children) }];
  });
  const remaining = strip(blocks);
  const anchorPath = beforePath ? canonicalNodePath(beforePath) : null;
  const insert = (items: ArborBlock[]): [ArborBlock[], boolean] => {
    const result: ArborBlock[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const block = items[index]!;
      const path = block.type === "childPage"
        ? resolveChildReference(directory, String(block.props?.path ?? ""))
        : null;
      if (block.id === beforeBlockId || anchorPath && path === anchorPath) {
        return [[...result, ...moved, block, ...items.slice(index + 1)], true];
      }
      const [children, inserted] = insert(block.children);
      if (inserted) return [[...result, { ...block, children }, ...items.slice(index + 1)], true];
      result.push({ ...block, children });
    }
    return [result, false];
  };
  const [inserted, found] = insert(remaining);
  return found ? inserted : [...remaining, ...moved];
}

export function PageEditor({ node, onSaved, navigate }: {
  node: TreeNode;
  onSaved: (node: TreeNode) => void;
  navigate: (path: string) => void;
}) {
  const authored = node.document?.blocks ?? [];
  const isDirectory = node.kind === "directory" || node.kind === "collection";
  const physicalChildren = node.children ?? [];
  const childrenRevision = physicalChildren.map((child) => `${child.path}:${child.kind}:${child.materialization}`).join("\0");
  const childrenByPath = useMemo(() => new Map(physicalChildren.map((child) => [child.path, child])), [childrenRevision]);
  const implicitChildren: ArborBlock[] = isDirectory
    ? physicalChildren.filter((child) => !authored.some((block) =>
      block.type === "childPage" && resolveChildReference(node.path, String(block.props?.path ?? "")) === child.path
    )).map((child, index) => ({
      id: `implicit-${index}-${child.name}`,
      type: "childPage",
      content: child.name,
      props: { path: child.path },
      children: [],
    }))
    : [];
  const initial = [...authored, ...implicitChildren];
  const managedOrder = initial.flatMap((block) => {
    if (block.type !== "childPage") return [];
    const path = resolveChildReference(node.path, String(block.props?.path ?? ""));
    return path && childrenByPath.has(path) ? [path] : [];
  });
  const originals = useMemo(() => originalMap(initial), [node.revision, childrenRevision]);
  const pageDirectory = isDirectory ? node.path : parentPath(node.path);
  const editor = useCreateBlockNote({
    schema: arborSchema,
    initialContent: initial.length ? initial.map(toBlockNote) : [{ type: "paragraph" }],
    uploadFile: async (file) => (await api.asset(pageDirectory, file)).markdownPath,
  }, [node.path, node.revision, childrenRevision]);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [message, setMessage] = useState<string | null>(null);
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>({ ...(node.document?.frontmatter ?? {}) });
  const [recovery, setRecovery] = useState<Array<{ hash: string; markdown: string; status: string; changedAt: number }> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [creating, setCreating] = useState<"directory" | "markdown" | null>(null);
  const [createValue, setCreateValue] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragPreview, setDragPreview] = useState<{ paths: string[]; x: number; y: number } | null>(null);
  const baseBlocks = useRef(authored);
  const bodySurface = useRef<HTMLDivElement>(null);
  const pageActionsMenu = useRef<HTMLDetailsElement>(null);
  const pendingScrollRestore = useRef<{ x: number; y: number } | null>(null);
  const generation = useRef(0);
  const durableGeneration = useRef(0);
  const currentRevision = useRef(node.revision);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlight = useRef<Promise<void> | null>(null);
  const applyingHistory = useRef(false);
  const observedSnapshot = useRef<DocumentSnapshot>({ blocks: initial, frontmatter: { ...(node.document?.frontmatter ?? {}) } });
  const documentDraft = useRef<{ before: DocumentSnapshot; after: DocumentSnapshot } | null>(null);
  const documentHistoryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const applySnapshotRef = useRef<(value: DocumentSnapshot) => Promise<void>>(async () => {});
  const pushHistoryRef = useRef<(entry: HistoryEntry) => void>(() => {});
  const [, renderHistory] = useState(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onSavedPreservingScroll = useCallback((loaded: TreeNode) => {
    pendingScrollRestore.current = { x: window.scrollX, y: window.scrollY };
    onSaved(loaded);
  }, [onSaved]);

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
  }, [node.path, node.revision, childrenRevision]);

  useEffect(() => {
    setSelected(new Set());
    setSelectionAnchor(null);
    setCreating(null);
    setRenamingPath(null);
  }, [node.path]);

  const currentBlocks = () => editor.document.map((block) => fromBlockNote(block as ArborEditorBlock, originals));
  const snapshot = (nextFrontmatter = frontmatter): DocumentSnapshot => ({
    blocks: currentBlocks(),
    frontmatter: structuredClone(nextFrontmatter),
  });
  const frontmatterPatch = (value: Record<string, unknown>) => {
    const result: Record<string, unknown | null> = {};
    const before = node.document?.frontmatter ?? {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(value)])) {
      if (!(key in value)) result[key] = null;
      else if (JSON.stringify(before[key]) !== JSON.stringify(value[key])) result[key] = value[key];
    }
    return result;
  };
  const saveNowRef = useRef<(forceRevision?: string) => Promise<void>>(async () => {});
  const scheduleAutosave = useCallback((delay = AUTOSAVE_DELAY_MS) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void saveNowRef.current();
    }, delay);
  }, []);
  const markChanged = useCallback(() => {
    generation.current += 1;
    setSaveState("changed");
    scheduleAutosave();
  }, [scheduleAutosave]);

  const save = useCallback(async (forceRevision?: string) => {
    if (saveInFlight.current) {
      await saveInFlight.current;
      if (generation.current > durableGeneration.current) return saveNowRef.current(forceRevision);
      return;
    }
    const savingGeneration = generation.current;
    if (savingGeneration <= durableGeneration.current && !forceRevision) return;
    const local = currentBlocks();
    const localFrontmatter = structuredClone(frontmatter);
    const execute = async () => {
      setSaveState("saving");
      setMessage(null);
      try {
        let saved: TreeNode;
        try {
          saved = await api.write(node.path, {
            baseRevision: forceRevision ?? currentRevision.current,
            frontmatterPatch: frontmatterPatch(localFrontmatter),
            blocks: local,
          });
        } catch (error) {
          const conflict = error as Error & { status?: number; payload?: { current?: TreeNode } };
          if (conflict.status !== 409 || !conflict.payload?.current?.document) throw error;
          const current = conflict.payload.current;
          const currentDocument = current.document!;
          const merged = mergeBlocks(baseBlocks.current, local, currentDocument.blocks);
          if (merged.conflicts.length) {
            setSaveState("conflict");
            setMessage(`${merged.conflicts.length} block conflict${merged.conflicts.length === 1 ? "" : "s"}. Use the disk version or keep this version.`);
            return;
          }
          saved = await api.write(node.path, {
            baseRevision: current.revision,
            frontmatterPatch: frontmatterPatch(localFrontmatter),
            blocks: merged.blocks,
          });
          if (JSON.stringify(merged.blocks) !== JSON.stringify(local)) {
            const beforeMerge: DocumentSnapshot = { blocks: local, frontmatter: localFrontmatter };
            const afterMerge: DocumentSnapshot = { blocks: merged.blocks, frontmatter: localFrontmatter };
            applyingHistory.current = true;
            editor.replaceBlocks(editor.document, merged.blocks.length ? merged.blocks.map(toBlockNote) : [{ type: "paragraph" }]);
            applyingHistory.current = false;
            observedSnapshot.current = structuredClone(afterMerge);
            pushHistoryRef.current({
              label: "Merge external changes",
              undo: () => applySnapshotRef.current(beforeMerge),
              redo: () => applySnapshotRef.current(afterMerge),
            });
          }
          setMessage("Merged an external edit.");
        }
        currentRevision.current = saved.revision;
        baseBlocks.current = saved.document?.blocks ?? [];
        durableGeneration.current = Math.max(durableGeneration.current, savingGeneration);
        onSavedPreservingScroll(saved);
        if (generation.current === savingGeneration) setSaveState("saved");
        else {
          setSaveState("changed");
          scheduleAutosave(0);
        }
      } catch (error) {
        setSaveState("error");
        setMessage(error instanceof Error ? error.message : String(error));
      }
    };
    const running = execute().finally(() => {
      if (saveInFlight.current === running) saveInFlight.current = null;
    });
    saveInFlight.current = running;
    await running;
  }, [editor, frontmatter, node.document?.frontmatter, node.path, onSavedPreservingScroll, originals, scheduleAutosave]);
  saveNowRef.current = save;

  const flushAutosave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (generation.current > durableGeneration.current) await saveNowRef.current();
    if (saveInFlight.current) await saveInFlight.current;
    if (generation.current > durableGeneration.current) await saveNowRef.current();
    if (generation.current > durableGeneration.current) {
      throw new Error("Resolve or retry the unsaved document changes before changing the filesystem.");
    }
  }, []);

  useEffect(() => {
    currentRevision.current = node.revision;
    baseBlocks.current = authored;
    if (generation.current === durableGeneration.current) {
      const nextFrontmatter = { ...(node.document?.frontmatter ?? {}) };
      setFrontmatter(nextFrontmatter);
      observedSnapshot.current = { blocks: structuredClone(initial), frontmatter: nextFrontmatter };
      setSaveState("saved");
    }
  }, [node.path, node.revision, childrenRevision, editor]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (documentHistoryTimer.current) clearTimeout(documentHistoryTimer.current);
    void saveNowRef.current();
  }, []);

  useEffect(() => {
    const source = new EventSource("/v/events");
    source.onmessage = () => {};
    source.addEventListener("updated", async (event) => {
      const update = JSON.parse((event as MessageEvent).data) as { path: string; classification?: string };
      if (update.path !== node.path || update.classification === "echo") return;
      const loaded = await api.node(node.path);
      if (generation.current > durableGeneration.current || saveInFlight.current) {
        setSaveState("external");
        scheduleAutosave(0);
        return;
      }
      currentRevision.current = loaded.revision;
      baseBlocks.current = loaded.document?.blocks ?? [];
      onSavedPreservingScroll(loaded);
      setSaveState("saved");
    });
    return () => source.close();
  }, [node.path, onSavedPreservingScroll, scheduleAutosave]);

  const pushHistory = useCallback((entry: HistoryEntry) => {
    undoStack.current.push(entry);
    redoStack.current = [];
    renderHistory((value) => value + 1);
  }, []);
  pushHistoryRef.current = pushHistory;
  const flushDocumentHistory = useCallback(() => {
    if (documentHistoryTimer.current) {
      clearTimeout(documentHistoryTimer.current);
      documentHistoryTimer.current = null;
    }
    const draft = documentDraft.current;
    documentDraft.current = null;
    if (!draft || JSON.stringify(draft.before) === JSON.stringify(draft.after)) return;
    pushHistory({
      label: "Edit document",
      undo: () => applySnapshotRef.current(draft.before),
      redo: () => applySnapshotRef.current(draft.after),
    });
  }, [pushHistory]);
  const recordDocumentSnapshot = useCallback((after: DocumentSnapshot) => {
    if (applyingHistory.current) {
      observedSnapshot.current = after;
      return;
    }
    const before = observedSnapshot.current;
    observedSnapshot.current = after;
    if (!documentDraft.current) documentDraft.current = { before, after };
    else documentDraft.current.after = after;
    if (documentHistoryTimer.current) clearTimeout(documentHistoryTimer.current);
    documentHistoryTimer.current = setTimeout(flushDocumentHistory, AUTOSAVE_DELAY_MS);
  }, [flushDocumentHistory]);
  const applySnapshot = useCallback(async (value: DocumentSnapshot) => {
    applyingHistory.current = true;
    editor.replaceBlocks(editor.document, value.blocks.length ? value.blocks.map(toBlockNote) : [{ type: "paragraph" }]);
    setFrontmatter(structuredClone(value.frontmatter));
    observedSnapshot.current = structuredClone(value);
    generation.current += 1;
    setSaveState("changed");
    scheduleAutosave(0);
    applyingHistory.current = false;
  }, [editor, scheduleAutosave]);
  applySnapshotRef.current = applySnapshot;

  const undo = useCallback(async () => {
    flushDocumentHistory();
    const entry = undoStack.current.at(-1);
    if (!entry) return;
    try {
      setMessage(null);
      await entry.undo();
      undoStack.current.pop();
      redoStack.current.push(entry);
      renderHistory((value) => value + 1);
    } catch (error) {
      setMessage(`Could not undo ${entry.label.toLowerCase()}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [flushDocumentHistory]);
  const redo = useCallback(async () => {
    const entry = redoStack.current.at(-1);
    if (!entry) return;
    try {
      setMessage(null);
      await entry.redo();
      redoStack.current.pop();
      undoStack.current.push(entry);
      renderHistory((value) => value + 1);
    } catch (error) {
      setMessage(`Could not redo ${entry.label.toLowerCase()}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const reload = useCallback(async (nextSelection: string[] = []) => {
    const loaded = await api.node(node.path);
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
      const result = await api.mutate({ operations });
      await reload(nextSelection);
      let undoOperations: FsMutation[] = [];
      let redoOperations: FsMutation[] = operations;
      let undoSelection: string[] = [];
      let redoSelection = nextSelection;
      if (result.created.length) {
        undoOperations = [{ op: "trash", paths: result.created }];
        redoOperations = [{ op: "restore", paths: result.created.map(trashedPath) }];
        redoSelection = result.created;
      } else if (result.deleted.length) {
        undoOperations = [{ op: "restore", paths: result.deleted.map(trashedPath) }];
        undoSelection = result.deleted;
      } else if (result.moved.length) {
        undoOperations = inverseMoves(result.moved);
        undoSelection = result.moved.map((item) => item.from);
        redoSelection = result.moved.map((item) => item.to);
      } else {
        const reorder = operations.find((operation): operation is Extract<FsMutation, { op: "move" }> => operation.op === "move");
        if (reorder && reorder.paths.every((path) => parentPath(path) === reorder.destination)) {
          const selectedPaths = new Set(reorder.paths);
          const lastIndex = Math.max(...reorder.paths.map((path) => beforeOrder.indexOf(path)));
          const beforePath = beforeOrder.slice(lastIndex + 1).find((path) => !selectedPaths.has(path));
          const selectedBlockIndexes = beforeBlocks.flatMap((block, index) => {
            const path = block.type === "childPage" ? resolveChildReference(node.path, String(block.props?.path ?? "")) : null;
            return path && selectedPaths.has(path) ? [index] : [];
          });
          const beforeBlockId = beforeBlocks.slice(Math.max(...selectedBlockIndexes, -1) + 1).find((block) => {
            const path = block.type === "childPage" ? resolveChildReference(node.path, String(block.props?.path ?? "")) : null;
            return !path || !selectedPaths.has(path);
          })?.id;
          undoOperations = [{
            op: "move",
            paths: beforeOrder.filter((path) => selectedPaths.has(path)),
            destination: reorder.destination,
            beforePath,
            beforeBlockId,
          }];
          undoSelection = reorder.paths;
        }
      }
      if (undoOperations.length) {
        const execute = async (request: FsMutation[], selection: string[]) => {
          await flushAutosave();
          await api.mutate({ operations: request });
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
      const result = await api.import(destination, entries);
      const nextSelection = destination === node.path ? importedTopLevel(destination, entries) : [];
      await reload(nextSelection);
      if (result.created.length) {
        const created = result.created;
        const execute = async (operations: FsMutation[], selection: string[]) => {
          await flushAutosave();
          await api.mutate({ operations });
          await reloadRef.current(selection);
        };
        pushHistory({
          label: "import",
          undo: () => execute([{ op: "trash", paths: created }], []),
          redo: () => execute([{ op: "restore", paths: created.map(trashedPath) }], created),
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
    const preview = moveManagedRows(before, node.path, paths, beforePath, beforeBlockId);
    applyingHistory.current = true;
    editor.replaceBlocks(editor.document, preview.length ? preview.map(toBlockNote) : [{ type: "paragraph" }]);
    applyingHistory.current = false;
    try {
      return await runMutation(
        [{ op: "move", paths, destination: node.path, beforePath, beforeBlockId }],
        paths,
        before,
      );
    } catch (error) {
      applyingHistory.current = true;
      editor.replaceBlocks(editor.document, before.length ? before.map(toBlockNote) : [{ type: "paragraph" }]);
      applyingHistory.current = false;
      throw error;
    }
  }, [editor, flushAutosave, flushDocumentHistory, node.path, runMutation]);

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
      await runMutation([{ op: "move", paths, destination: targetPath }], moved);
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
        const block = pointTarget?.closest<HTMLElement>('[data-node-type="blockContainer"][data-id]');
        if (!block) return;
        const bounds = block.getBoundingClientRect();
        let beforeBlockId = block.dataset.id;
        if ((event.clientY - bounds.top) / Math.max(1, bounds.height) > 0.5) {
          beforeBlockId = block.nextElementSibling instanceof HTMLElement ? block.nextElementSibling.dataset.id : undefined;
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
    try { await runMutation([{ op: "rename", path, name }], [next]); } catch {}
  }, [renameValue, renamingPath, runMutation]);

  const trashSelection = useCallback(async (focusPath?: string) => {
    const paths = focusPath && !selected.has(focusPath)
      ? [focusPath]
      : managedOrder.filter((path) => selected.has(path));
    if (!paths.length || !confirm(`Move ${paths.length === 1 ? paths[0] : `${paths.length} items`} to Trash?`)) return;
    try { await runMutation([{ op: "trash", paths }]); } catch {}
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
      const path = resolveChildReference(node.path, rawPath);
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
    if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    event.preventDefault();
    const base = isDirectory ? `${node.path === "/" ? "" : node.path}/` : `${parentPath(node.path) === "/" ? "" : parentPath(node.path)}/`;
    navigate(canonicalNodePath(new URL(href.split("#")[0]!, `http://arbor${base}`).pathname));
  };
  const closePageActions = () => {
    if (pageActionsMenu.current) pageActionsMenu.current.open = false;
  };

  return <div className="editor-shell">
    <div className="properties">
      <div className="properties-heading">Properties</div>
      {keys.map((key) => <label key={key}><span>{key}</span><input value={String(frontmatter[key] ?? "")} disabled={key === "id"} onChange={(event) => {
        const next = { ...frontmatter, [key]: event.target.value };
        setFrontmatter(next);
        recordDocumentSnapshot(snapshot(next));
        markChanged();
      }} /></label>)}
      <button className="quiet" onClick={() => {
        const key = prompt("Property name");
        if (key) {
          const next = { ...frontmatter, [key]: "" };
          setFrontmatter(next);
          recordDocumentSnapshot(snapshot(next));
          markChanged();
        }
      }}>+ property</button>
    </div>
    {isDirectory && <details className="page-actions-menu" ref={pageActionsMenu}>
      <summary aria-label="Page actions" title="Page actions">•••</summary>
      <div role="menu">
        <button role="menuitem" title="New Markdown Page (⌘N)" onClick={() => { closePageActions(); setCreating("markdown"); setCreateValue(""); }}>New Page</button>
        <button role="menuitem" title="New Folder (⇧⌘N)" onClick={() => { closePageActions(); setCreating("directory"); setCreateValue(""); }}>New Folder</button>
        <div className="menu-separator" />
        <button role="menuitem" title="Rename (Enter)" disabled={selected.size !== 1} onClick={() => { closePageActions(); startRename(); }}>Rename</button>
        <button role="menuitem" title="Move to Trash (⌘⌫)" disabled={!selected.size} className="danger" onClick={() => { closePageActions(); void trashSelection(); }}>Move to Trash</button>
      </div>
    </details>}
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
              void runMutation([{ op: "move", paths, destination: node.path }], paths);
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
        <BlockNoteView editor={editor} sideMenu={false} onChange={() => {
          if (applyingHistory.current) return;
          const shorthand = editor.document.find((block) => block.type === "paragraph" && blockText(block as ArborEditorBlock).startsWith("▸ ")) as ArborEditorBlock | undefined;
          if (shorthand) editor.updateBlock(shorthand, { type: "toggleListItem", content: blockText(shorthand).slice(2) });
          const next = snapshot();
          recordDocumentSnapshot(next);
          markChanged();
        }} data-theming-css-variables-demo>
          <SideMenuController sideMenu={ArborSideMenu} />
        </BlockNoteView>
      </div>
    </ManagedRowsContext.Provider>
    {dragPreview && <div className="managed-drag-preview" style={{ left: dragPreview.x, top: dragPreview.y }}>
      <span>↗</span>
      {dragPreview.paths.length === 1 ? dragPreview.paths[0]!.slice(dragPreview.paths[0]!.lastIndexOf("/") + 1) : `${dragPreview.paths.length} pages`}
    </div>}
    <div className="editor-actions">
      {message && <span className="warning">{message}</span>}
      {saveState === "conflict" && <button onClick={async () => {
        const local = snapshot();
        const loaded = await api.node(node.path);
        const disk: DocumentSnapshot = {
          blocks: loaded.document?.blocks ?? [],
          frontmatter: { ...(loaded.document?.frontmatter ?? {}) },
        };
        flushDocumentHistory();
        pushHistory({
          label: "Use disk version",
          undo: () => applySnapshotRef.current(local),
          redo: () => applySnapshotRef.current(disk),
        });
        generation.current = durableGeneration.current;
        currentRevision.current = loaded.revision;
        baseBlocks.current = disk.blocks;
        setMessage(null);
        setSaveState("saved");
        onSavedPreservingScroll(loaded);
      }}>Use disk</button>}
      {saveState === "conflict" && <button onClick={async () => save((await api.node(node.path)).revision)}>Keep mine</button>}
      <button className="quiet" disabled={!undoStack.current.length && !documentDraft.current} title="Undo (⌘Z)" onClick={() => void undo()}>Undo</button>
      <button className="quiet" disabled={!redoStack.current.length} title="Redo (⇧⌘Z)" onClick={() => void redo()}>Redo</button>
      <button className="quiet" onClick={async () => setRecovery(await api.recovery(node.path))}>Recover</button>
      <span className={`save-state ${saveState}`} role="status">{
        saveState === "saving" ? "Saving…"
          : saveState === "changed" ? "Changes pending"
            : saveState === "external" ? "External changes"
              : saveState === "conflict" ? "Conflict"
                : saveState === "error" ? "Save failed"
                  : "Saved"
      }</span>
      {(saveState === "error" || saveState === "external") && <button className="retry-save" onClick={() => void save()}>Retry</button>}
    </div>
    {recovery && <div className="recovery"><div className="recovery-title"><strong>Recover blocks</strong><button className="quiet" onClick={() => setRecovery(null)}>Close</button></div>{!recovery.length && <p>Nothing recoverable for this page.</p>}{recovery.map((entry) => <div className="recovery-entry" key={entry.hash}><div><span>{entry.status}</span><pre>{entry.markdown}</pre></div><button onClick={async () => { onSavedPreservingScroll(await api.restoreBlock(node.path, entry.hash)); setRecovery(await api.recovery(node.path)); }}>Restore</button></div>)}</div>}
  </div>;
}
