import { executeExactSourceEdits } from "../../packages/canopy/src/updates/source-edits.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArborSyncControl } from "@arbor/arborsync";
import { serveCanopy } from "@arbor/canopy";
import { canonicalArborLocator, generateArborID } from "@arbor/core";
import { CommunityConfigStore, saveCurrentDeviceID } from "@arbor/stores";
import { WireClient, decodeWireDirectory, type SourceOperation } from "@arbor/wire";
import { readAccountConfigGraph, snapshotAccountConfig } from "../../packages/canopy/src/account-policy.ts";
import { resolveSnapshot, snapshotDirectory } from "@arbor/fs";

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

const fixtures = {
  ARBOR_PROTOCOL_FIXTURES: join(import.meta.dir, "../../conformance"),
  ARBOR_REFERENCE_FIXTURES: join(import.meta.dir, "../fixtures"),
};

const sandbox = await mkdtemp(join(tmpdir(), "arbor-protocol-"));
const home = join(sandbox, "home");
const treeDir = join(sandbox, "tree");
const authorityState = join(sandbox, "canopy");
const previousDataHome = process.env.ARBOR_DATA_HOME;

try {
  await run(["bun", "test", "tests/unit/protocol.test.ts", "tests/unit/wire/update-intent.test.ts", "tests/unit/wire/operations.test.ts", "tests/unit/wire/authored-contract.test.ts", "tests/unit/wire/accepted-contract.test.ts", "tests/unit/wire/accepted-transport.test.ts", "tests/unit/wire/authored-transport.test.ts"]);

  // One local Canopy with an owner account; the control-mode daemon below
  // places `treeDir` under that account so the Swift suites can exercise the
  // loopback services (bootstrap, credential, objects) and Wire directly.
  const authorityToken = "swift-protocol-device-token";
  const canopy = await serveCanopy({
    dataRoot: authorityState,
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    accounts: [{ handle: "owner", token: authorityToken, communityWriter: true }],
  });
  try {
    await mkdir(join(home, "devices"), { recursive: true });
    await mkdir(join(treeDir, "sub"), { recursive: true });
    await writeFile(join(treeDir, "_index.md"), "# Protocol tree\n");
    await writeFile(join(treeDir, "page.md"), "Shared live-server fixture\n");
    await writeFile(join(treeDir, "photo.bin"), new Uint8Array([1, 2, 3, 4, 5]));
    await writeFile(join(treeDir, "sub", "child.md"), "Child\n");

    const owner = new WireClient(canopy.url, authorityToken);
    const account = await owner.account();
    const configurationTree = account.account.configuration.id;
    const configuration = await owner.descriptor(configurationTree);
    const configurationSnapshot = await owner.snapshot(configurationTree, configuration.tree.root);
    const graph = readAccountConfigGraph({ root: configurationSnapshot.root, objects: configurationSnapshot.objects }, configurationTree);
    const device = graph.account.admins[0]!;
    const tree = generateArborID("tr");
    await owner.submitUpdate(configurationTree, configuration.tree.update, snapshotAccountConfig({
      account: graph.account,
      trees: { version: 1, trees: { ...graph.trees.trees, [tree]: { canonicalPath: "/~owner/protocol", access: [] } } },
      devices: {
        ...graph.devices,
        [device]: { ...graph.devices[device]!, placements: {
          ...graph.devices[device]!.placements,
          [tree]: { server: new URL(canopy.url).origin, path: treeDir },
        } },
      },
    }));
    await owner.submitUpdate(tree, null, await resolveSnapshot(await snapshotDirectory(treeDir)));

    // Materialize the accepted configuration checkout into the data home and
    // record the device and community credential the daemon reads at start.
    const accepted = await owner.descriptor(configurationTree);
    const acceptedSnapshot = await owner.snapshot(configurationTree, accepted.tree.root);
    const acceptedGraph = readAccountConfigGraph({ root: acceptedSnapshot.root, objects: acceptedSnapshot.objects }, configurationTree);
    for (const [path, source] of Object.entries(acceptedGraph.sources)) await writeFile(join(home, path), source);
    process.env.ARBOR_DATA_HOME = home;
    await saveCurrentDeviceID(device);
    await new CommunityConfigStore().set(canopy.url, authorityToken, {
      id: account.account.id,
      handle: account.account.handle!,
      profileTree: account.account.profileTree,
      profileURL: account.account.profileURL,
      communityTree: account.account.community.id,
      communityURL: canonicalArborLocator(account.account.community.canonical!),
      configurationTree,
      configurationRef: accepted.tree.root,
      configurationUpdate: accepted.tree.update,
    });

    const control = await serveArborSyncControl({ port: 0, syncIntervalMs: 60_000 });
    try {
      // One explicit pass places the tree and records its accepted base.
      const sync = await fetch(`${control.url}/v1/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!sync.ok) throw new Error(`Control daemon sync failed: ${sync.status}`);
      const trees = await fetch(`${control.url}/v1/trees`).then((response) => response.json()) as { snapshot: Array<{ id: string; root?: string; update?: string }> };
      const placed = trees.snapshot.find((item) => item.id === tree);
      if (!placed?.root || !placed.update) throw new Error("Placed tree did not record its accepted base");

      const daemon = { ARBOR_TEST_URL: control.url, ARBOR_TEST_TREE: tree };
      await run(["swift", "test", "--package-path", "native/Packages/ArborSyncClient"], { ...fixtures, ...daemon });
      await run(["swift", "test", "--package-path", "native/Packages/ArborKit"], fixtures);
      // Exercise a real accepted conflict through the baseline filesystem client.
      const basis = (await owner.descriptor(tree)).tree;
      const snapshot = await owner.snapshot(tree, basis.root);
      const file = decodeWireDirectory(snapshot.objects.get(basis.root)!).entries.find(e => e.name === "page.md")!.file!;
      const objects = new Map(snapshot.objects);
      async function replacement(text: string) {
        const operations: SourceOperation[] = [{ key: "replace", kind: "editSource", source: { material: { kind: "basis", path: "/page.md", object: file } }, text }];
        const result = await executeExactSourceEdits(basis.root, operations, async hash => objects.get(hash)!);
        for (const object of result.generated) objects.set(...object);
        return { change: crypto.randomUUID(), candidate: result.root, operations, resolves: [], objects: [...result.generated].map(([hash, bytes]) => ({ hash, bytes })), deltas: [] };
      }
      await owner.submitUpdates(tree, { base: basis.update, updates: [await replacement("First retained choice\n")] });
      const conflict = (await owner.submitUpdates(tree, { base: basis.update, updates: [await replacement("Hidden retained choice\n")] })).results[0]!.update;
      if (!conflict.conflicted) throw new Error("Expected accepted ambiguity");
      const syncOnce = async () => {
        const response = await fetch(`${control.url}/v1/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        if (!response.ok) throw new Error(`Conflict sync failed: ${response.status}`);
      };
      await syncOnce();
      await writeFile(join(treeDir, "page.md"), "Filesystem continued after accepted ambiguity\n");
      await syncOnce();
      const continued = (await owner.descriptor(tree)).tree;
      const inspection = await owner.conflicts(tree, continued.update, continued.root);
      if (!continued.conflicted || inspection.decisions.length !== 1 || inspection.decisions[0]!.alternatives.length !== 2) throw new Error("Filesystem sync lost accepted alternatives");
      const current = await owner.snapshot(tree, continued.root);
      const currentFile = decodeWireDirectory(current.objects.get(continued.root)!).entries.find(e => e.name === "page.md")!.file!;
      if (new TextDecoder().decode(current.objects.get(currentFile)) !== "Filesystem continued after accepted ambiguity\n") throw new Error("Filesystem sync paused on accepted ambiguity");

    } finally {
      control.server.stop(true);
      await control.service[Symbol.asyncDispose]();
    }

    const wire = {
      ARBOR_WIRE_TEST_URL: canopy.url,
      ARBOR_WIRE_TEST_TOKEN: authorityToken,
      ARBOR_WIRE_TEST_TREE: tree,
    };
    await run(["swift", "test", "--package-path", "native/Packages/ArborWire"], { ...fixtures, ...wire });
    await run(["swift", "test", "--package-path", "native/Packages/CanopyClient"], { ...fixtures, ...wire });
    await run(["swift", "test", "--package-path", "native/Packages/ArborWorkingTree"], fixtures);
  } finally {
    canopy.server.stop(true);
    await canopy.canopy[Symbol.asyncDispose]();
  }
} finally {
  if (previousDataHome === undefined) delete process.env.ARBOR_DATA_HOME;
  else process.env.ARBOR_DATA_HOME = previousDataHome;
  await rm(sandbox, { recursive: true, force: true });
}
