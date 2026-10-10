import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@ovst/overstoryd";
import { generateOverstoryID, snapshotTreeConfig, type ProtocolClient, type ResourceAccessRule } from "@ovst/protocol";
import { deviceClient, testAccount } from "../../helpers/devices.ts";

const token = "declare-turns-owner";
let sandbox: string;
let running: Awaited<ReturnType<typeof serveHost>>;
let owner: ProtocolClient;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-declare-turns-"));
  running = await serveHost({
    dataRoot: join(sandbox, "overstoryd"),
    accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  owner = await deviceClient(running.url, token);
});

afterAll(async () => {
  running.server.stop(true);
  await running.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

test("two declarations of one TreeID take turns: one is accepted and the other refused as a conflict, never a fault", async () => {
  const profile = (await owner.account()).account.id;
  const tree = generateOverstoryID("tr");
  const declare = (readable: boolean) => {
    const access: ResourceAccessRule[] = [{ who: { profile }, allow: ["admin"] }];
    if (readable) access.push({ who: "everyone", allow: ["read"] });
    return owner.declareTree(tree, snapshotTreeConfig({ access, mounts: {} }));
  };
  const [first, second] = await Promise.allSettled([declare(false), declare(true)]);
  const settled = [first, second];
  expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const refused = settled.find((result) => result.status === "rejected") as PromiseRejectedResult;
  expect(refused.reason).toMatchObject({ status: 409, code: "conflict" });
});
