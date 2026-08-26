import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveWorkspace } from "@arbor/arbord";
import { serveWireHost } from "@arbor/authority";
import { generateArborID } from "@arbor/core";
import { snapshotDirectory, WireClient } from "@arbor/wire";
import { readAccountConfigGraph, snapshotAccountConfig } from "../../packages/authority/src/account-policy.ts";

async function run(command: string[], environment: Record<string, string> = {}): Promise<void> {
  const process = Bun.spawn(command, {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, ...environment },
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await process.exited;
  if (status !== 0) throw new Error(`${command.join(" ")} exited with ${status}`);
}

const root = await mkdtemp(join(tmpdir(), "arbor-protocol-"));
const state = await mkdtemp(join(tmpdir(), "arbor-protocol-state-"));
const authorityState = await mkdtemp(join(tmpdir(), "arbor-wire-protocol-state-"));
const previousDataHome = process.env.ARBOR_DATA_HOME;
process.env.ARBOR_DATA_HOME = state;

try {
  await writeFile(join(root, "page.md"), "Shared live-server fixture\n");
  await run(["bun", "test", "tests/unit/protocol.test.ts"]);
  const running = await serveWorkspace(root, { port: 0 });
  try {
    await run(
      ["swift", "test", "--package-path", "native/Packages/ArborClient"],
      {
        ARBOR_PROTOCOL_FIXTURES: join(import.meta.dir, "../../spec/fixtures"),
        ARBOR_TEST_URL: running.url,
        ARBOR_TEST_TREE: running.workspace.tree,
      },
    );
    await run(
      ["swift", "test", "--package-path", "native/Packages/ArborProviders"],
      { ARBOR_TEST_URL: running.url, ARBOR_TEST_TREE: running.workspace.tree },
    );
  } finally {
    running.server.stop(true);
    await running.workspace[Symbol.asyncDispose]();
  }
  const authorityToken = "swift-protocol-device-token";
  const authority = await serveWireHost({
    dataRoot: authorityState,
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    accounts: [{ handle: "owner", token: authorityToken, communityWriter: true }],
  });
  try {
    const nativeTreeRoot = await mkdtemp(join(tmpdir(), "arbor-native-wire-tree-"));
    const nativeTreeID = generateArborID("tr");
    try {
      await writeFile(join(nativeTreeRoot, "note.md"), "---\nid: pg_note\n---\n\n# Note\n\nBase\n");
      const owner = new WireClient(authority.url, authorityToken);
      const account = await owner.account();
      const current = await owner.currentSnapshot(account.account.configuration.id);
      const graph = readAccountConfigGraph({
        root: current.snapshot.root,
        objects: new Map(current.snapshot.objects.map(({ hash, bytes }) => [hash, bytes])),
      }, account.account.configuration.id);
      const administrator = graph.account.admins[0]!;
      const configured = snapshotAccountConfig({
        account: graph.account,
        trees: { version: 1, trees: {
          ...graph.trees.trees,
          [nativeTreeID]: { kind: "shared-subtree", canonicalPath: "/~owner/native-sync", access: [] },
        } },
        devices: {
          ...graph.devices,
          [administrator]: { ...graph.devices[administrator]!, placements: {
            ...graph.devices[administrator]!.placements,
            [nativeTreeID]: { authority: new URL(authority.url).origin, path: nativeTreeRoot },
          } },
        },
      });
      await owner.submitUpdate(
        current.tree.id,
        { root: current.tree.ref, update: current.tree.update },
        configured,
      );
      await owner.activateTree(nativeTreeID, await snapshotDirectory(nativeTreeRoot));
      await run(
        ["swift", "test", "--package-path", "native/Packages/ArborWire"],
        {
          ARBOR_PROTOCOL_FIXTURES: join(import.meta.dir, "../../spec/fixtures"),
          ARBOR_WIRE_TEST_URL: authority.url,
          ARBOR_WIRE_TEST_TOKEN: authorityToken,
          ARBOR_WIRE_TEST_TREE: nativeTreeID,
        },
      );
      await run(
        ["swift", "test", "--package-path", "native/Packages/ArborSync"],
        {
          ARBOR_PROTOCOL_FIXTURES: join(import.meta.dir, "../../spec/fixtures"),
          ARBOR_WIRE_TEST_URL: authority.url,
          ARBOR_WIRE_TEST_TOKEN: authorityToken,
          ARBOR_WIRE_TEST_TREE: nativeTreeID,
        },
      );
    } finally {
      await rm(nativeTreeRoot, { recursive: true, force: true });
    }
  } finally {
    authority.server.stop(true);
    await authority.authority[Symbol.asyncDispose]();
  }
} finally {
  if (previousDataHome === undefined) delete process.env.ARBOR_DATA_HOME;
  else process.env.ARBOR_DATA_HOME = previousDataHome;
  await rm(root, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
  await rm(authorityState, { recursive: true, force: true });
}
