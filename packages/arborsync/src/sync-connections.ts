import { accountWireClient, type AccountSelector, type AccountWireClient } from "@arbor/canopy-client";
import { CanopyAccountStore, CommunityConfigStore, type SharedTreePlacement } from "@arbor/stores";

/** The sync engine selects connections; it never administers accounts. */
export interface SyncConnections {
  wireFor(selector: AccountSelector): Promise<AccountWireClient>;
  tokenFor(placement: SharedTreePlacement): Promise<string | undefined>;
}

export function localSyncConnections(): SyncConnections {
  const communityConfig = new CommunityConfigStore();
  const wireFor = (selector: AccountSelector) => accountWireClient(selector, { communityConfig, timeoutMs: 60_000 });
  return {
    wireFor,
    async tokenFor(placement) {
      const selected = await wireFor({ configurationTree: placement.configurationTree, origin: placement.endpoint });
      if (!selected.authenticated) return undefined;
      if (selected.configurationTree) return (await new CanopyAccountStore(selected.configurationTree).get())?.accountToken;
      return (await communityConfig.get())?.accountToken;
    },
  };
}
