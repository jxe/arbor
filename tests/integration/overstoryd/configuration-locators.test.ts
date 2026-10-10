import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProtocolClient, treeConfigurationID } from "@ovst/protocol";
import { serveHost } from "@ovst/overstoryd";
import { deviceClient, deviceSession, testAccount } from "../../helpers/devices.ts";

test("canonical ;overstory-config locators resolve a tree's configuration for its administrators only", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "overstory-config-locators-"));
  const running = await serveHost({
    dataRoot,
    publicOrigin: "http://127.0.0.1:0",
    port: 0,
    hostname: "127.0.0.1",
    accounts: [testAccount("owner", "owner", { communityWriter: true })],
  });
  try {
    const owner = await deviceClient(running.url, "owner");
    const session = await deviceSession(running.url, "owner");
    const profile = running.overstoryd.accountByHandle("owner")!.id;
    const configuration = treeConfigurationID(profile);

    const resolved = await owner.resolveConfiguration("/~owner");
    expect(resolved.ref).toEqual({ tree: configuration, path: "/", stableKey: null });
    expect(resolved.enclosingTree).toMatchObject({ id: configuration, kind: "tree-configuration", canonical: null });

    // Only a tree's root has a configuration, and a percent-encoded `;` is a filename.
    const status = async (path: string, token?: string) =>
      (await fetch(`${running.url}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: "manual" })).status;
    expect(await status("/.well-known/overstory/~owner/notes;overstory-config", session)).toBe(404);
    const literal = await (await fetch(`${running.url}/.well-known/overstory/~owner%3Boverstory-config`, { headers: { authorization: `Bearer ${session}` } })).json();
    expect(literal.ref.path).toBe("/~owner;overstory-config");
    // Anyone else sees what an unreadable tree shows.
    await expect(new ProtocolClient(running.url).resolveConfiguration("/~owner")).rejects.toThrow();
    expect(await status("/.well-known/overstory/~owner;overstory-config")).toBe(404);

    // The canonical URL sends an administrator to the configuration's descriptor.
    const redirect = await fetch(`${running.url}/~owner;overstory-config`, { headers: { authorization: `Bearer ${session}` }, redirect: "manual" });
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("location")).toBe(`/.overstory/trees/${profile};overstory-config`);
    const descriptor = await fetch(new URL(redirect.headers.get("location")!, running.url), { headers: { authorization: `Bearer ${session}` } });
    expect((await descriptor.json()).tree.id).toBe(configuration);
    expect(await status("/~owner;overstory-config")).toBe(404);

    // Rename 002: the old `;arbor-config` spelling is still read everywhere the
    // parameter is; the redirect answers in the current spelling.
    const oldResolved = await (await fetch(`${running.url}/.well-known/overstory/~owner;arbor-config`, { headers: { authorization: `Bearer ${session}` } })).json();
    expect(oldResolved.ref).toEqual({ tree: configuration, path: "/", stableKey: null });
    expect(await status("/.well-known/overstory/~owner;arbor-config")).toBe(404);
    const oldRedirect = await fetch(`${running.url}/~owner;arbor-config`, { headers: { authorization: `Bearer ${session}` }, redirect: "manual" });
    expect(oldRedirect.status).toBe(303);
    expect(oldRedirect.headers.get("location")).toBe(`/.overstory/trees/${profile};overstory-config`);
    const oldDescriptor = await fetch(`${running.url}/.overstory/trees/${profile};arbor-config`, { headers: { authorization: `Bearer ${session}` } });
    expect((await oldDescriptor.json()).tree.id).toBe(configuration);
  } finally {
    running.server.stop(true);
    await running.overstoryd[Symbol.asyncDispose]();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
