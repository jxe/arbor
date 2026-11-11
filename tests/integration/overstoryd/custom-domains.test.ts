import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalURL, ProtocolClient } from "@ovst/protocol";
import { serveHost } from "@ovst/overstoryd";
import { editTreeFile } from "@ovst/client";
import { deviceClient, deviceSession, testAccount, testDevice } from "../../helpers/devices.ts";

/**
 * Trees at a person's domain (locators §5.1): Alice lists a domain in her
 * profile and points it at her host; once the domain answers with the host's
 * token, the host serves her `/~alice` there and names it canonical. The
 * domain here is `localhost:<port>`, the same listener under another name.
 */

let sandbox: string;
let running: Awaited<ReturnType<typeof serveHost>>;
let alice: ProtocolClient;
let profile: string;
let domain: string;
let domainURL: string;

async function setDomains(domains: string[]): Promise<void> {
  await editTreeFile(alice, profile, "_index.md", (text) => {
    const withoutDomains = text.replace(/^domains: .*\n/m, "");
    const line = domains.length ? `domains: [${domains.map((name) => JSON.stringify(name)).join(", ")}]\n` : "";
    return withoutDomains.replace(/^---\n/, `---\n${line}`);
  });
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-custom-domains-"));
  running = await serveHost({
    dataRoot: join(sandbox, "overstoryd"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "garden", name: "Garden" },
    accounts: [testAccount("alice", "domains-alice", { communityWriter: true }), testAccount("bob", "domains-bob")],
  });
  alice = await deviceClient(running.url, "domains-alice");
  profile = testDevice("domains-alice").profileTree;
  domain = `localhost:${new URL(running.url).port}`;
  domainURL = `http://${domain}`;
});

afterAll(async () => {
  running.server.stop(true);
  await running.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("a person's domain", () => {
  test("is served only once her profile lists it and it reaches the host", async () => {
    const source = await (await fetch(`${running.url}/.overstory/peer/domain-check`)).json() as { host: string };
    expect(source.host).toBe(running.overstoryd.customDomains.token);
    // The old path answers the same until plans/soon/protocol-001 removes it.
    expect(await (await fetch(`${running.url}/.overstory/domain-check`)).json()).toEqual(source);
    await running.overstoryd.customDomains.refresh();
    expect(running.overstoryd.customDomains.list()).toEqual([]);
    expect((await alice.descriptor(profile)).tree.canonical?.url).toBeUndefined();

    await setDomains([domain]);
    await running.overstoryd.customDomains.refresh();
    expect(running.overstoryd.customDomains.list()).toEqual([{ domain, profile, prefix: "/~alice" }]);
  });

  test("names her trees' canonical URL, and nobody else's", async () => {
    const canonical = (await alice.descriptor(profile)).tree.canonical!;
    expect(canonical.path).toBe("/~alice");
    expect(canonical.url).toBe(`${domainURL}/`);
    expect(canonicalURL(canonical)).toBe(`${domainURL}/`);
    const community = (await alice.account()).account.community;
    expect(community.canonical?.url).toBeUndefined();
    const people = (await alice.directory()).people;
    expect(people.find((entry) => entry.profile === profile)?.domain).toBe(domain);
  });

  test("resolves and names her at the domain, and sends other accounts' paths home", async () => {
    const resolved = await (await fetch(`${domainURL}/.well-known/overstory`)).json() as { ref: { tree: string; path: string } };
    expect(resolved.ref).toMatchObject({ tree: profile, path: "/" });
    expect(await (await fetch(`${domainURL}/.well-known/overstory-profile`)).json()).toEqual({ profile: `${running.url}/~alice` });
    const elsewhere = await fetch(`${domainURL}/~bob/notes`, { redirect: "manual" });
    expect(elsewhere.status).toBe(308);
    expect(elsewhere.headers.get("location")).toBe(`${running.url}/~bob/notes`);
    // Tree routes, by TreeID, are the same at every name.
    const atDomain = new ProtocolClient(domainURL, await deviceSession(running.url, "domains-alice"));
    expect((await atDomain.descriptor(profile)).tree.id).toBe(profile);
  });

  test("sends a browser at the host's own name to the domain, and leaves API reads alone", async () => {
    const browser = await fetch(`${running.url}/~alice/drafts?x=1`, { redirect: "manual", headers: { accept: "text/html" } });
    expect(browser.status).toBe(301);
    expect(browser.headers.get("location")).toBe(`${domainURL}/drafts?x=1`);
    const lookup = await fetch(`${running.url}/.well-known/overstory/~alice`);
    expect(lookup.status).toBe(200);
  });

  test("stops being served when her profile drops it", async () => {
    await setDomains([]);
    await running.overstoryd.customDomains.refresh();
    expect(running.overstoryd.customDomains.list()).toEqual([]);
    expect((await alice.descriptor(profile)).tree.canonical?.url).toBeUndefined();
    const browser = await fetch(`${running.url}/~alice`, { redirect: "manual", headers: { accept: "text/html" } });
    expect(browser.status).not.toBe(301);
  });
});
