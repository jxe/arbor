import type { LocalAccountService } from "./account-service.ts";
import { ProtocolError } from "@overstory/protocol";
import { json } from "./http.ts";

export function accountHandler(service: LocalAccountService) {
  return async (request: Request, url: URL): Promise<Response | undefined> => {
    if (request.method === "GET" && url.pathname === "/v1/credential") {
      // Deliberate loopback exposure (see docs/architecture/arborsync/data-home.md).
      const configurationTree = url.searchParams.get("configurationTree") ?? undefined;
      return json({ token: await service.credentialToken(configurationTree) });
    }
    if (request.method === "GET" && url.pathname === "/v1/accounts") {
      const [accounts, identity, pendingClaim, pendingPairing] = await Promise.all([service.accountList(), service.profileIdentity(), service.pendingClaim(), service.pendingPairing()]);
      return json({ accounts, identity, pendingClaim, pendingPairing });
    }
    if (request.method === "POST" && url.pathname === "/v1/me") {
      const body = await request.json() as { path?: unknown };
      if (typeof body.path !== "string") throw new ProtocolError("invalid-request", "Identity creation requires a profile path", 400);
      return json({ identity: await service.createProfileIdentity(body.path) }, 201);
    }
    if (request.method === "POST" && url.pathname === "/v1/me/restore") {
      const body = await request.json() as { path?: unknown; backup?: unknown; passphrase?: unknown };
      if (typeof body.path !== "string" || (body.passphrase !== undefined && typeof body.passphrase !== "string")) {
        throw new ProtocolError("invalid-request", "Identity recovery requires a profile path", 400);
      }
      return json({ identity: await service.restoreProfileIdentity(body.backup, body.path, body.passphrase as string | undefined) }, 201);
    }
    if (request.method === "POST" && url.pathname === "/v1/me/backup") {
      const body = await request.json() as { destination?: unknown; passphrase?: unknown };
      if (typeof body.destination !== "string" || typeof body.passphrase !== "string") {
        throw new ProtocolError("invalid-request", "Identity backup requires a destination and a passphrase", 400);
      }
      await service.backupProfileIdentity(body.destination, body.passphrase);
      return json({ saved: true });
    }
    if (request.method === "POST" && url.pathname === "/v1/device-key") {
      const body = await request.json() as { configurationTree?: unknown };
      if (typeof body.configurationTree !== "string") throw new ProtocolError("invalid-request", "Moving to a device key requires a configurationTree", 400);
      return json({ deviceKey: await service.moveToDeviceKey(body.configurationTree) });
    }
    if (url.pathname === "/v1/me/reset") {
      if (request.method === "GET") return json({ reset: await service.pendingLocalProfileReset() });
      if (request.method === "DELETE") return json({ discarded: await service.discardLocalProfileReset() });
      if (request.method === "POST") {
        const body = await request.json() as { origin?: unknown };
        if (typeof body.origin !== "string") throw new ProtocolError("invalid-request", "A profile reset names its home host's origin", 400);
        return json({ reset: await service.requestProfileReset(body.origin) }, 202);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/me/reset/finish") {
      await service.finishProfileReset();
      return json({ connected: true });
    }
    if (url.pathname === "/v1/profile-reset" && (request.method === "GET" || request.method === "DELETE")) {
      const configurationTree = url.searchParams.get("configurationTree");
      if (!configurationTree) throw new ProtocolError("invalid-request", "A profile reset is read per account; name its configurationTree", 400);
      if (request.method === "GET") return json({ reset: await service.pendingAccountProfileReset(configurationTree) });
      await service.cancelAccountProfileReset(configurationTree);
      return json({ cancelled: true });
    }
    if (request.method === "POST" && url.pathname === "/v1/bootstrap/accounts/cancel") {
      await service.cancelPendingClaim();
      return json({ cancelled: true });
    }
    if (request.method === "POST" && url.pathname === "/v1/bootstrap/accounts") {
      const body = await request.json() as { account?: unknown; path?: unknown; displayName?: unknown; inviteCode?: unknown };
      if (
        typeof body.account !== "string" || typeof body.path !== "string"
        || (body.displayName !== undefined && typeof body.displayName !== "string")
        || (body.inviteCode !== undefined && typeof body.inviteCode !== "string")
      ) throw new ProtocolError("invalid-request", "Account bootstrap requires an account locator and local profile path", 400);
      return json(await service.claimHostAccount(body.account, body.path, body.displayName as string | undefined, body.inviteCode as string | undefined), 201);
    }
    if (request.method === "POST" && url.pathname === "/v1/bootstrap/pairings/claim") {
      const body = await request.json() as { payload?: unknown };
      await service.claimPairing(body.payload);
      return json({ paired: true });
    }
    return undefined;
  };
}
