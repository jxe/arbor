import { accountProtocolClient, type AccountSelector, type AccountProtocolClient } from "@overstory/client";
import { type SharedTreePlacement } from "./state/index.ts";

/** The sync engine selects connections; it never administers accounts. */
export interface SyncConnections {
  accountClientFor(selector: AccountSelector): Promise<AccountProtocolClient>;
  tokenFor(placement: SharedTreePlacement): Promise<string | undefined>;
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
  };
}
