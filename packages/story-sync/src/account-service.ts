import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { overstoryPrivateRoot } from "@ovst/protocol";
import type { HostPlacementRecord, MutationReceipt } from "@ovst/protocol";
import { ProtocolError, ProtocolHTTPError, ProtocolTransportError } from "@ovst/protocol";
import { ProfileIdentityStore } from "@ovst/client";
import { listLocalAccounts, type LocalAccountSummary } from "./state/index.ts";
import { claimLocalPairing, connectPlacementAccount, pendingLocalPairing, cancelPendingAccountClaim, claimHostAccountBootstrap, resolveUserPath, type AccountBootstrapDeps } from "@ovst/client";

/** Account administration depends on bootstrap ports, never the sync daemon. */
export class LocalAccountService {
  constructor(private readonly deps: AccountBootstrapDeps) {}

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
   * Connect the data home to its profile's placement account at `host`
   * (accounts §1.3), which the host's community created by reserving the
   * profile's locator: the device key opens a session there, as `story place`
   * does on first use. A host's refusal keeps its error code, status and
   * details, so a 403 or 503 still names `details.homeHost`.
   */
  async connectPlacementAccount(host: string): Promise<{ placement: HostPlacementRecord }> {
    try {
      const { record } = await connectPlacementAccount(host);
      // The tree registry checks placements.yaml hosts against these connections.
      this.deps.trees.invalidateDescriptors();
      return { placement: record };
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

  async backupProfileIdentity(destination: string, passphrase?: string) {
    await identityOperation(() => new ProfileIdentityStore().backup(resolveUserPath(destination), passphrase));
  }

  async pendingClaim(): Promise<{ account: string; path: string; canCancel: boolean } | null> {
    try {
      const value = JSON.parse(await readFile(join(overstoryPrivateRoot(), "bootstrap-account-claim.json"), "utf8"));
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
