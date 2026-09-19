import type { LocalAccountService } from "./account-service.ts";
import { ProtocolError } from "@arbor/core";
import { json } from "./http.ts";

export function accountHandler(service: LocalAccountService) {
  return async (request: Request, url: URL): Promise<Response | undefined> => {
    if (request.method === "GET" && url.pathname === "/v1/credential") {
      // Deliberate loopback exposure (see docs/local-system.md).
      const configurationTree = url.searchParams.get("configurationTree") ?? undefined;
      return json({ token: await service.credentialToken(configurationTree) });
    }
    if (request.method === "GET" && url.pathname === "/v1/accounts") {
      const [accounts, identity] = await Promise.all([service.accountList(), service.profileIdentity()]);
      return json({ accounts, identity });
    }
    if (request.method === "POST" && url.pathname === "/v1/me") {
      const body = await request.json() as { path?: unknown };
      if (typeof body.path !== "string") throw new ProtocolError("invalid-request", "Identity creation requires a profile path", 400);
      return json({ identity: await service.createProfileIdentity(body.path) }, 201);
    }
    if (request.method === "POST" && url.pathname === "/v1/bootstrap/accounts") {
      const body = await request.json() as { account?: unknown; path?: unknown; displayName?: unknown };
      if (
        typeof body.account !== "string" || typeof body.path !== "string"
        || (body.displayName !== undefined && typeof body.displayName !== "string")
      ) throw new ProtocolError("invalid-request", "Account bootstrap requires an account locator and local profile path", 400);
      return json(await service.claimCanopyAccount(body.account, body.path, body.displayName as string | undefined), 201);
    }
    if (request.method === "POST" && url.pathname === "/v1/bootstrap/pairings") {
      const body = request.headers.get("content-length") === "0"
        ? {}
        : await request.json().catch(() => ({})) as { configurationTree?: unknown };
      if (body.configurationTree !== undefined && typeof body.configurationTree !== "string") {
        throw new ProtocolError("invalid-request", "configurationTree must be a TreeID", 400);
      }
      return json(await service.createPairingBootstrap(body.configurationTree as string | undefined), 201);
    }
    if (request.method === "POST" && url.pathname === "/v1/local/forget") {
      await service.forgetLocalAccount();
      return json({ forgotten: true });
    }
    return undefined;
  };
}
