import {
  generateArborID,
  readTreeConfigGraph,
  snapshotTreeConfig,
  type ProtocolClient,
  type ResourceAccessRule,
  type TreeConfigKind,
  type TreeConfigValues,
  type TreeSnapshot,
} from "@overstory/protocol";

/** A tree's accepted configuration values, read as one of its administrators. */
export async function readTreeConfig(client: ProtocolClient, tree: string, kind: TreeConfigKind): Promise<{ values: TreeConfigValues; update: string }> {
  const { tree: descriptor, snapshot } = await client.treeConfiguration(tree);
  return { values: readTreeConfigGraph(snapshot, kind, tree), update: descriptor.update };
}

/** Edit a tree's configuration as one of its administrators. */
export async function editTreeConfig(
  client: ProtocolClient,
  tree: string,
  kind: TreeConfigKind,
  change: (values: TreeConfigValues) => TreeConfigValues,
) {
  const { tree: descriptor, snapshot } = await client.treeConfiguration(tree);
  const values = change(readTreeConfigGraph(snapshot, kind, tree));
  return client.submitUpdate(descriptor.id, descriptor.update, snapshotTreeConfig(values));
}

/**
 * Declare, mount and activate a tree as `client`'s profile, the way a client
 * places a new folder: its configuration makes that profile its administrator
 * and adds `access`; its parent then mounts it at `name`; its first snapshot
 * activates it.
 */
export async function hostTree(
  client: ProtocolClient,
  snapshot: TreeSnapshot,
  options: {
    access?: ResourceAccessRule[];
    parent?: { tree: string; name: string; kind: TreeConfigKind };
    tree?: string;
    administrators?: string[];
  } = {},
): Promise<string> {
  const { account } = await client.account();
  const tree = options.tree ?? generateArborID("tr");
  const admins = options.administrators ?? [account.profileTree!];
  await client.declareTree(tree, snapshotTreeConfig({
    access: [...admins.map((profile) => ({ who: { profile }, allow: ["admin" as const] })), ...(options.access ?? [])],
    mounts: {},
  }));
  if (options.parent) {
    const { name } = options.parent;
    await editTreeConfig(client, options.parent.tree, options.parent.kind, (values) => ({ ...values, mounts: { ...values.mounts, [name]: tree } }));
  }
  await client.submitUpdate(tree, null, snapshot);
  return tree;
}
