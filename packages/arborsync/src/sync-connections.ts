import { accountProtocolClient, type AccountSelector, type AccountProtocolClient } from "@overstory/client";
import { HostAccountStore } from "@overstory/protocol";
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
      if (selected.configurationTree) return (await new HostAccountStore(selected.configurationTree).get())?.accountToken;
      return undefined;
    },
  };
}
