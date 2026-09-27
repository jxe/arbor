import { ProtocolError, HostAccountStore, HostPlacementStore, ProtocolClient } from "@overstory/protocol";

/**
 * Which claimed account a protocol call should speak for: an explicit account
 * configuration tree, or the Canopy origin a locator or placement names.
 */
export interface AccountSelector {
  configurationTree?: string;
  origin?: string;
}

export interface AccountProtocolClient {
  client: ProtocolClient;
  origin: string;
  /** The configuration tree whose credential authenticates `client`, when one does. */
  configurationTree?: string;
  /** Set when `client` speaks for a placement account (accounts §1.3) rather than the profile's home account. */
  placement?: { homeHost: string; placementRoot: string };
  /** The session token `client` sends, when authenticated. */
  token?: string;
  authenticated: boolean;
}

/**
 * The multiplexer: one Arbor Sync data home holds several Canopy accounts,
 * and every pass-through to Canopy picks the account whose address contains
 * the target, then forwards with that credential. A profile has one home
 * account and at most one placement account per other host; an origin that
 * is not the home's selects the placement connection there. Without a
 * matching credential the client is anonymous, unless `required`.
 */
export async function accountProtocolClient(
  selector: AccountSelector,
  options: { timeoutMs?: number; required?: boolean } = {},
): Promise<AccountProtocolClient> {
  const clientOptions = options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {};
  const placed = async (configurationTree: string, origin: string): Promise<AccountProtocolClient | null> => {
    const connection = await new HostPlacementStore(configurationTree, origin).get();
    if (!connection) return null;
    return {
      client: new ProtocolClient(connection.record.origin, connection.accountToken, clientOptions),
      origin: connection.record.origin,
      configurationTree,
      placement: { homeHost: connection.record.homeHost, placementRoot: connection.record.placementRoot },
      token: connection.accountToken,
      authenticated: true,
    };
  };
  if (selector.configurationTree) {
    const home = await new HostAccountStore(selector.configurationTree).safe();
    if (selector.origin && home && home.origin !== selector.origin) {
      const placement = await placed(selector.configurationTree, selector.origin);
      if (placement) return placement;
    }
    // The configuration tree names the home account, as it always has.
    const configured = await new HostAccountStore(selector.configurationTree).get();
    if (configured) {
      return {
        client: new ProtocolClient(configured.record.origin, configured.accountToken, clientOptions),
        origin: configured.record.origin,
        configurationTree: selector.configurationTree,
        token: configured.accountToken,
        authenticated: true,
      };
    }
    if (options.required || !selector.origin) {
      throw new ProtocolError("credential-unavailable", `Credential unavailable for account ${selector.configurationTree}${selector.origin ? ` at ${selector.origin}` : ""}`, 409);
    }
  }
  if (!selector.origin) {
    throw new ProtocolError("invalid-request", "Account selection requires a configuration TreeID or a Canopy origin", 400);
  }
  for (const record of await HostAccountStore.list()) {
    if (record.origin !== selector.origin) continue;
    const configured = await new HostAccountStore(record.configurationTree).get();
    if (!configured) continue;
    return {
      client: new ProtocolClient(configured.record.origin, configured.accountToken, clientOptions),
      origin: configured.record.origin,
      configurationTree: record.configurationTree,
      token: configured.accountToken,
      authenticated: true,
    };
  }
  for (const record of await HostPlacementStore.list()) {
    if (record.origin !== selector.origin) continue;
    const placement = await placed(record.configurationTree, record.origin);
    if (placement) return placement;
  }
  if (options.required) {
    throw new ProtocolError("credential-unavailable", `No claimed account for ${selector.origin}`, 409);
  }
  return { client: new ProtocolClient(selector.origin, undefined, clientOptions), origin: selector.origin, authenticated: false };
}
