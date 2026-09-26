import type { LocalAccountSummary } from "@overstory/protocol";
import { loadAccountConfigurations, HostAccountStore } from "@overstory/protocol";

export type { LocalAccountSummary } from "@overstory/protocol";

/**
 * The claimed Canopy accounts of the current data home, projected from
 * durable configuration only. Arbor Sync serves this through
 * `GET /v1/accounts`; a same-machine caller such as the CLI may read it
 * directly because it touches nothing the daemon owns in memory or watches.
 */
export async function listLocalAccounts(): Promise<LocalAccountSummary[]> {
  const configurations = await loadAccountConfigurations();
  return Promise.all(configurations.map(async (configuration) => {
    const store = new HostAccountStore(configuration.configurationTree);
    const stored = await store.safe();
    return {
      configurationTree: configuration.configurationTree,
      canopy: configuration.canopy ?? stored?.origin ?? null,
      handle: stored?.handle ?? null,
      profileTree: configuration.profile ?? stored?.profileTree ?? null,
      deviceID: configuration.currentDevice?.id ?? stored?.deviceID ?? null,
      credentialAvailable: Boolean(await store.get()),
      diagnostics: configuration.diagnostics,
    };
  }));
}
