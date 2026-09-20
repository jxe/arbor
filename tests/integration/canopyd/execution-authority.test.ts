import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveCanopy } from "@overstory/canopyd";
import {
  WireClient,
  decodeWireDirectory,
  encodeWireDirectory,
  hashObject,
  type TreeSnapshot,
} from "@overstory/protocol";

function add(snapshot: TreeSnapshot, name: string, text: string): TreeSnapshot {
  const bytes = new TextEncoder().encode(text),
    hash = hashObject(bytes);
  const dir = decodeWireDirectory(snapshot.objects.get(snapshot.root)!);
  const next = encodeWireDirectory({
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
  const dataRoot = await mkdtemp(join(tmpdir(), "arbor-execution-"));
  const running = await serveCanopy({
    dataRoot,
    publicOrigin: "http://127.0.0.1:0",
    port: 0,
    hostname: "127.0.0.1",
    accounts: [{ handle: "owner", token: "owner", communityWriter: true }],
  });
  try {
    const owner = new WireClient(running.url, "owner");
    const account = running.canopy.accountByHandle("owner")!;
    const tree = account.profileTree!;
    const current = await owner.descriptor(tree);
    const snapshot = await owner.snapshot(tree, current.tree.root);
    let sessionActive = true;
    const token = running.canopy.execution.issue({
      code: "tr_supplies",
      version: "v1",
      caller: account.id,
      sponsor: account.id,
      subject: account.profileTree!,
      expiresAt: Date.now() + 60000,
      active: () => sessionActive,
      grants: [
        {
          account: account.id,
          role: "user",
          tree,
          within: "/",
          allow: ["create-child"],
        },
      ],
    });
    const code = new WireClient(running.url, token);
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
    const watch = await fetch(`${running.url}/.arbor/trees/${tree}/watch`, {
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
    const forged = await fetch(`${running.url}/.arbor/trees/${tree}/updates`, {
      method: "POST",
      headers: {
        authorization: "Bearer execution_forged",
        "x-arbor-via": "tr_supplies",
      },
      body: "{}",
    });
    expect(forged.status).toBe(401);
  } finally {
    running.server.stop(true);
    await running.canopy[Symbol.asyncDispose]();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("authority invalidation stream and whole-tree watch stop on execution revocation", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "arbor-execution-watch-"));
  const running = await serveCanopy({
    dataRoot,
    publicOrigin: "http://127.0.0.1:0",
    port: 0,
    hostname: "127.0.0.1",
    accounts: [{ handle: "owner", token: "owner", communityWriter: true }],
  });
  const abort = new AbortController();
  try {
    const account = running.canopy.accountByHandle("owner")!;
    const token = running.canopy.execution.issue({
      code: "tr_supplies",
      version: "v1",
      caller: account.id,
      sponsor: account.id,
      subject: account.profileTree!,
      expiresAt: Date.now() + 60000,
      active: () => true,
      grants: [
        {
          account: account.id,
          role: "user",
          tree: account.profileTree!,
          within: "/",
          allow: ["read"],
        },
      ],
    });
    const headers = { authorization: `Bearer ${token}` };
    const response = await fetch(
      `${running.url}/.arbor/execution/authority-watch`,
      { headers, signal: abort.signal }
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "event: refresh"
    );
    const watch = await fetch(
      `${running.url}/.arbor/trees/${account.profileTree}/watch`,
      { headers, signal: abort.signal }
    );
    expect(watch.status).toBe(200);
    const watchReader = watch.body!.getReader();
    await watchReader.read();
    running.canopy.execution.revoke(token);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "event: revoked"
    );
    expect((await reader.read()).done).toBe(true);
    const revoked = await Promise.race([
      watchReader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Watch did not revoke")), 2000)
      ),
    ]);
    expect(new TextDecoder().decode(revoked.value)).toContain(
      "Authorization was revoked"
    );
  } finally {
    abort.abort();
    running.server.stop(true);
    await running.canopy[Symbol.asyncDispose]();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
