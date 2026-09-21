import { accountWireClient, type AccountSelector, type AccountWireClient } from "@overstory/client";
import { CanopyAccountStore } from "@overstory/protocol";
import { type SharedTreePlacement } from "./state/index.ts";

/** The sync engine selects connections; it never administers accounts. */
export interface SyncConnections {
  wireFor(selector: AccountSelector): Promise<AccountWireClient>;
  tokenFor(placement: SharedTreePlacement): Promise<string | undefined>;
}

export function localSyncConnections(): SyncConnections {
  const wireFor = (selector: AccountSelector) => accountWireClient(selector, { timeoutMs: 60_000 });
  return {
    wireFor,
    async tokenFor(placement) {
      const selected = await wireFor({ configurationTree: placement.configurationTree, origin: placement.endpoint });
      if (!selected.authenticated) return undefined;
      if (selected.configurationTree) return (await new CanopyAccountStore(selected.configurationTree).get())?.accountToken;
      return undefined;
    },
  };
}
