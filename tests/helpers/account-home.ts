import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostAccountStore, readTreeConfigGraph, saveCurrentAccountDeviceID, type ProtocolClient } from "@ovst/protocol";

/** Install the host's actual account checkout (the profile's configuration), local-only placements, and the device's key seed in a disposable home. */
export async function installAccountHome(home: string, client: ProtocolClient, device: string, seed: string, placements: Record<string, string>) {
  const { account } = await client.account();
  const configurationTree = account.configuration.id;
  const descriptor = await client.descriptor(configurationTree);
  const snapshot = await client.snapshot(configurationTree, descriptor.tree.root);
  const graph = readTreeConfigGraph(snapshot, "person", account.profileTree!);
  const checkout = join(home, "configurations", configurationTree);
  await mkdir(checkout, { recursive: true });
  for (const [path, source] of Object.entries(graph.sources)) await writeFile(join(checkout, path), source);
  await writeFile(join(home, "placements.yaml"), JSON.stringify({ [configurationTree]: placements }));
  process.env.STORY_HOME = home;
  // Also outside the test preload (the protocol conformance run): the
  // credential stays in the disposable home, never in the OS credential store.
  process.env.STORY_CREDENTIAL_STORE = "file";
  await saveCurrentAccountDeviceID(configurationTree, device);
  const origin = new URL(account.community.canonical!.endpoint).origin;
  await new HostAccountStore(configurationTree).setDeviceKey(seed, {
    origin, account: `${origin}/~${account.handle}`,
    accountID: account.id, handle: account.handle!, profileTree: account.profileTree!, deviceID: device,
    configurationRef: descriptor.tree.root, configurationUpdate: descriptor.tree.update,
  });
}
