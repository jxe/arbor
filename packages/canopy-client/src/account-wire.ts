import { ProtocolError } from "@arbor/core";
import { CanopyAccountStore, CommunityConfigStore } from "@arbor/stores";
import { WireClient } from "@arbor/wire";

/**
 * Which claimed account a Wire call should speak for: an explicit account
 * configuration tree, or the Canopy origin a locator or placement names.
 */
export interface AccountSelector {
  configurationTree?: string;
  origin?: string;
}

export interface AccountWireClient {
  client: WireClient;
  origin: string;
  /** The configuration tree whose credential authenticates `client`, when one does. */
  configurationTree?: string;
  authenticated: boolean;
}

/**
 * The multiplexer: one Arbor Sync data home holds several Canopy accounts,
 * and every pass-through to Canopy picks the account whose address contains
 * the target, then forwards with that credential. Without a matching
 * credential the client is anonymous, unless `required`.
 */
export async function accountWireClient(
  selector: AccountSelector,
  options: { communityConfig?: CommunityConfigStore; timeoutMs?: number; required?: boolean } = {},
): Promise<AccountWireClient> {
  const wireOptions = options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {};
  if (selector.configurationTree) {
    const configured = await new CanopyAccountStore(selector.configurationTree).get();
    if (configured) {
      return {
        client: new WireClient(configured.record.origin, configured.accountToken, wireOptions),
        origin: configured.record.origin,
        configurationTree: selector.configurationTree,
        authenticated: true,
      };
    }
    if (options.required || !selector.origin) {
      throw new ProtocolError("credential-unavailable", `Credential unavailable for account ${selector.configurationTree}`, 409);
    }
  }
  if (!selector.origin) {
    throw new ProtocolError("invalid-request", "Account selection requires a configuration TreeID or a Canopy origin", 400);
  }
  for (const record of await CanopyAccountStore.list()) {
    if (record.origin !== selector.origin) continue;
    const configured = await new CanopyAccountStore(record.configurationTree).get();
    if (!configured) continue;
    return {
      client: new WireClient(configured.record.origin, configured.accountToken, wireOptions),
      origin: configured.record.origin,
      configurationTree: record.configurationTree,
      authenticated: true,
    };
  }
  const legacy = await (options.communityConfig ?? new CommunityConfigStore()).get();
  if (legacy?.record.origin === selector.origin) {
    return { client: new WireClient(legacy.record.origin, legacy.accountToken, wireOptions), origin: legacy.record.origin, authenticated: true };
  }
  if (options.required) {
    throw new ProtocolError("credential-unavailable", `No claimed account for ${selector.origin}`, 409);
  }
  return { client: new WireClient(selector.origin, undefined, wireOptions), origin: selector.origin, authenticated: false };
}
