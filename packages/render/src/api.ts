import {
  ArborSyncRESTClient,
  type BacklinkEntry,
  type MutationEffect,
  type MutationReceipt,
  type NodeRef,
  type NodeSnapshot,
  type RecoveryEntry,
  type StructuralWorkspaceOperation,
  type TreeRef,
} from "@arbor/client";
import { activeDevices, applyConfigurationAction, configurationAccessEntries, configurationStatus, revokeActiveDevice, type ConfigurationAction } from "./configuration.ts";

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
    created: receipt.effects.filter((effect) => effect.kind === "created").map((effect) => effect.ref.path),
    updated: receipt.effects.filter((effect) => effect.kind === "updated").map((effect) => effect.ref.path),
    moved: receipt.effects.flatMap((effect) =>
      effect.kind === "moved" && effect.previousPath ? [{ from: effect.previousPath, to: effect.ref.path }] : []
    ),
    deleted: receipt.effects.filter((effect) => effect.kind === "deleted").map((effect) => effect.ref.path),
  };
}

const client = new ArborSyncRESTClient();

export type BrowserOperation = StructuralWorkspaceOperation;
export type BrowserEffect = MutationEffect;

/**
 * The api surface, scoped to one tree. Every reference or path-literal
 * operation lacking an explicit scope is qualified with `tree`, so a
 * component operating inside one node's scope stays in that scope for its
 * lifetime — an in-flight save never follows a navigation into another
 * root. `scoped(undefined)` is the session-root scope (legacy behavior).
 */
function makeApi(tree: TreeRef = "local") {
  const refOf = (value: string | NodeRef): NodeRef => {
    if (typeof value === "string") return { tree, path: value, stableKey: null };
    return value;
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
    if ((scoped.op === "createMarkdown" || scoped.op === "createDirectory") && scoped.tree === undefined) {
      scoped.tree = tree;
    }
    return scoped;
  };
  return {
    client,
    tree,
    scoped: (nextTree: TreeRef | undefined) => makeApi(nextTree ?? "local"),
    node: (ref: string | NodeRef) => client.node(refOf(ref)),
    openNodeView: (ref: string | NodeRef, signal?: AbortSignal) => client.openNodeView(refOf(ref), signal),
    children: (ref: string | NodeRef, cursor?: string | null) => client.children(refOf(ref), cursor),
    search: async (query: string, scope?: TreeRef) => (await client.search(scope ?? tree, query)).results,
    configure: (operation: ConfigurationAction) => applyConfigurationAction(client, operation),
    configurationStatus: () => configurationStatus(client),
    configurationAccess: (treeID: string) => configurationAccessEntries(client, treeID),
    activeDevices: () => activeDevices(client),
    revokeDevice: (id: string) => revokeActiveDevice(client, id),
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
export const api: ScopedApi = makeApi("local");
