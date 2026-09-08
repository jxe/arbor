import type { LocalAccountSummary } from "@arbor/core";
import { loadCanopyAccountConfigurations } from "./account-config-v2.ts";
import { CanopyAccountStore, CommunityConfigStore } from "./server-config.ts";

export type { LocalAccountSummary } from "@arbor/core";

/**
 * The claimed Canopy accounts of the current data home, projected from
 * durable configuration only. Arbor Sync serves this through
 * `GET /v1/accounts`; a same-machine caller such as the CLI may read it
 * directly because it touches nothing the daemon owns in memory or watches.
 */
export async function listLocalAccounts(
  communityConfig: CommunityConfigStore = new CommunityConfigStore(),
): Promise<LocalAccountSummary[]> {
  const configurations = await loadCanopyAccountConfigurations();
  if (configurations.length) {
    return Promise.all(configurations.map(async (configuration) => {
      const store = new CanopyAccountStore(configuration.configurationTree);
      const stored = await store.safe();
      return {
        configurationTree: configuration.configurationTree,
        canopy: configuration.account?.canopy ?? stored?.origin ?? null,
        handle: stored?.handle ?? null,
        profileTree: configuration.account?.profile ?? stored?.profileTree ?? null,
        deviceID: configuration.currentDevice?.id ?? stored?.deviceID ?? null,
        credentialAvailable: Boolean(await store.get()),
        diagnostics: configuration.diagnostics,
      };
    }));
  }
  const legacy = await communityConfig.status();
  return legacy ? [{
    configurationTree: legacy.record.configurationTree,
    canopy: legacy.record.origin,
    handle: legacy.record.handle,
    profileTree: legacy.record.profileTree,
    deviceID: null,
    credentialAvailable: legacy.credentialAvailable,
    diagnostics: [],
  }] : [];
}
