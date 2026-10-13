import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readStorySyncAccess, storySyncAccessPath } from "@ovst/protocol";
import { serveStorySyncControl } from "@ovst/story-sync";
import { storySyncFetch } from "../helpers/story-sync-fetch.ts";

// Security 011: two people logged in to one Mac, each with a data home, share loopback.
const homes: string[] = [];
const previous = process.env.STORY_HOME;

afterAll(async () => {
  if (previous === undefined) delete process.env.STORY_HOME;
  else process.env.STORY_HOME = previous;
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

async function home(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `story-callers-${name}-`));
  homes.push(path);
  return path;
}

/** A free loopback port to contend for. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

test("a second data home's Story Sync takes the next port, and neither answers the other's callers", async () => {
  const port = freePort();
  const alice = await home("alice");
  const bob = await home("bob");
  process.env.STORY_HOME = alice;
  const first = await serveStorySyncControl({ port });
  process.env.STORY_HOME = bob;
  const second = await serveStorySyncControl({ port });
  try {
    expect(first.url).toBe(`http://127.0.0.1:${port}`);
    expect(second.url).not.toBe(first.url);
    expect((await readStorySyncAccess(alice))?.origin).toBe(first.url);
    expect((await readStorySyncAccess(bob))?.origin).toBe(second.url);
    expect((await stat(storySyncAccessPath(alice))).mode & 0o777).toBe(0o600);

    for (const [daemon, own, other] of [[first, alice, bob], [second, bob, alice]] as const) {
      expect((await storySyncFetch(`${daemon.url}/v1/status`, {}, own)).status).toBe(200);
      for (const route of ["/v1/status", "/v1/trees", "/v1/accounts", "/v1/credential"]) {
        expect((await storySyncFetch(`${daemon.url}${route}`, {}, other)).status, route).toBe(401);
        expect((await fetch(`${daemon.url}${route}`)).status, route).toBe(401);
      }
    }

    // A data home whose own Story Sync already holds the port does not start a second.
    process.env.STORY_HOME = alice;
    await expect(serveStorySyncControl({ port })).rejects.toThrow("already listening");
  } finally {
    for (const daemon of [first, second]) {
      daemon.server.stop(true);
      await daemon.service[Symbol.asyncDispose]();
    }
  }
});
