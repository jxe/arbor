import {
  ArbordClient,
  type BacklinkEntry,
  type MutationEffect,
  type MutationReceipt,
  type NodeRef,
  type NodeSnapshot,
  type RecoveryEntry,
  type StructuralWorkspaceOperation,
  type TreeRef,
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

export type BrowserOperation = StructuralWorkspaceOperation;
export type BrowserEffect = MutationEffect;

/**
 * The api surface, scoped to one tree. Every reference or path-literal
 * operation lacking an explicit scope is qualified with `tree`, so a
 * component operating inside one node's scope stays in that scope for its
 * lifetime — an in-flight save never follows a navigation into another
 * root. `scoped(undefined)` is the session-root scope (legacy behavior).
 */
function makeApi(tree: TreeRef | undefined) {
  const refOf = (value: string | NodeRef): NodeRef => {
    const ref = typeof value === "string" ? { path: value } : value;
    return ref.tree !== undefined || tree === undefined ? ref : { ...ref, tree };
  };
  const scopeOperation = (operation: StructuralWorkspaceOperation): StructuralWorkspaceOperation => {
    const scoped = { ...operation } as StructuralWorkspaceOperation & {
      ref?: NodeRef;
      refs?: NodeRef[];
      destination?: NodeRef;
      tree?: TreeRef;
    };
    if (scoped.ref) scoped.ref = refOf(scoped.ref);
    if (scoped.refs) scoped.refs = scoped.refs.map(refOf);
    if (scoped.destination) scoped.destination = refOf(scoped.destination);
    if ((scoped.op === "createMarkdown" || scoped.op === "createDirectory") && scoped.tree === undefined && tree !== undefined) {
      scoped.tree = tree;
    }
    return scoped;
  };
  return {
    client,
    tree,
    scoped: (nextTree: TreeRef | undefined) => makeApi(nextTree),
    node: (ref: string | NodeRef) => client.node(refOf(ref)),
    openNodeView: (ref: string | NodeRef, signal?: AbortSignal) => client.openNodeView(refOf(ref), signal),
    collection: async (path: string, cursor?: string | null) => client.collection(refOf(path), cursor),
    search: async (query: string, scope?: TreeRef) => (await client.search(query, null, scope ?? tree)).results,
    system: (operation: import("@arbor/core").SystemOperation) => client.mutateSystem(operation),
    write: async (
      ref: string | NodeRef,
      body: {
        baseContentRevision: string;
        source: string;
      },
    ): Promise<NodeSnapshot> => {
      await client.mutateContent({
        op: "writeMarkdown",
        ref: refOf(ref),
        baseContentRevision: body.baseContentRevision,
        source: body.source,
      });
      return client.node(refOf(ref));
    },
    mutate: async (body: { operations: StructuralWorkspaceOperation[] }) =>
      result(await client.mutateStructural(body.operations.map(scopeOperation))),
    import: async (destination: string, entries: BrowserImportEntry[]) =>
      result(await client.import(refOf(destination), entries)),
    backlinks: async (ref: string | NodeRef): Promise<BacklinkEntry[]> =>
      (await client.backlinks(refOf(ref))).entries,
    recovery: async (
      ref: string | NodeRef,
      recursive = false,
    ): Promise<RecoveryEntry[]> => (await client.recovery(refOf(ref), { recursive })).entries,
    restoreBlock: async (ref: string | NodeRef, hash: string) => {
      await client.mutateContent({ op: "restoreRecovery", ref: refOf(ref), hash });
      return client.node(refOf(ref));
    },
    restoreTrash: async (ref: NodeRef) => {
      await client.mutateStructural([{ op: "restore", refs: [refOf(ref)] }]);
    },
    asset: async (directory: string, file: File) => client.asset(refOf(directory), file),
  };
}

export type ScopedApi = ReturnType<typeof makeApi>;

/** The session-scope api; components inside another scope use `api.scoped(tree)`. */
export const api: ScopedApi = makeApi(undefined);
