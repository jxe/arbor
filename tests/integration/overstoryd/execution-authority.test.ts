import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveHost } from "@ovst/overstoryd";
import {
  ProtocolClient,
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  hashObject,
  type TreeSnapshot,
} from "@ovst/protocol";
import { deviceClient, testAccount } from "../../helpers/devices.ts";

function add(snapshot: TreeSnapshot, name: string, text: string): TreeSnapshot {
  const bytes = new TextEncoder().encode(text),
    hash = hashObject(bytes);
  const dir = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
  const next = encodeProtocolDirectory({
    ...dir,
    entries: [
      ...dir.entries.filter((e) => e.name !== name),
      { name, file: hash },
    ],
  });
  const root = hashObject(next);
  return {
    root,
    objects: new Map([...snapshot.objects, [hash, bytes], [root, next]]),
  };
}

test("execution bearer tokens enforce create-only effects, guards, replay and revocation over HTTP", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "story-execution-"));
  const running = await serveHost({
    dataRoot,
    publicOrigin: "http://127.0.0.1:0",
    port: 0,
    hostname: "127.0.0.1",
    accounts: [testAccount("owner", "owner", { communityWriter: true })],
  });
  try {
    const owner = await deviceClient(running.url, "owner");
    const account = running.overstoryd.accountByHandle("owner")!;
    const tree = account.id;
    const current = await owner.descriptor(tree);
    const snapshot = await owner.snapshot(tree, current.tree.root);
    let sessionActive = true;
    const token = running.overstoryd.execution.issue({
      code: "tr_supplies",
      version: "v1",
      caller: account.id,
      subject: account.id,
      expiresAt: Date.now() + 60000,
      active: () => sessionActive,
      grants: [
        {
          lender: null,
          tree,
          within: "/",
          allow: ["create-child"],
        },
      ],
    });
    const code = new ProtocolClient(running.url, token);
    const candidate = add(snapshot, "note.txt", "hello");
    await expect(
      code.submitUpdate(tree, current.tree.update, candidate)
    ).rejects.toThrow();
    const options = {
      change: "execution-create",
      ifCurrent: current.tree.update,
    };
    const accepted = await code.submitUpdate(
      tree,
      current.tree.update,
      candidate,
      options
    );
    expect(accepted.outcome).toBe("accepted");
    const replay = await code.submitUpdate(
      tree,
      current.tree.update,
      candidate,
      options
    );
    expect(replay.update.id).toBe(accepted.update.id);
    await expect(code.descriptor(tree)).rejects.toThrow();
    await expect(code.snapshot(tree, candidate.root)).rejects.toThrow();
    const watch = await fetch(`${running.url}/.overstory/trees/${tree}/watch`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(watch.status).toBe(404);
    await expect(
      code.submitUpdate(
        tree,
        accepted.update.id,
        add(candidate, "note.txt", "overwrite"),
        { ifCurrent: accepted.update.id }
      )
    ).rejects.toThrow();
    await expect(
      code.submitUpdate(
        tree,
        current.tree.update,
        add(snapshot, "second.txt", "stale"),
        { ifCurrent: current.tree.update }
      )
    ).rejects.toThrow();
    sessionActive = false;
    await expect(
      code.submitUpdate(tree, current.tree.update, candidate, options)
    ).rejects.toThrow();
    expect((await owner.descriptor(tree)).tree.update).toBe(accepted.update.id);
    const forged = await fetch(`${running.url}/.overstory/trees/${tree}/updates`, {
      method: "POST",
      headers: {
        authorization: "Bearer execution_forged",
        "overstory-via": "tr_supplies",
      },
      body: "{}",
    });
    expect(forged.status).toBe(401);
  } finally {
    running.server.stop(true);
    await running.overstoryd[Symbol.asyncDispose]();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("authority invalidation stream and whole-tree watch stop on execution revocation", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "story-execution-watch-"));
  const running = await serveHost({
    dataRoot,
    publicOrigin: "http://127.0.0.1:0",
    port: 0,
    hostname: "127.0.0.1",
    accounts: [testAccount("owner", "owner", { communityWriter: true })],
  });
  const abort = new AbortController();
  try {
    const account = running.overstoryd.accountByHandle("owner")!;
    const token = running.overstoryd.execution.issue({
      code: "tr_supplies",
      version: "v1",
      caller: account.id,
      subject: account.id,
      expiresAt: Date.now() + 60000,
      active: () => true,
      grants: [
        {
          lender: null,
          tree: account.id,
          within: "/",
          allow: ["read"],
        },
      ],
    });
    const headers = { authorization: `Bearer ${token}` };
    const response = await fetch(
      `${running.url}/.overstory/execution/authority-watch`,
      { headers, signal: abort.signal }
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "event: refresh"
    );
    const watch = await fetch(
      `${running.url}/.overstory/trees/${account.id}/watch`,
      { headers, signal: abort.signal }
    );
    expect(watch.status).toBe(200);
    const watchReader = watch.body!.getReader();
    await watchReader.read();
    running.overstoryd.execution.revoke(token);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "event: revoked"
    );
    expect((await reader.read()).done).toBe(true);
    // The revoked watch closes without resync-required.
    const revoked = await Promise.race([
      watchReader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Watch did not revoke")), 2000)
      ),
    ]);
    expect(revoked.done).toBe(true);
  } finally {
    abort.abort();
    running.server.stop(true);
    await running.overstoryd[Symbol.asyncDispose]();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("a grant over any tree reads exactly what its caller may read, and nothing else", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "story-execution-any-"));
  const running = await serveHost({
    dataRoot,
    publicOrigin: "http://127.0.0.1:0",
    port: 0,
    hostname: "127.0.0.1",
    accounts: [
      testAccount("owner", "owner", { communityWriter: true }),
      testAccount("reader", "reader"),
    ],
  });
  try {
    const owner = running.overstoryd.accountByHandle("owner")!;
    const reader = running.overstoryd.accountByHandle("reader")!;
    const issue = (grant: Record<string, unknown>) => running.overstoryd.execution.issue({
      code: "tr_supplies",
      version: "v1",
      caller: reader.id,
      subject: reader.id,
      expiresAt: Date.now() + 60000,
      active: () => true,
      grants: [{ lender: null, tree: "*", within: "/", allow: ["read"], ...grant } as never],
    });
    // Never written, never lent, never narrowed.
    expect(() => issue({ allow: ["read", "write"] })).toThrow();
    expect(() => issue({ lender: owner.id })).toThrow();
    expect(() => issue({ within: "/notes" })).toThrow();

    const token = issue({});
    const code = new ProtocolClient(running.url, token);
    const own = await deviceClient(running.url, "reader");
    const status = (read: Promise<unknown>) => read.then(() => 200, (error: { status?: number }) => error.status ?? 0);
    // Whatever the reader's own session may read, the token may; nothing more.
    for (const tree of [reader.id, owner.id, running.overstoryd.community().id]) {
      expect(await status(code.descriptor(tree))).toBe(await status(own.descriptor(tree)));
    }
    expect(await status(code.descriptor(reader.id))).toBe(200);
    const current = await code.descriptor(reader.id);
    const snapshot = await own.snapshot(reader.id, current.tree.root);
    await expect(code.submitUpdate(reader.id, current.tree.update, add(snapshot, "note.txt", "hello"), {
      change: "any-tree-write",
      ifCurrent: current.tree.update,
    })).rejects.toThrow();
  } finally {
    running.server.stop(true);
    await running.overstoryd[Symbol.asyncDispose]();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
