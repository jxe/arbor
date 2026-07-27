import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArbor } from "@arbor/arbord";
import { ArbordClient } from "@arbor/client";
import type { RootDescriptor, RootsPage } from "@arbor/core";

let outer: string;
let sessionRoot: string;
let otherRoot: string;
let state: string;
let base: string;
let client: ArbordClient;
let close: () => Promise<void>;

async function launch(path: string) {
  const running = await serveArbor(path, { port: 0 });
  base = running.url;
  client = new ArbordClient({ baseURL: base, retryDelay: async () => {} });
  close = async () => {
    running.server.stop(true);
    await running.service[Symbol.asyncDispose]();
  };
  return running;
}

beforeAll(async () => {
  outer = await realpath(await mkdtemp(join(tmpdir(), "arbor-roots-")));
  state = await mkdtemp(join(tmpdir(), "arbor-roots-state-"));
  process.env.ARBOR_DATA_HOME = state;
  sessionRoot = join(outer, "session");
  otherRoot = join(outer, "library");
  await mkdir(sessionRoot);
  await mkdir(otherRoot);
  await writeFile(join(sessionRoot, "here.md"), "Session content\n");
  await writeFile(join(otherRoot, "essay.md"), "---\nid: lib001\n---\nLibrary essay about ferns\n");
  await launch(sessionRoot);
});

afterAll(async () => {
  await close();
  await rm(outer, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

describe("tracked roots", () => {
  test("the session root starts session-scoped and can be kept", async () => {
    const before = await fetch(`${base}/v1/roots`).then((r) => r.json()) as RootsPage;
    expect(before.roots.map((root) => root.tracking)).toEqual(["session"]);
    expect(before.home).toBeString();

    const tracked = await fetch(`${base}/v1/roots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: sessionRoot }),
    }).then((r) => r.json()) as RootDescriptor;
    expect(tracked.tracking).toBe("tracked");
    expect(tracked.osPath).toBe(sessionRoot);

    const node = await client.node({ path: "/here" });
    expect(node.enclosingRoot?.tracking).toBe("tracked");
  });

  test("tracking another folder makes it browsable, searchable, and durable", async () => {
    const tracked = await fetch(`${base}/v1/roots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: otherRoot }),
    }).then((r) => r.json()) as RootDescriptor;
    expect(tracked.tracking).toBe("tracked");

    // Idempotent by canonical path.
    const again = await fetch(`${base}/v1/roots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: otherRoot }),
    }).then((r) => r.json()) as RootDescriptor;
    expect(again.id).toBe(tracked.id);

    // A local ref inside the tracked root canonicalizes into it.
    const essay = await client.node({ tree: "local", path: join(otherRoot, "essay") });
    expect(essay.tree).toBe(tracked.id);
    expect(essay.path).toBe("/essay");

    // Its index serves scoped search.
    const results = await fetch(`${base}/v1/search?tree=${tracked.id}&q=ferns`).then((r) => r.json()) as {
      results: Array<{ tree?: string; path: string }>;
    };
    expect(results.results).toHaveLength(1);
    expect(results.results[0]).toMatchObject({ tree: tracked.id, path: "/essay" });

    // A bare pageID fans out into the non-session root.
    const byID = await client.node({ pageID: "lib001" });
    expect(byID.tree).toBe(tracked.id);
    expect(byID.path).toBe("/essay");

    // A cross-root duplicate is a tree-qualified diagnostic, never a choice.
    const dupeRoot = join(outer, "duplicate-holder");
    await mkdir(dupeRoot);
    await writeFile(join(dupeRoot, "copy.md"), "---\nid: lib001\n---\nA duplicated identity\n");
    const holder = await fetch(`${base}/v1/roots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dupeRoot }),
    }).then((r) => r.json()) as RootDescriptor;
    const conflict = await fetch(`${base}/v1/node?pageID=lib001`);
    expect(conflict.status).toBe(409);
    const body = await conflict.json() as { error: { code: string; owners?: string[] } };
    expect(body.error.code).toBe("duplicate-page-id");
    expect(body.error.owners?.some((owner) => owner.startsWith(otherRoot))).toBe(true);
    expect(body.error.owners?.some((owner) => owner.startsWith(dupeRoot))).toBe(true);
    await fetch(`${base}/v1/roots?id=${holder.id}`, { method: "DELETE" });

    // Nesting an existing root is refused until mounts define overlap.
    const nested = await fetch(`${base}/v1/roots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: outer }),
    });
    expect(nested.status).toBe(422);
  });

  test("system:roots is browsable read-only", async () => {
    const system = await client.node({ tree: "system", path: "/" });
    expect(system.kind).toBe("directory");
    expect(system.writable).toBe(false);
    const roots = await client.children({ tree: "system", path: "/roots" });
    expect(roots.items.length).toBe(2);
    const first = roots.items[0]!;
    const page = await client.node({ tree: "system", path: first.path });
    expect(page.kind).toBe("markdown");
    expect(page.writable).toBe(false);
    expect(page.document?.frontmatter.path).toBeString();

    const write = await fetch(`${base}/v1/mutations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mutationID: "system-write-refused",
        operations: [{
          op: "writeMarkdown",
          ref: { tree: "system", path: first.path },
          baseContentRevision: page.contentRevision,
          blocks: page.document!.blocks,
        }],
      }),
    });
    expect(write.status).toBe(422);
  });

  test("tracked roots survive a daemon restart and untrack removes the record", async () => {
    await close();
    const restarted = await launch(sessionRoot);
    expect(restarted.workspace.tracking).toBe("tracked");

    const page = await fetch(`${base}/v1/roots`).then((r) => r.json()) as RootsPage;
    expect(page.roots.filter((root) => root.tracking === "tracked")).toHaveLength(2);
    const library = page.roots.find((root) => root.osPath === otherRoot)!;

    // The restarted daemon still resolves into the other tracked root lazily.
    const essay = await client.node({ tree: "local", path: join(otherRoot, "essay") });
    expect(essay.tree).toBe(library.id);

    const removed = await fetch(`${base}/v1/roots?id=${library.id}`, { method: "DELETE" })
      .then((r) => r.json()) as RootsPage;
    expect(removed.roots.some((root) => root.id === library.id)).toBe(false);

    // Now untracked: the same path reads in local scope.
    const untrackedRead = await client.node({ tree: "local", path: join(otherRoot, "essay") });
    expect(untrackedRead.tree).toBe("local");
  });

  test("launching inside a tracked root joins that root's identity", async () => {
    await close();
    const running = await launch(sessionRoot);
    const id = running.workspace.tree;
    await close();
    const fromSubdir = await serveArbor(sessionRoot, { port: 0 });
    expect(fromSubdir.workspace.tree).toBe(id);
    fromSubdir.server.stop(true);
    await fromSubdir.service[Symbol.asyncDispose]();
    await launch(sessionRoot);
  });
});
