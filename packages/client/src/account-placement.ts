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
import { ProfileIdentityStore } from "./profile-identity.ts";

export interface PlacementAccountResult {
  record: HostPlacementRecord;
  account: RemotePlacementAccountDescriptor;
}

/** An HTTPS host URL, or an http one on loopback for local hosts: its origin. */
export function placementOrigin(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new ProtocolError("invalid-request", "The placement host must be an HTTPS Overstory host URL", 400); }
  if (!isHomeHostOrigin(url.origin) || url.username || url.password || url.search || url.hash) {
    throw new ProtocolError("invalid-request", "The placement host must be an HTTPS Overstory host URL", 400);
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
  const invitation = invitationLink(placementHost);
  return withLocalStateLock(join(overstoryPrivateRoot(), "account-bootstrap-lock.sqlite"), async () => {
    if (invitation) await acceptInvitation(invitation);
    return connect(invitation?.account ?? placementHost);
  });
}

/** An invitation link's account URL and code (locators §2.2), or null for anything else. */
export function invitationLink(input: string): { account: string; code: string } | null {
  const match = input.trim().match(/^(https?|overstory):\/\/([^/?#;@]+)(\/[^?#;]*)?#overstory-invite=([A-Za-z0-9._~-]+)$/i);
  if (!match) return null;
  const loopback = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(match[2]!);
  const scheme = match[1]!.toLowerCase() === "overstory" ? (loopback ? "http" : "https") : match[1]!.toLowerCase();
  return { account: `${scheme}://${match[2]}${(match[3] ?? "").replace(/\/+$/, "")}`, code: match[4]! };
}

/**
 * Accept an invitation to another host with this data home's profile, which
 * keeps its home: the host makes the invited address a placement account
 * (accounts §1.4). The profile key signs the host's challenge.
 */
async function acceptInvitation(invitation: { account: string; code: string }): Promise<void> {
  const origin = placementOrigin(new URL(invitation.account).origin);
  const home = await homeAccount();
  if (home.origin === origin) {
    throw new ProtocolError("conflict", `${origin} is this profile's home host; an invitation there is for a new profile`, 409);
  }
  const profileTree = home.profileTree;
  const configurationTree = treeConfigurationID(profileTree);
  const client = new ProtocolClient(origin);
  const challenge = await client.createAccountChallenge({
    account: invitation.account, profileTree, configurationTree, inviteCode: invitation.code, profile: home.account,
  });
  if (challenge.origin !== origin || challenge.account !== invitation.account || challenge.profileTree !== profileTree) {
    throw new ProtocolError("conflict", "The invitation's host answered for another account", 409);
  }
  const { publicKey, signature } = await new ProfileIdentityStore().signChallenge(challenge);
  await client.acceptInvitationAsPlacement({
    account: invitation.account, profile: home.account, profileTree, configurationTree, inviteCode: invitation.code, challenge, publicKey, signature,
  });
}

/** The one home account this data home holds. */
async function homeAccount() {
  const accounts = await HostAccountStore.list();
  if (accounts.length !== 1) {
    throw new ProtocolError("conflict", accounts.length ? "Several accounts are connected; connect a placement host from the one it belongs to" : "No home account is connected in this data home; claim or pair one first", 409);
  }
  const home = await new HostAccountStore(accounts[0]!.configurationTree).safe();
  if (!home) throw new ProtocolError("conflict", "No home account is connected in this data home; claim or pair one first", 409);
  return home;
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
