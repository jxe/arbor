import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostAccountStore, readTreeConfigGraph, saveCurrentAccountDeviceID, type ProtocolClient } from "@overstory/protocol";

/** Install the host's actual account checkout (the profile's configuration) and local-only placements in a disposable home. */
export async function installAccountHome(home: string, client: ProtocolClient, device: string, credential: string, placements: Record<string, string>) {
  const { account } = await client.account();
  const configurationTree = account.configuration.id;
  const descriptor = await client.descriptor(configurationTree);
  const snapshot = await client.snapshot(configurationTree, descriptor.tree.root);
  const graph = readTreeConfigGraph(snapshot, "person", account.profileTree!);
  const checkout = join(home, "accounts", configurationTree);
  await mkdir(checkout, { recursive: true });
  for (const [path, source] of Object.entries(graph.sources)) await writeFile(join(checkout, path), source);
  await writeFile(join(home, "placements.yaml"), JSON.stringify({ [configurationTree]: placements }));
  process.env.ARBOR_DATA_HOME = home;
  await saveCurrentAccountDeviceID(configurationTree, device);
  const origin = new URL(account.community.canonical!.endpoint).origin;
  await new HostAccountStore(configurationTree).set(credential, {
    origin, account: `${origin}/~${account.handle}`,
    accountID: account.id, handle: account.handle!, profileTree: account.profileTree!, deviceID: device,
    configurationRef: descriptor.tree.root, configurationUpdate: descriptor.tree.update,
  });
}
