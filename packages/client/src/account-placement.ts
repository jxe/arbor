import { join } from "node:path";
import {
  overstoryPrivateRoot,
  HostAccountStore,
  HostPlacementStore,
  isHomeHostOrigin,
  openDeviceSession,
  ProtocolClient,
  ProtocolError,
  ProtocolHTTPError,
  treeConfigurationID,
  type HostPlacementRecord,
  type RemotePlacementAccountDescriptor,
} from "@ovst/protocol";
import { withLocalStateLock } from "./local-state-lock.ts";

export interface PlacementAccountResult {
  record: HostPlacementRecord;
  account: RemotePlacementAccountDescriptor;
}

/** An HTTPS host URL, or an http one on loopback for local hosts: its origin. */
export function placementOrigin(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new ProtocolError("invalid-request", "The placement host must be an HTTPS Canopy URL", 400); }
  if (!isHomeHostOrigin(url.origin) || url.username || url.password || url.search || url.hash) {
    throw new ProtocolError("invalid-request", "The placement host must be an HTTPS Canopy URL", 400);
  }
  return url.origin;
}

/**
 * Connect this data home to its profile's placement account at another host
 * (accounts §1.3), which the host's community created by reserving the
 * profile's locator at its home host. There is no claim: the device opens a
 * session there with the key it already uses at its home host, and the
 * connection is recorded beside the home connection. A host with no such
 * reservation refuses the session, and the error says what to reserve.
 */
export async function connectPlacementAccount(placementHost: string): Promise<PlacementAccountResult> {
  return withLocalStateLock(join(overstoryPrivateRoot(), "account-bootstrap-lock.sqlite"), () => connect(placementHost));
}

async function connect(placementHost: string): Promise<PlacementAccountResult> {
  const origin = placementOrigin(placementHost);
  const homeStore = await HostAccountStore.list().then((accounts) => {
    if (accounts.length !== 1) {
      throw new ProtocolError("conflict", accounts.length ? "Several accounts are connected; connect a placement host from the one it belongs to" : "No home account is connected in this data home; claim or pair one first", 409);
    }
    return new HostAccountStore(accounts[0]!.configurationTree);
  });
  const home = await homeStore.safe();
  const key = await homeStore.deviceKeySeed();
  if (!home || !key) throw new ProtocolError("conflict", "No home account is connected in this data home; claim or pair one first", 409);
  if (home.origin === origin) {
    throw new ProtocolError("conflict", `${origin} is this profile's home host; a placement host is another host`, 409);
  }
  const profileTree = home.profileTree;
  const configurationTree = treeConfigurationID(profileTree);
  let token: string;
  try {
    token = (await openDeviceSession(origin, profileTree, key.deviceID, key.seed)).token;
  } catch (error) {
    // A host that holds the account but cannot check this device now (its
    // home host is unreachable) says so, naming the home host.
    if (error instanceof ProtocolHTTPError && (error.status >= 500 || error.details?.homeHost !== undefined)) throw error;
    if (error instanceof ProtocolHTTPError && (error.status === 404 || error.status === 403)) {
      throw new ProtocolError("not-found", `${origin} has no account for this profile; ask its administrators to reserve ${home.account} as a member`, 404);
    }
    throw error;
  }
  const { account } = await new ProtocolClient(origin, token).placementAccount();
  if (account.profileTree !== profileTree || account.homeHost !== home.origin) {
    throw new ProtocolError("conflict", `The account at ${origin} names another profile or home host`, 409);
  }
  const store = new HostPlacementStore(configurationTree, origin);
  const record = await store.set({
    account: `${origin}${account.placementRoot.path}`,
    accountID: account.id,
    ...(account.handle ? { handle: account.handle } : {}),
    profileTree,
    homeHost: home.origin,
    placementRoot: account.placementRoot.id,
  });
  return { record, account };
}
