import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { arborPrivateRoot } from "@overstory/protocol";
import type { MutationReceipt } from "@overstory/protocol";
import { ProtocolError, HostAccountStore, ProtocolHTTPError, ProtocolTransportError } from "@overstory/protocol";
import { ProfileIdentityStore, listLocalAccounts, type LocalAccountSummary } from "./state/index.ts";
import { claimLocalPairing, pendingLocalPairing, cancelPendingAccountClaim, claimHostAccountBootstrap, resolveUserPath, type AccountBootstrapDeps } from "@overstory/client";

/** Account administration depends on bootstrap ports, never the sync daemon. */
export class LocalAccountService {
  constructor(private readonly deps: AccountBootstrapDeps) {}
  /**
   * The account credential for a configuration tree. Serving it over loopback
   * is deliberate: any local process with the user's filesystem access can
   * already read the credential store and write the placed folders, so this
   * exposes no new authority (documented in `docs/architecture/arborsync/data-home.md`).
   */
  async credentialToken(configurationTree?: string): Promise<string> {
    let token: string | undefined;
    if (configurationTree) {
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

  async profileIdentity() {
    try { return await new ProfileIdentityStore().status(); }
    catch { throw new ProtocolError("credential-unavailable", "The existing identity could not be read or verified. Unlock the credential store or inspect the identity backup; no new identity was created.", 409); }
  }

  async createProfileIdentity(inputPath: string) {
    const result = await identityOperation(() => new ProfileIdentityStore().create(resolveUserPath(inputPath)));
    this.deps.trees.invalidateDescriptors();
    return result;
  }

  async restoreProfileIdentity(backup: unknown, inputPath: string) {
    const result = await identityOperation(() => new ProfileIdentityStore().restoreValue(backup, resolveUserPath(inputPath)));
    this.deps.trees.invalidateDescriptors();
    return result;
  }

  async backupProfileIdentity(destination: string) {
    await identityOperation(() => new ProfileIdentityStore().backup(resolveUserPath(destination)));
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

async function identityOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    throw new ProtocolError("conflict", error instanceof SyntaxError
      ? "The identity backup or metadata is malformed; the existing identity was not replaced"
      : error instanceof Error ? error.message : "The identity operation could not be completed", 409);
  }
}
