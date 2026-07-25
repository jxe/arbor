import {
  ArbordClient,
  type ArborBlock,
  type MutationEffect,
  type MutationReceipt,
  type NodeRef,
  type NodeSnapshot,
  type StructuralWorkspaceOperation,
} from "@arbor/client";

export interface BrowserImportEntry {
  path: string;
  kind: "file" | "directory";
  file?: File;
}

export interface BrowserMutationResult {
  receipt: MutationReceipt;
  created: string[];
  updated: string[];
  moved: Array<{ from: string; to: string }>;
  deleted: string[];
}

function result(receipt: MutationReceipt): BrowserMutationResult {
  return {
    receipt,
    created: receipt.effects.filter((effect) => effect.kind === "created").map((effect) => effect.path),
    updated: receipt.effects.filter((effect) => effect.kind === "updated").map((effect) => effect.path),
    moved: receipt.effects.flatMap((effect) =>
      effect.kind === "moved" && effect.previousPath ? [{ from: effect.previousPath, to: effect.path }] : []
    ),
    deleted: receipt.effects.filter((effect) => effect.kind === "deleted").map((effect) => effect.path),
  };
}

const client = new ArbordClient();
const refOf = (value: string | NodeRef): NodeRef => typeof value === "string" ? { path: value } : value;

export type BrowserOperation = StructuralWorkspaceOperation;
export type BrowserEffect = MutationEffect;

export const api = {
  client,
  node: (ref: string | NodeRef) => client.node(refOf(ref)),
  openNodeView: (ref: string | NodeRef, signal?: AbortSignal) => client.openNodeView(refOf(ref), signal),
  collection: async (path: string, cursor?: string | null) => client.collection({ path }, cursor),
  search: async (query: string) => (await client.search(query)).results,
  write: async (
    ref: string | NodeRef,
    body: {
      baseContentRevision: string;
      frontmatterPatch?: Record<string, unknown | null>;
      blocks: ArborBlock[];
    },
  ): Promise<NodeSnapshot> => {
    await client.mutateContent({
      op: "writeMarkdown",
      ref: refOf(ref),
      baseContentRevision: body.baseContentRevision,
      frontmatterPatch: body.frontmatterPatch,
      blocks: body.blocks,
    });
    return client.node(refOf(ref));
  },
  mutate: async (body: { operations: StructuralWorkspaceOperation[] }) => result(await client.mutateStructural(body.operations)),
  import: async (destination: string, entries: BrowserImportEntry[]) => result(await client.import({ path: destination }, entries)),
  recovery: async (ref: string | NodeRef) => (await client.recovery(refOf(ref))).entries,
  restoreBlock: async (ref: string | NodeRef, hash: string) => {
    await client.mutateContent({ op: "restoreRecovery", ref: refOf(ref), hash });
    return client.node(refOf(ref));
  },
  asset: async (directory: string, file: File) => client.asset({ path: directory }, file),
};
