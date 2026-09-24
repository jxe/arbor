import { ProtocolError, HostAccountStore, ProtocolClient } from "@overstory/protocol";

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
  authenticated: boolean;
}

/**
 * The multiplexer: one Arbor Sync data home holds several Canopy accounts,
 * and every pass-through to Canopy picks the account whose address contains
 * the target, then forwards with that credential. Without a matching
 * credential the client is anonymous, unless `required`.
 */
export async function accountProtocolClient(
  selector: AccountSelector,
  options: { timeoutMs?: number; required?: boolean } = {},
): Promise<AccountProtocolClient> {
  const clientOptions = options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {};
  if (selector.configurationTree) {
    const configured = await new HostAccountStore(selector.configurationTree).get();
    if (configured) {
      return {
        client: new ProtocolClient(configured.record.origin, configured.accountToken, clientOptions),
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
  for (const record of await HostAccountStore.list()) {
    if (record.origin !== selector.origin) continue;
    const configured = await new HostAccountStore(record.configurationTree).get();
    if (!configured) continue;
    return {
      client: new ProtocolClient(configured.record.origin, configured.accountToken, clientOptions),
      origin: configured.record.origin,
      configurationTree: record.configurationTree,
      authenticated: true,
    };
  }
  if (options.required) {
    throw new ProtocolError("credential-unavailable", `No claimed account for ${selector.origin}`, 409);
  }
  return { client: new ProtocolClient(selector.origin, undefined, clientOptions), origin: selector.origin, authenticated: false };
}
