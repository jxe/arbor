import { join } from "node:path";
import {
  arborPrivateRoot,
  HostAccountStore,
  HostPlacementStore,
  isHomeHostOrigin,
  openDeviceSession,
  ProtocolClient,
  ProtocolError,
  ProtocolHTTPError,
  treeConfigurationID,
  type AccountChallenge,
  type HostPlacementRecord,
  type RemotePlacementAccountDescriptor,
} from "@overstory/protocol";
import { withLocalStateLock } from "./local-state-lock.ts";
import { ProfileIdentityStore } from "./profile-identity.ts";

export interface PlacementAccountResult {
  record: HostPlacementRecord;
  account: RemotePlacementAccountDescriptor;
  /** Whether this call claimed the account, rather than finding it already claimed and connected. */
  claimed: boolean;
}

/** An HTTPS host URL, or an http one on loopback for local hosts: the origin and, if a path was given, the exact account URL. */
function placementTarget(input: string): { origin: string; account?: string } {
  let url: URL;
  try { url = new URL(input); } catch { throw new ProtocolError("invalid-request", "The placement host must be an HTTPS Canopy URL", 400); }
  if (!isHomeHostOrigin(url.origin) || url.username || url.password || url.search || url.hash) {
    throw new ProtocolError("invalid-request", "The placement host must be an HTTPS Canopy URL", 400);
  }
  const path = url.pathname.replace(/\/$/, "");
  return { origin: url.origin, ...(path ? { account: `${url.origin}${path}` } : {}) };
}

/**
 * Claim a placement account (accounts §1.3) for the local profile at another
 * host, and record the connection beside the profile's home connection. The
 * profile key signs a challenge naming the home host; the device then opens
 * a session there with the key it already uses at its home host. Running it
 * again after a claim that landed adopts the account instead of claiming it
 * twice.
 */
export async function claimPlacementAccount(placementHost: string, options: { inviteCode?: string } = {}): Promise<PlacementAccountResult> {
  return withLocalStateLock(join(arborPrivateRoot(), "account-bootstrap-lock.sqlite"), () => claim(placementHost, options));
}

async function claim(placementHost: string, options: { inviteCode?: string }): Promise<PlacementAccountResult> {
  const target = placementTarget(placementHost);
  const identity = new ProfileIdentityStore();
  const status = await identity.status();
  if (!status) throw new ProtocolError("conflict", "No person identity exists; run `arbor me create`", 409);
  if (!status.keyAvailable) throw new ProtocolError("credential-unavailable", `The private identity key for ${status.profileTree} is unavailable`, 409);
  const profileTree = status.profileTree;
  const configurationTree = treeConfigurationID(profileTree);
  const home = await new HostAccountStore(configurationTree).safe();
  if (!home || !await new HostAccountStore(configurationTree).deviceKeySeed()) {
    throw new ProtocolError("conflict", "This profile has no connected home account in this data home; claim or pair one first", 409);
  }
  if (home.origin === target.origin) {
    throw new ProtocolError("conflict", `${target.origin} is this profile's home host; a placement account is claimed at another host`, 409);
  }
  const store = new HostPlacementStore(configurationTree, target.origin);

  /** Record the connection, then open a session with the device key and check the account it names. */
  const connect = async (account: RemotePlacementAccountDescriptor, accountURL: string): Promise<HostPlacementRecord> => {
    if (account.profileTree !== profileTree || account.homeHost !== home.origin) {
      throw new ProtocolError("conflict", `The account at ${target.origin} names another profile or home host`, 409);
    }
    const record = await store.set({
      account: accountURL,
      accountID: account.id,
      ...(account.handle ? { handle: account.handle } : {}),
      profileTree,
      homeHost: home.origin,
      placementRoot: account.placementRoot.id,
    });
    const connection = await store.get();
    if (!connection) throw new ProtocolError("credential-unavailable", "This device's key is unavailable", 409);
    const { account: opened } = await new ProtocolClient(target.origin, connection.accountToken).placementAccount();
    if (opened.profileTree !== profileTree || opened.placementRoot.id !== account.placementRoot.id) {
      throw new ProtocolError("conflict", `The account at ${target.origin} changed while it was being connected`, 409);
    }
    return record;
  };

  /** A placement account this host already holds for the profile, read with a session the device key opens; null if none opens. */
  const adopt = async (): Promise<{ record: HostPlacementRecord; account: RemotePlacementAccountDescriptor } | null> => {
    const key = (await new HostAccountStore(configurationTree).deviceKeySeed())!;
    let token: string;
    try { token = (await openDeviceSession(target.origin, profileTree, key.deviceID, key.seed)).token; }
    catch (error) {
      // A host that holds the account but cannot check this device now (its
      // home host is unreachable) says so; claiming again would only hide that.
      if (error instanceof ProtocolHTTPError && (error.status >= 500 || error.details?.homeHost !== undefined)) throw error;
      return null;
    }
    const { account } = await new ProtocolClient(target.origin, token).placementAccount();
    const accountURL = (await store.safe())?.account ?? target.account ?? `${target.origin}${account.placementRoot.path}`;
    await store.forgetSession();
    return { record: await connect(account, accountURL), account };
  };

  if (await store.safe()) {
    const adopted = await adopt();
    if (adopted) return { ...adopted, claimed: false };
  }

  const client = new ProtocolClient(target.origin);
  const signedChallenge = async (): Promise<{ challenge: AccountChallenge; publicKey: string; signature: string }> => {
    const challenge = await client.createAccountChallenge({
      ...(target.account ? { account: target.account } : {}),
      profileTree,
      configurationTree,
      homeHost: home.origin,
      ...(options.inviteCode ? { inviteCode: options.inviteCode } : {}),
    });
    // What the profile key signs: this host, this profile, and this home host.
    if (challenge.origin !== target.origin || challenge.profileTree !== profileTree || challenge.configurationTree !== configurationTree
      || challenge.homeHost !== home.origin || (target.account && challenge.account !== target.account)) {
      throw new ProtocolError("conflict", "The placement host's challenge disagrees with the requested claim", 409);
    }
    return { challenge, ...await identity.signChallenge(challenge) };
  };
  let accountURL = target.account ?? target.origin;
  const submit = async () => {
    const signed = await signedChallenge();
    accountURL = signed.challenge.account;
    return client.claimPlacementAccount({
      account: signed.challenge.account,
      profileTree,
      configurationTree,
      challenge: signed.challenge,
      publicKey: signed.publicKey,
      signature: signed.signature,
      ...(options.inviteCode ? { inviteCode: options.inviteCode } : {}),
    });
  };
  let result;
  try {
    try {
      result = await submit();
    } catch (error) {
      if (!(error instanceof ProtocolHTTPError) || error.details?.challenge !== "expired") throw error;
      result = await submit();
    }
  } catch (error) {
    // A claim that landed before its answer was lost: the host already knows the profile.
    if (error instanceof ProtocolHTTPError && (error.code === "already-claimed" || /already claimed/.test(error.message))) {
      const adopted = await adopt();
      if (adopted) return { ...adopted, claimed: false };
    }
    throw error;
  }
  // The challenge names the exact account URL the host allocated.
  return { record: await connect(result.account, accountURL), account: result.account, claimed: true };
}
