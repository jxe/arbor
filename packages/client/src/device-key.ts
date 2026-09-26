import {
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  hashObject,
  HostAccountStore,
  ProtocolClient,
  ProtocolHTTPError,
  withDeviceKey,
  type HostAccountRecord,
} from "@overstory/protocol";

/**
 * Move this installation's device for one account to a key (accounts §5.2):
 * prepare the key, submit the update that adds it to the device's own
 * `devices.yaml` entry with the current credential, and adopt it. A move that
 * already reached the host, or an earlier interrupted one, only adopts.
 */
export async function moveToDeviceKey(configurationTree: string): Promise<HostAccountRecord> {
  const store = new HostAccountStore(configurationTree);
  const connection = await store.get();
  if (!connection) throw new Error(`No account connection for ${configurationTree}`);
  if (connection.record.deviceKey) return connection.record;
  const { record, accountToken } = connection;
  const key = await store.prepareDeviceKey();
  const client = new ProtocolClient(record.origin, accountToken);
  try {
    const { tree, snapshot } = await client.treeConfiguration(record.profileTree);
    const root = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
    const entry = root.entries.find((candidate) => candidate.name === "devices.yaml");
    if (!entry?.file) throw new Error("The profile's configuration has no devices.yaml");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.objects.get(entry.file)!);
    const bytes = new TextEncoder().encode(withDeviceKey(source, record.deviceID, key));
    const file = hashObject(bytes);
    const directory = encodeProtocolDirectory({ ...root, entries: root.entries.map((candidate) => candidate.name === "devices.yaml" ? { name: candidate.name, file } : candidate) });
    const next = { root: hashObject(directory), objects: new Map([[file, bytes], [hashObject(directory), directory]]) };
    await client.submitUpdate(tree.id, tree.update, next);
  } catch (error) {
    // The credential stops working in the commit that lists the key; adopt if that already happened.
    if (!(error instanceof ProtocolHTTPError && error.status === 401)) throw error;
  }
  await store.forgetSession();
  const adopted = await store.get();
  if (!adopted?.record.deviceKey) throw new Error("The host did not accept this device's key");
  return adopted.record;
}
