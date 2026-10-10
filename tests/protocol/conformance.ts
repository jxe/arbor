import { installAccountHome } from "../helpers/account-home.ts";
import { executeExactSourceEdits } from "../support/source-edits.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveStorySyncControl } from "@ovst/story-sync";
import { serveHost } from "@ovst/overstoryd";
import { decodeProtocolDirectory, type SourceOperation } from "@ovst/protocol";
import { hostTree, readTreeConfig } from "../helpers/tree-config.ts";
import { resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { deviceClient, deviceSession, testAccount, testDevice } from "../helpers/devices.ts";

async function run(command: string[], environment: Record<string, string> = {}): Promise<void> {
  const process = Bun.spawn(command, {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, ...environment },
    stdout: "inherit",
    stderr: "inherit",
  });
  const started = performance.now();
  const status = await process.exited;
  console.log(`[protocol] ${((performance.now() - started) / 1000).toFixed(1)}s ${command.slice(0, 4).join(" ")}`);
  if (status !== 0) throw new Error(`${command.join(" ")} exited with ${status}`);
}

const fixtures = {
  STORY_PROTOCOL_FIXTURES: join(import.meta.dir, "../../docs/overstory-spec/conformance"),
  STORY_REFERENCE_FIXTURES: join(import.meta.dir, "../fixtures"),
};

const sandbox = await mkdtemp(join(tmpdir(), "story-protocol-"));
const home = join(sandbox, "home");
const treeDir = join(sandbox, "tree");
const authorityState = join(sandbox, "overstoryd");
const previousDataHome = process.env.STORY_HOME;

try {
  const directoryFixture = JSON.parse(await readFile(join(fixtures.STORY_REFERENCE_FIXTURES, "overstoryd/directory.json"), "utf8")) as {
    snapshot?: Array<{ profile?: string; sources?: string[] }>;
  };
  if ("observedThrough" in directoryFixture || !directoryFixture.snapshot?.every(entry => entry.profile?.startsWith("tr_") && entry.sources?.length)) {
    throw new Error("Malformed shared profile-directory fixture");
  }
  await run(["bun", "test", "tests/unit/protocol.test.ts", "tests/unit/resource-policy.test.ts", "tests/unit/protocol-updates/update-intent.test.ts", "tests/unit/protocol-updates/operations.test.ts", "tests/unit/protocol-updates/authored-contract.test.ts", "tests/unit/protocol-updates/accepted-contract.test.ts", "tests/unit/protocol-updates/accepted-transport.test.ts", "tests/unit/protocol-updates/authored-transport.test.ts", "tests/unit/protocol-updates/cbor-transport.test.ts"]);

  // One local Canopy with an owner account; the control-mode daemon below
  // places `treeDir` under that account so the Swift suites can exercise the
  // loopback services (bootstrap, credential, objects) and the protocol directly.
  const authorityToken = "swift-protocol-device-token";
  const overstoryd = await serveHost({
    dataRoot: authorityState,
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    accounts: [testAccount("owner", authorityToken, { communityWriter: true })],
  });
  try {
    await mkdir(home, { recursive: true });
    await mkdir(join(treeDir, "sub"), { recursive: true });
    await writeFile(join(treeDir, "_index.md"), "# Protocol tree\n");
    await writeFile(join(treeDir, "page.md"), "Shared live-server fixture\n");
    await writeFile(join(treeDir, "photo.bin"), new Uint8Array([1, 2, 3, 4, 5]));
    await writeFile(join(treeDir, "sub", "child.md"), "Child\n");

    const owner = await deviceClient(overstoryd.url, authorityToken);
    const account = await owner.account();
    const profile = account.account.profileTree!;
    const device = Object.values((await readTreeConfig(owner, profile, "person")).values.devices!).find(device => device.administrator)!.id;
    const snapshot = await resolveSnapshot(await snapshotDirectory(treeDir));
    // Each tree is declared, mounted below the owner's profile, and activated.
    const place = (name: string) => hostTree(owner, snapshot, { parent: { tree: profile, name, kind: "person" } });
    const tree = await place("protocol");
    const sourceTree = await place("source-admissions");
    const branchTree = await place("publication-branches");
    const crossDocumentTree = await place("cross-document");
    const reviewTrees: Record<string, string> = {};
    for (const mode of ["keep-current", "choose", "compose", "lost-response", "continued-edit", "group-remove", "group-rescue", "group-keep", "group-lost-response", "independent-ranges"]) {
      reviewTrees[mode] = await place(`review-${mode}`);
    }

    // Materialize the accepted configuration checkout into the data home and
    // record the device and community credential the daemon reads at start.
    await installAccountHome(home, owner, device, testDevice(authorityToken).seed, { [treeDir]: tree });

    const control = await serveStorySyncControl({ port: 0, syncIntervalMs: 60_000 });
    try {
      // One explicit pass places the tree and records its accepted base.
      const sync = await fetch(`${control.url}/v1/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!sync.ok) throw new Error(`Control daemon sync failed: ${sync.status}`);
      const trees = await fetch(`${control.url}/v1/trees`).then((response) => response.json()) as { snapshot: Array<{ id: string; root?: string; update?: string }> };
      const placed = trees.snapshot.find((item) => item.id === tree);
      if (!placed?.root || !placed.update) throw new Error("Placed tree did not record its accepted base");

      const daemon = { STORY_TEST_URL: control.url, STORY_TEST_TREE: tree };
      // The daemon client is Mac app code (Native 011), so its suites run in
      // the app-hosted StoryAppTests bundle; xcodebuild forwards
      // `TEST_RUNNER_`-prefixed variables to the test process. A local
      // workspace, when present, overrides the pinned Quagmire with the
      // sibling checkout (DEVELOPMENT.md, "Developing Overstory with Quagmire").
      const localWorkspace = "swift/Story.local.xcworkspace";
      const container = await Bun.file(join(import.meta.dir, "../..", localWorkspace, "contents.xcworkspacedata")).exists()
        ? ["-workspace", localWorkspace]
        : ["-project", "swift/Story.xcodeproj"];
      await run([
        "xcodebuild", "test", "-quiet", ...container, "-scheme", "Canopy",
        "-destination", "platform=macOS",
        "-only-testing:StoryAppTests/StorySyncClientTests",
        "-only-testing:StoryAppTests/LoopbackServicesTests",
      ], Object.fromEntries(Object.entries({ ...fixtures, ...daemon }).map(([key, value]) => [`TEST_RUNNER_${key}`, value])));
      await run(["swift", "test", "--package-path", "swift/Packages/StoryKit"], fixtures);
      // Exercise a real accepted conflict through the baseline filesystem client.
      const basis = (await owner.descriptor(tree)).tree;
      const snapshot = await owner.snapshot(tree, basis.root);
      const file = decodeProtocolDirectory(snapshot.objects.get(basis.root)!).entries.find(e => e.name === "page.md")!.file!;
      const objects = new Map(snapshot.objects);
      async function replacement(text: string) {
        const operations: SourceOperation[] = [{ key: "replace", kind: "editSource", source: { material: { kind: "basis", path: "/page.md", object: file } }, text }];
        const result = await executeExactSourceEdits(basis.root, operations, async hash => objects.get(hash)!);
        for (const object of result.generated) objects.set(...object);
        return { change: crypto.randomUUID(), candidate: result.root, trace: [{ before: basis.root, after: result.root, operations }], resolves: [], objects: [...result.generated].map(([hash, bytes]) => ({ hash, bytes })), deltas: [] };
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
      const currentFile = decodeProtocolDirectory(current.objects.get(continued.root)!).entries.find(e => e.name === "page.md")!.file!;
      if (new TextDecoder().decode(current.objects.get(currentFile)) !== "Filesystem continued after accepted ambiguity\n") throw new Error("Filesystem sync paused on accepted ambiguity");

    } finally {
      control.server.stop(true);
      await control.service[Symbol.asyncDispose]();
    }

    // The Swift suites present a session of the owner's device, as any client does.
    const session = await deviceSession(overstoryd.url, authorityToken);
    const wire = {
      STORY_PROTOCOL_TEST_URL: overstoryd.url,
      STORY_PROTOCOL_TEST_TOKEN: session,
      STORY_PROTOCOL_TEST_TREE: tree,
    };
    await run(["swift", "test", "--package-path", "swift/Packages/Overstory"], { ...fixtures, ...wire });
    await run(["swift", "test", "--package-path", "swift/Packages/OverstoryClient"], { ...fixtures, ...wire });
    await run(["swift", "test", "--package-path", "swift/Packages/OverstoryWorkingTree"], {
      ...fixtures, STORY_CROSS_DOCUMENT_TEST_TREE: crossDocumentTree, STORY_SOURCE_TEST_URL: overstoryd.url,
      STORY_SOURCE_TEST_TOKEN: session, STORY_SOURCE_TEST_TREE: sourceTree,
      STORY_REVIEW_TEST_TREES: JSON.stringify(reviewTrees), STORY_BRANCH_TEST_TREE: branchTree,
    });
    await run(["swift/scripts/test-story-editor-local.sh", "--filter", "LiveEditorAdmissionTests"], {
      ...fixtures, STORY_CROSS_DOCUMENT_TEST_TREE: crossDocumentTree, STORY_SOURCE_TEST_URL: overstoryd.url,
      STORY_SOURCE_TEST_TOKEN: session, STORY_SOURCE_TEST_TREE: sourceTree,
    });
  } finally {
    overstoryd.server.stop(true);
    await overstoryd.overstoryd[Symbol.asyncDispose]();
  }
} finally {
  if (previousDataHome === undefined) delete process.env.STORY_HOME;
  else process.env.STORY_HOME = previousDataHome;
  await rm(sandbox, { recursive: true, force: true });
}
