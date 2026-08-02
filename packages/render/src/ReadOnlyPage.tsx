import { useMemo } from "react";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import type { NodeSnapshot, ProjectedDocument } from "@arbor/client";
import { resolveLogicalURL } from "@arbor/core/logical-url";
import {
  ManagedRowsContext,
  arborEditorExtensions,
  arborSchema,
  toBlockNote,
  type ManagedRowsController,
} from "./blocks.tsx";

export function ReadOnlyPage({ node, projection, navigate }: {
  node: NodeSnapshot;
  projection: ProjectedDocument | null;
  navigate: (path: string) => void;
}) {
  const blocks = projection?.visibleBlocks ?? node.document?.blocks ?? [];
  const editor = useMemo(() => {
    const instance = BlockNoteEditor.create({
      schema: arborSchema,
      initialContent: [{ type: "paragraph" }],
      extensions: arborEditorExtensions,
    });
    instance.transact((transaction) => {
      transaction.setMeta("addToHistory", false);
      instance.replaceBlocks(
        instance.document,
        blocks.length ? blocks.map((block) => toBlockNote(block, instance)) : [{ type: "paragraph" }],
      );
    });
    instance.isEditable = false;
    return instance;
  }, [node.tree, node.path, node.contentRevision, node.directoryRevision]);

  const children = useMemo(() => new Map((node.children ?? []).map((child) => [child.path, child])), [node.directoryRevision]);
  const managedRows = useMemo<ManagedRowsController>(() => ({
    resolve: (rawPath) => {
      const link = resolveLogicalURL(node.path, rawPath);
      return link?.kind === "local" && children.has(link.path) ? link.path : null;
    },
    kind: (path) => children.get(path)?.kind ?? null,
    selected: () => false,
    select: () => {},
    rename: () => {},
    trash: () => {},
    drop: () => {},
    renamingPath: null,
    renameValue: "",
    setRenameValue: () => {},
    commitRename: () => {},
    cancelRename: () => {},
  }), [children, node.path]);

  return <div className="editor-shell read-only-page" aria-label="Read-only remote page">
    <ManagedRowsContext.Provider value={managedRows}>
      <div className="body-drop-surface" onClickCapture={(event) => {
        const anchor = (event.target as Element).closest("a");
        const href = anchor?.getAttribute("href");
        if (!href) return;
        const link = resolveLogicalURL(node.path, href);
        if (link?.kind !== "local") return;
        event.preventDefault();
        navigate(link.path);
      }}>
        <BlockNoteView
          editor={editor}
          editable={false}
          sideMenu={false}
          formattingToolbar={false}
          slashMenu={false}
          data-theming-css-variables-demo
        />
      </div>
    </ManagedRowsContext.Provider>
  </div>;
}
