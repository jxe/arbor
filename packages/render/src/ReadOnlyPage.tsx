import { useMemo } from "react";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import type { NodeSnapshot } from "@arbor/client";
import type { NodeSummary } from "@arbor/core";
import { resolveLogicalURL } from "@arbor/core/logical-url";
import {
  ManagedRowsContext,
  arborEditorExtensions,
  arborSchema,
  toBlockNote,
  type ManagedRowsController,
} from "./blocks.tsx";
import { nodeDocument, presentationKind } from "./node-presentation.ts";

export function ReadOnlyPage({ node, children: childItems, navigate }: {
  node: NodeSnapshot;
  children: NodeSummary[];
  navigate: (path: string) => void;
}) {
  const document = nodeDocument(node);
  const blocks = document?.blocks ?? [];
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
  }, [node.ref.tree, node.ref.path, node.capabilities.content?.revision, node.capabilities.children?.revision]);

  const children = useMemo(() => new Map(childItems.map((child) => [child.ref.path, child])), [childItems]);
  const managedRows = useMemo<ManagedRowsController>(() => ({
    resolve: (rawPath) => {
      const link = resolveLogicalURL(node.ref.path, rawPath);
      return link?.kind === "local" && children.has(link.path) ? link.path : null;
    },
    kind: (path) => {
      const child = children.get(path);
      return child ? presentationKind(child) : null;
    },
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
  }), [children, node.ref.path]);

  return <div className="editor-shell read-only-page" aria-label="Read-only remote page">
    <ManagedRowsContext.Provider value={managedRows}>
      <div className="body-drop-surface" onClickCapture={(event) => {
        const anchor = (event.target as Element).closest("a");
        const href = anchor?.getAttribute("href");
        if (!href) return;
        const link = resolveLogicalURL(node.ref.path, href);
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
