import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost, type HostReport } from "@ovst/overstoryd";
import { decodeProtocolDirectory, encodeProtocolDirectory, hashObject, sha256, type ProtocolClient } from "@ovst/protocol";
import { deviceClient, testAccount } from "../../helpers/devices.ts";

const token = "report-command-owner";
let sandbox: string;
let running: Awaited<ReturnType<typeof serveHost>>;
let owner: ProtocolClient;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-report-command-"));
  running = await serveHost({
    dataRoot: join(sandbox, "overstoryd"),
    community: { handle: "garden", name: "Garden" },
    accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  owner = await deviceClient(running.url, token);

  // The community names the owner and holds one open invitation.
  const { account } = await owner.account();
  const community = running.overstoryd.community();
  const head = await owner.descriptor(community.id);
  const snapshot = await owner.snapshot(community.id, head.tree.root);
  const root = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
  const index = new TextEncoder().encode([
    "---", "type: group", "members:",
    `  - profile: ${JSON.stringify(`overstory://${account.profileTree!}/`)}`, "    handle: owner",
    "  - handle: guest", `    inviteDigest: ${JSON.stringify(`sha256:${sha256("report-invite-code-xyz")}`)}`,
    "---", "", "# Garden", "",
  ].join("\n"));
  const rootBytes = encodeProtocolDirectory({ type: "directory", entries: root.entries.map((entry) => entry.name === "_index.md" ? { name: entry.name, file: hashObject(index) } : entry) });
  await owner.submitUpdate(community.id, head.tree.update,
    { root: hashObject(rootBytes), objects: new Map([...snapshot.objects, [hashObject(index), index], [hashObject(rootBytes), rootBytes]]) },
    { ifCurrent: head.tree.update });
});

afterAll(async () => {
  running.server.stop(true);
  await running.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

async function report(...args: string[]): Promise<string> {
  const child = Bun.spawn(["bun", "packages/overstoryd/src/cli.ts", "report", "--data", join(sandbox, "overstoryd"), ...args], {
    cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  return stdout;
}

test("overstoryd report reads members, invitations, accounts and trees beside a running server", async () => {
  const json = JSON.parse(await report("--json")) as HostReport;
  expect(json.community.handle).toBe("garden");
  expect(json.members).toEqual([{ handle: "owner", status: "joined" }, { handle: "guest", status: "invited" }]);
  expect(json.accounts.map((account) => [account.handle, account.devices])).toEqual([["owner", 1]]);
  const root = json.trees.find((tree) => tree.path === "/")!;
  expect(root.admins).toContain("~owner");
  expect(root.files).toBeGreaterThan(0);
  expect(root.bytes).toBeGreaterThan(0);
  expect(root.updates.last7d).toBeGreaterThanOrEqual(2);
  expect(root.recentWriters).toContain("~owner");

  const text = await report();
  expect(text).toContain("1 joined, 1 open invitations");
  expect(text).toContain("~guest");
});
