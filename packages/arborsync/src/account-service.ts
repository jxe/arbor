import type { MutationReceipt } from "@arbor/core";
import { ProtocolError } from "@arbor/core";
import { CanopyAccountStore, ProfileIdentityStore, listLocalAccounts, type LocalAccountSummary } from "@arbor/stores";
import { claimCanopyAccountBootstrap, createPairingBootstrap, forgetLocalAccount, resolveUserPath, type AccountBootstrapDeps } from "@arbor/canopy-client";

/** Account administration depends on bootstrap ports, never the sync daemon. */
export class LocalAccountService {
  constructor(private readonly deps: AccountBootstrapDeps) {}
  /**
   * The account credential for a configuration tree. Serving it over loopback
   * is deliberate: any local process with the user's filesystem access can
   * already read the credential store and write the placed folders, so this
   * exposes no new authority (documented in `docs/local-system.md`).
   */
  async credentialToken(configurationTree?: string): Promise<string> {
    let token: string | undefined;
    if (configurationTree) {
      let store: CanopyAccountStore;
      try { store = new CanopyAccountStore(configurationTree); }
      catch { throw new ProtocolError("invalid-request", "configurationTree must be a TreeID", 400); }
      token = (await store.get())?.accountToken;
    } else {
      const accounts = await CanopyAccountStore.list();
      if (accounts.length > 1) {
        throw new ProtocolError("invalid-request", "credential requires an explicit configurationTree when several accounts are connected", 400);
      }
      token = accounts.length === 1
        ? (await new CanopyAccountStore(accounts[0]!.configurationTree).get())?.accountToken
        : (await this.deps.communityConfig.get())?.accountToken;
    }
    if (!token) throw new ProtocolError("not-found", "No account credential is available", 404);
    return token;
  }

  async claimCanopyAccount(account: string, inputPath: string, displayName?: string): Promise<MutationReceipt["effects"]> {
    return claimCanopyAccountBootstrap(this.deps, account, inputPath, displayName);
  }

  async profileIdentity() {
    return new ProfileIdentityStore().status();
  }

  async createProfileIdentity(inputPath: string) {
    const result = await new ProfileIdentityStore().create(resolveUserPath(inputPath));
    this.deps.trees.invalidateDescriptors();
    return result;
  }

  async forgetLocalAccount(): Promise<void> {
    return forgetLocalAccount(this.deps);
  }

  async accountList(): Promise<LocalAccountSummary[]> {
    return listLocalAccounts(this.deps.communityConfig);
  }

  async createPairingBootstrap(configurationTree?: string) {
    return createPairingBootstrap(this.deps, configurationTree);
  }

}
