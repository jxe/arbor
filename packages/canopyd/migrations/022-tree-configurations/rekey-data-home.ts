import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import {
  HostAccountStore,
  ProtocolClient,
  arborDataRoot,
  arborPrivateRoot,
  readTreeConfigGraph,
  saveCurrentAccountDeviceID,
  treeConfigurationID,
} from "@overstory/protocol";
import { materializeTree } from "@overstory/fs";

/**
 * The data-home half of migration 022, run on each Mac after the host is
 * migrated and before Arbor Sync starts again. Each account a schema-21 data
 * home holds (`accounts/<configuration TreeID>/` with `account.yaml`,
 * `trees.yaml` and `devices.yaml`) becomes its profile's configuration:
 *
 * - its checkout is the profile configuration the host now serves, at the
 *   derived TreeID, downloaded with the account's own credential;
 * - its connection record and credential are saved again under the new
 *   TreeID (the device credential itself is unchanged), then the old record
 *   and credential entry are removed;
 * - its placements, current device and per-tree sync metadata move to the
 *   new TreeID, so placed folders resume at their accepted bases;
 * - the old checkout is kept under `.state/migration/022/`, never deleted.
 *
 * It refuses an account whose host does not yet serve the new configuration,
 * and changes nothing for an account already rekeyed. A rerun is a no-op.
 */
export interface RekeyReport {
  accounts: Array<{ from: string; to: string; profile: string; origin: string; placements: number; rekeyed: boolean }>;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

export async function rekeyDataHome(): Promise<RekeyReport> {
  const report: RekeyReport = { accounts: [] };
  const placementsPath = join(arborDataRoot(), "placements.yaml");
  for (const record of await HostAccountStore.list()) {
    const from = record.configurationTree;
    const to = treeConfigurationID(record.profileTree);
    if (from === to) {
      report.accounts.push({ from, to, profile: record.profileTree, origin: record.origin, placements: 0, rekeyed: false });
      continue;
    }
    const connection = await new HostAccountStore(from).get();
    if (!connection) throw new Error(`The credential of account ${from} is unavailable; unlock the credential store and run again`);
    const wire = new ProtocolClient(record.origin, connection.accountToken);
    const { account } = await wire.account();
    if (account.configuration.id !== to || account.profileTree !== record.profileTree) {
      throw new Error(`${record.origin} does not serve profile ${record.profileTree}'s configuration yet; migrate the host first`);
    }
    const current = await wire.descriptor(to);
    const snapshot = await wire.snapshot(to, current.tree.root);
    readTreeConfigGraph(snapshot, "person", record.profileTree);

    // The new checkout, installed whole or not at all.
    const checkout = join(arborDataRoot(), "accounts", to);
    if (await exists(checkout)) throw new Error(`${checkout} already exists; move it aside and run again`);
    const staging = join(arborPrivateRoot(), `rekey-checkout-${crypto.randomUUID()}`);
    try {
      await materializeTree(staging, snapshot.root, async (hash) => {
        const bytes = snapshot.objects.get(hash);
        if (!bytes) throw new Error(`Configuration object ${hash} is missing`);
        return bytes;
      });
      await rename(staging, checkout);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }

    // Private state: sync metadata and the current device move with the account.
    const oldState = join(arborPrivateRoot(), "accounts", from);
    const newState = join(arborPrivateRoot(), "accounts", to);
    await mkdir(newState, { recursive: true, mode: 0o700 });
    if (await exists(join(oldState, "refs"))) await rename(join(oldState, "refs"), join(newState, "refs"));
    await saveCurrentAccountDeviceID(to, record.deviceID);
    await new HostAccountStore(to).set(connection.accountToken, {
      origin: record.origin,
      account: record.account,
      accountID: account.id,
      ...(account.handle ? { handle: account.handle } : {}),
      profileTree: record.profileTree,
      deviceID: record.deviceID,
      configurationRef: current.tree.root,
      configurationUpdate: current.tree.update,
    });

    // Placements follow the account's new key.
    let placements = 0;
    if (await exists(placementsPath)) {
      const document = parseDocument(await readFile(placementsPath, "utf8"), { uniqueKeys: true, keepSourceTokens: true });
      const entries = document.getIn([from]);
      if (entries !== undefined) {
        const value = (document.toJS() as Record<string, Record<string, string>>)[from] ?? {};
        placements = Object.keys(value).length;
        document.deleteIn([from]);
        document.setIn([to], value);
        const temporary = `${placementsPath}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, document.toString({ lineWidth: 0 }), { mode: 0o600 });
        await rename(temporary, placementsPath);
      }
    }

    // Keep the old checkout; remove the old connection and its credential entry.
    const kept = join(arborPrivateRoot(), "migration", "022", `accounts-${from}`);
    await mkdir(join(kept, ".."), { recursive: true, mode: 0o700 });
    const oldCheckout = join(arborDataRoot(), "accounts", from);
    if (await exists(oldCheckout)) await rename(oldCheckout, kept);
    await new HostAccountStore(from).remove();
    await rm(oldState, { recursive: true, force: true });
    report.accounts.push({ from, to, profile: record.profileTree, origin: record.origin, placements, rekeyed: true });
  }
  return report;
}

if (import.meta.main) {
  console.log(JSON.stringify(await rekeyDataHome(), null, 2));
}
