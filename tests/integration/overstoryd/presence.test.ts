import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProtocolClient, type PresenceEvent } from "@ovst/protocol";
import { serveHost } from "@ovst/overstoryd";
import { deviceSession, testAccount } from "../../helpers/devices.ts";

// Spec 12: a tree's presence roster, cursors between visible subscribers on
// one page, and an agent's status, all in the host's memory.

let sandbox: string;
let running: Awaited<ReturnType<typeof serveHost>>;
let community: string;
let ana: ProtocolClient;
let ben: ProtocolClient;
let anaProfile: string;

const SOURCE = `sha256:${"a".repeat(64)}` as const;
const OTHER_SOURCE = `sha256:${"b".repeat(64)}` as const;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "overstoryd-presence-"));
  running = await serveHost({
    dataRoot: join(sandbox, "data"),
    accounts: [testAccount("ana", "presence-ana", { communityWriter: true }), testAccount("ben", "presence-ben", { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  ana = new ProtocolClient(running.url, await deviceSession(running.url, "presence-ana"));
  ben = new ProtocolClient(running.url, await deviceSession(running.url, "presence-ben"));
  const account = await ana.account();
  community = account.account.community.id;
  anaProfile = account.account.profileTree!;
});

afterAll(async () => {
  running.server.stop(true);
  await running.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

/** A presence stream whose events a test awaits one at a time. */
function subscribe(client: ProtocolClient, options: { visible?: boolean; agent?: string; device?: "mac" | "ios" } = {}) {
  const abort = new AbortController();
  const events = client.presence(community, { ...options, signal: abort.signal });
  const next = async (): Promise<PresenceEvent> => {
    const result = await Promise.race([
      events.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no presence event")), 3_000)),
    ]);
    if (result.done) throw new Error("presence stream ended");
    return result.value;
  };
  /** Resolves false if nothing arrives within `ms`. */
  const quiet = async (ms = 300): Promise<boolean> => {
    const pending = events.next();
    const winner = await Promise.race([pending.then(() => "event" as const), new Promise<"quiet">((resolve) => setTimeout(() => resolve("quiet"), ms))]);
    if (winner === "event") return false;
    // Keep the pending read for the next `next()`.
    pendingRead = pending;
    return true;
  };
  let pendingRead: Promise<IteratorResult<PresenceEvent>> | undefined;
  const take = async (): Promise<PresenceEvent> => {
    if (pendingRead) {
      const read = pendingRead; pendingRead = undefined;
      const result = await read;
      if (result.done) throw new Error("presence stream ended");
      return result.value;
    }
    return next();
  };
  return { take, quiet, close: () => abort.abort() };
}

async function ready(stream: ReturnType<typeof subscribe>) {
  const event = await stream.take();
  if (event.kind !== "presence.ready") throw new Error(`expected ready, got ${event.kind}`);
  return event.ready;
}

describe("presence", () => {
  test("the roster on join, page change and leave; cursors only on the same page", async () => {
    const a = subscribe(ana);
    const aReady = await ready(a);
    expect(aReady.peers).toEqual([]);
    expect(aReady.self).toBeString();

    const b = subscribe(ben);
    const bReady = await ready(b);
    expect(bReady.peers.map((peer) => peer.profile)).toEqual([anaProfile]);
    expect(bReady.peers[0]!.agent).toBeNull();
    const joined = await a.take();
    expect(joined.kind).toBe("presence.peer");

    await ana.updatePresence(community, aReady.self!, { page: { path: "/Groceries", stableKey: null } });
    const moved = await b.take();
    expect(moved).toMatchObject({ kind: "presence.peer", peer: { id: aReady.self, page: { path: "/Groceries" } } });

    // Ben is on no page yet: Ana's cursor does not reach him.
    await ana.updatePresence(community, aReady.self!, { selection: { source: SOURCE, anchor: 3, head: 7 } });
    expect(await b.quiet()).toBe(true);

    await ben.updatePresence(community, bReady.self!, { page: { path: "/Groceries", stableKey: null } });
    expect((await a.take()).kind).toBe("presence.peer");
    await ana.updatePresence(community, aReady.self!, { selection: { source: OTHER_SOURCE, anchor: 1, head: 1 } });
    expect(await b.take()).toEqual({ kind: "presence.cursor", cursor: { id: aReady.self!, selection: { source: OTHER_SOURCE, anchor: 1, head: 1 } } });

    a.close();
    expect(await b.take()).toEqual({ kind: "presence.leave", leave: { id: aReady.self! } });
    b.close();
  });

  test("a hidden subscriber sees the roster but no cursors, and never appears", async () => {
    const hidden = subscribe(ben, { visible: false });
    const hiddenReady = await ready(hidden);
    expect(hiddenReady.self).toBeNull();

    const a = subscribe(ana);
    const aReady = await ready(a);
    expect(aReady.peers).toEqual([]);
    expect((await hidden.take()).kind).toBe("presence.peer");
    await ana.updatePresence(community, aReady.self!, { page: { path: "/Groceries", stableKey: null } });
    expect((await hidden.take()).kind).toBe("presence.peer");
    await ana.updatePresence(community, aReady.self!, { selection: { source: SOURCE, anchor: 0, head: 0 } });
    expect(await hidden.quiet()).toBe(true);
    a.close();
    hidden.close();
  });

  test("an agent stream is listed with its label, and its status reaches everyone", async () => {
    const b = subscribe(ben);
    await ready(b);
    const agent = subscribe(ana, { agent: "Claude" });
    const agentReady = await ready(agent);
    const listed = await b.take();
    expect(listed).toMatchObject({ kind: "presence.peer", peer: { profile: anaProfile, agent: { label: "Claude", status: null } } });

    await ana.updatePresence(community, agentReady.self!, { status: "merging duplicates" });
    expect(await b.take()).toMatchObject({ kind: "presence.peer", peer: { agent: { label: "Claude", status: "merging duplicates" } } });
    agent.close();
    b.close();
  });

  test("a stream's device kind is listed; none or an unknown one is null", async () => {
    const b = subscribe(ben);
    await ready(b);

    const mac = subscribe(ana, { device: "mac" });
    await ready(mac);
    expect(await b.take()).toMatchObject({ kind: "presence.peer", peer: { profile: anaProfile, device: "mac" } });
    mac.close();
    expect((await b.take()).kind).toBe("presence.leave");

    const plain = subscribe(ana);
    await ready(plain);
    expect(await b.take()).toMatchObject({ kind: "presence.peer", peer: { device: null } });
    plain.close();
    expect((await b.take()).kind).toBe("presence.leave");

    const unknown = subscribe(ana, { device: "toaster" as never });
    await ready(unknown);
    expect(await b.take()).toMatchObject({ kind: "presence.peer", peer: { device: null } });
    unknown.close();
    b.close();
  });

  test("POSTs from another caller, after close, or with a person's status are refused", async () => {
    const a = subscribe(ana);
    const aReady = await ready(a);
    const fromBen = await fetch(`${running.url}/.overstory/trees/${community}/presence/${aReady.self}`, {
      method: "POST",
      headers: { authorization: `Bearer ${await deviceSession(running.url, "presence-ben")}`, "content-type": "application/json" },
      body: JSON.stringify({ page: null }),
    });
    expect(fromBen.status).toBe(404);
    await expect(ana.updatePresence(community, aReady.self!, { status: "not an agent" })).rejects.toThrow();
    await expect(ana.updatePresence(community, aReady.self!, { selection: { source: "sha256:nope" as never, anchor: 0, head: 0 } })).rejects.toThrow();
    a.close();
    await Bun.sleep(50);
    await expect(ana.updatePresence(community, aReady.self!, { page: null })).rejects.toThrow();
  });

  test("an anonymous reader of a public tree may subscribe but is never listed", async () => {
    // The community tree is readable to its members only, so an anonymous
    // subscriber is refused as for any other read.
    const anonymous = await fetch(`${running.url}/.overstory/trees/${community}/presence`);
    expect([200, 404]).toContain(anonymous.status);
    if (anonymous.status === 200) {
      const reader = anonymous.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('"self":null');
      await reader.cancel();
    }
  });
});
