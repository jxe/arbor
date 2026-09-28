import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { arborPrivateRoot } from "@overstory/protocol";
import type { HostPlacementRecord, MutationReceipt } from "@overstory/protocol";
import { ProtocolError, HostAccountStore, HostPlacementStore, ProtocolHTTPError, ProtocolTransportError } from "@overstory/protocol";
import { ProfileIdentityStore } from "@overstory/client";
import { listLocalAccounts, type LocalAccountSummary } from "./state/index.ts";
import { claimLocalPairing, claimPlacementAccount, pendingLocalPairing, cancelPendingAccountClaim, claimHostAccountBootstrap, resolveUserPath, type AccountBootstrapDeps } from "@overstory/client";

/** Account administration depends on bootstrap ports, never the sync daemon. */
export class LocalAccountService {
  constructor(private readonly deps: AccountBootstrapDeps) {}
  /**
   * A session token for a configuration tree's account, which the device key
   * opens and never leaves Arbor Sync. Serving it over loopback is deliberate:
   * any local process with the user's filesystem access can already read the
   * credential store and write the placed folders, so this exposes no new
   * authority (documented in `docs/architecture/arborsync/data-home.md`).
   * With `origin`, the token is for that host: the home account's when it is
   * the home host, else the account's placement connection there.
   */
  async credentialToken(configurationTree?: string, origin?: string): Promise<string> {
    let token: string | undefined;
    if (origin !== undefined) {
      if (!configurationTree) throw new ProtocolError("invalid-request", "credential for an origin requires a configurationTree", 400);
      let placement: HostPlacementStore;
      try { placement = new HostPlacementStore(configurationTree, origin); }
      catch { throw new ProtocolError("invalid-request", "configurationTree must be a TreeID and origin a canonical origin", 400); }
      const home = await new HostAccountStore(configurationTree).safe();
      try {
        token = home?.origin === origin
          ? (await new HostAccountStore(configurationTree).get())?.accountToken
          : (await placement.get())?.accountToken;
      } catch (error) {
        if (error instanceof ProtocolHTTPError) {
          // A placement host names the profile's home host when it cannot
          // check the device (accounts §5.4); clients show it.
          const homeHost = typeof error.details?.homeHost === "string" ? error.details.homeHost : undefined;
          const details = (homeHost ? { homeHost } : {}) as ProtocolError["details"];
          // It cannot check this device now (its home host is unreachable): a retry may succeed.
          if (error.retryable) {
            throw new ProtocolError(error.code ?? "internal-error", `${origin} cannot check this device now: ${error.message}`, 503, { retryable: true, ...details });
          }
          // The host refused to open a session for this device: it is not listed there any more.
          throw new ProtocolError("credential-unavailable", `${origin} refused this device: ${error.message}`, 409, details);
        }
        throw error;
      }
    } else if (configurationTree) {
      let store: HostAccountStore;
      try { store = new HostAccountStore(configurationTree); }
      catch { throw new ProtocolError("invalid-request", "configurationTree must be a TreeID", 400); }
      token = (await store.get())?.accountToken;
    } else {
      const accounts = await HostAccountStore.list();
      if (accounts.length > 1) {
        throw new ProtocolError("invalid-request", "credential requires an explicit configurationTree when several accounts are connected", 400);
      }
      token = accounts.length === 1
        ? (await new HostAccountStore(accounts[0]!.configurationTree).get())?.accountToken
        : undefined;
    }
    if (!token) throw new ProtocolError("not-found", "No account credential is available", 404);
    return token;
  }

  async claimHostAccount(account: string, inputPath: string, displayName?: string, inviteCode?: string): Promise<MutationReceipt["effects"]> {
    try { return await claimHostAccountBootstrap(this.deps, account, inputPath, displayName, inviteCode); }
    catch (error) {
      if (error instanceof ProtocolHTTPError) {
        throw new ProtocolError(error.status === 409 ? "conflict" : "invalid-request", error.message, error.status);
      }
      if (error instanceof ProtocolTransportError) {
        throw new ProtocolError("internal-error", "The community could not be reached. Your pending connection is retained; try again when online.", 503, { retryable: true });
      }
      throw error;
    }
  }

  /**
   * Claim a placement account for the data home's profile at `host`
   * (accounts §1.3), as `arbor account place <host>` does, or connect to one
   * already claimed. The data home holds the profile key and the device key,
   * so a local app claims through here. A host's refusal keeps its error code,
   * status and details, so a 403 or 503 still names `details.homeHost`.
   */
  async claimPlacementAccount(host: string, inviteCode?: string): Promise<{ placement: HostPlacementRecord; claimed: boolean }> {
    try {
      const { record, claimed } = await claimPlacementAccount(host, inviteCode ? { inviteCode } : {});
      // The tree registry checks placements.yaml hosts against these connections.
      this.deps.trees.invalidateDescriptors();
      return { placement: record, claimed };
    } catch (error) {
      if (error instanceof ProtocolHTTPError) {
        throw new ProtocolError(error.code ?? codeForStatus(error.status), error.message, error.status, {
          retryable: error.retryable ?? false,
          ...(error.details ?? {}),
        } as ProtocolError["details"]);
      }
      if (error instanceof ProtocolTransportError) {
        throw new ProtocolError("internal-error", `${host} could not be reached; try again when it is online.`, 503, { retryable: true });
      }
      throw error;
    }
  }

  async profileIdentity() {
    try { return await new ProfileIdentityStore().status(); }
    catch { throw new ProtocolError("credential-unavailable", "The existing identity could not be read or verified. Unlock the credential store or inspect the identity backup; no new identity was created.", 409); }
  }

  async createProfileIdentity(inputPath: string) {
    const result = await identityOperation(() => new ProfileIdentityStore().create(resolveUserPath(inputPath)));
    this.deps.trees.invalidateDescriptors();
    return result;
  }

  async restoreProfileIdentity(backup: unknown, inputPath: string, passphrase?: string) {
    const result = await identityOperation(() => new ProfileIdentityStore().restoreValue(backup, resolveUserPath(inputPath), passphrase));
    this.deps.trees.invalidateDescriptors();
    return result;
  }

  async backupProfileIdentity(destination: string, passphrase: string) {
    await identityOperation(() => new ProfileIdentityStore().backup(resolveUserPath(destination), passphrase));
  }

  async pendingClaim(): Promise<{ account: string; path: string; canCancel: boolean } | null> {
    try {
      const value = JSON.parse(await readFile(join(arborPrivateRoot(), "bootstrap-account-claim.json"), "utf8"));
      if (value.version !== 3 || typeof value.account !== "string" || typeof value.path !== "string") throw new Error("Malformed pending account claim");
      return { account: value.account, path: value.path, canCancel: value.stage === "prepared" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async pendingPairing() { return pendingLocalPairing(); }

  async claimPairing(payload?: unknown) {
    return identityOperation(() => claimLocalPairing(this.deps, payload));
  }

  async cancelPendingClaim(): Promise<void> { await cancelPendingAccountClaim(); }

  async accountList(): Promise<LocalAccountSummary[]> {
    return listLocalAccounts();
  }

}

/** The error code a host's refusal stands for when its body names none. */
function codeForStatus(status: number): string {
  switch (status) {
    case 400: return "invalid-request";
    case 401: return "unauthenticated";
    case 403: return "permission-denied";
    case 404: return "not-found";
    case 409: return "conflict";
    case 429: return "rate-limited";
    default: return "internal-error";
  }
}

async function identityOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    throw new ProtocolError("conflict", error instanceof SyntaxError
      ? "The identity backup or metadata is malformed; the existing identity was not replaced"
      : error instanceof Error ? error.message : "The identity operation could not be completed", 409);
  }
}
