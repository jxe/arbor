import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CanopyAccountStore, saveCurrentAccountDeviceID, type WireClient } from "@overstory/protocol";
import { readAccountConfigGraph } from "@overstory/protocol";

/** Install the host's actual v2 checkout and local-only placements in a disposable home. */
export async function installAccountHome(home: string, client: WireClient, device: string, credential: string, placements: Record<string, string>) {
  const { account } = await client.account();
  const configurationTree = account.configuration.id;
  const descriptor = await client.descriptor(configurationTree);
  const snapshot = await client.snapshot(configurationTree, descriptor.tree.root);
  const graph = readAccountConfigGraph(snapshot, configurationTree);
  const checkout = join(home, "accounts", configurationTree);
  await mkdir(checkout, { recursive: true });
  for (const [path, source] of Object.entries(graph.sources)) await writeFile(join(checkout, path), source);
  await writeFile(join(home, "placements.yaml"), JSON.stringify({ [configurationTree]: placements }));
  process.env.ARBOR_DATA_HOME = home;
  await saveCurrentAccountDeviceID(configurationTree, device);
  await new CanopyAccountStore(configurationTree).set(credential, {
    origin: graph.account.canopy, account: `${graph.account.canopy}/~${account.handle}`,
    accountID: account.id, handle: account.handle!, profileTree: account.profileTree!, deviceID: device,
    configurationRef: descriptor.tree.root, configurationUpdate: descriptor.tree.update,
  });
}
