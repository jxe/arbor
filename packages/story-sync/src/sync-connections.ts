import { accountProtocolClient, type AccountSelector, type AccountProtocolClient } from "@ovst/client";
import { HostAccountStore, HostPlacementStore } from "@ovst/protocol";
import { type SharedTreePlacement } from "./state/index.ts";

/** The sync engine selects connections; it never administers accounts. */
export interface SyncConnections {
  accountClientFor(selector: AccountSelector): Promise<AccountProtocolClient>;
  tokenFor(placement: SharedTreePlacement): Promise<string | undefined>;
  /**
   * After a 401 from the placement's endpoint, forget the session this device
   * holds there, so the next request opens another; true when there was one to
   * forget. It is the home account's session when the endpoint is the home
   * host, else the placement account's there, and never the other.
   */
  forgetSession(placement: SharedTreePlacement): Promise<boolean>;
}

export function localSyncConnections(): SyncConnections {
  const accountClientFor = (selector: AccountSelector) => accountProtocolClient(selector, { timeoutMs: 60_000 });
  return {
    accountClientFor,
    async tokenFor(placement) {
      const selected = await accountClientFor({ configurationTree: placement.configurationTree, origin: placement.endpoint });
      if (!selected.authenticated) return undefined;
      // The session of the connection selected: the home account's, or a placement account's at another host.
      return selected.token;
    },
    forgetSession: forgetPlacementSession,
  };
}

export async function forgetPlacementSession(placement: SharedTreePlacement): Promise<boolean> {
  const home = new HostAccountStore(placement.configurationTree);
  if (!await home.hasDeviceKey()) return false;
  const record = await home.safe();
  if (record && record.origin !== placement.endpoint) {
    const connection = new HostPlacementStore(placement.configurationTree, placement.endpoint);
    if (!await connection.safe()) return false;
    await connection.forgetSession();
    return true;
  }
  await home.forgetSession();
  return true;
}
