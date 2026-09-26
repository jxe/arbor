import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProtocolClient, treeConfigurationID } from "@overstory/protocol";
import { serveHost } from "@overstory/canopyd";

test("canonical ;arbor-config locators resolve a tree's configuration for its administrators only", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "arbor-config-locators-"));
  const running = await serveHost({
    dataRoot,
    publicOrigin: "http://127.0.0.1:0",
    port: 0,
    hostname: "127.0.0.1",
    accounts: [{ handle: "owner", token: "owner", communityWriter: true }],
  });
  try {
    const owner = new ProtocolClient(running.url, "owner");
    const profile = running.canopy.accountByHandle("owner")!.profileTree!;
    const configuration = treeConfigurationID(profile);

    const resolved = await owner.resolveConfiguration("/~owner");
    expect(resolved.ref).toEqual({ tree: configuration, path: "/", stableKey: null });
    expect(resolved.enclosingTree).toMatchObject({ id: configuration, kind: "tree-configuration", canonical: null });

    // Only a tree's root has a configuration, and a percent-encoded `;` is a filename.
    const status = async (path: string, token?: string) =>
      (await fetch(`${running.url}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: "manual" })).status;
    expect(await status("/.well-known/arbor/~owner/notes;arbor-config", "owner")).toBe(404);
    const literal = await (await fetch(`${running.url}/.well-known/arbor/~owner%3Barbor-config`, { headers: { authorization: "Bearer owner" } })).json();
    expect(literal.ref.path).toBe("/~owner;arbor-config");
    // Anyone else sees what an unreadable tree shows.
    await expect(new ProtocolClient(running.url).resolveConfiguration("/~owner")).rejects.toThrow();
    expect(await status("/.well-known/arbor/~owner;arbor-config")).toBe(404);

    // The canonical URL sends an administrator to the configuration's descriptor.
    const redirect = await fetch(`${running.url}/~owner;arbor-config`, { headers: { authorization: "Bearer owner" }, redirect: "manual" });
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("location")).toBe(`/.arbor/trees/${profile};arbor-config`);
    const descriptor = await fetch(new URL(redirect.headers.get("location")!, running.url), { headers: { authorization: "Bearer owner" } });
    expect((await descriptor.json()).tree.id).toBe(configuration);
    expect(await status("/~owner;arbor-config")).toBe(404);
  } finally {
    running.server.stop(true);
    await running.canopy[Symbol.asyncDispose]();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
