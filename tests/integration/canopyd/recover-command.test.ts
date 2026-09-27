import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@overstory/canopyd";
import { generateArborID, ProtocolClient } from "@overstory/protocol";
import { deviceClient, testAccount } from "../../helpers/devices.ts";

const token = "recover-command-owner";
let sandbox: string;
let running: Awaited<ReturnType<typeof serveHost>>;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-recover-command-"));
  running = await serveHost({
    dataRoot: join(sandbox, "canopy"),
    accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
});

afterAll(async () => {
  running.server.stop(true);
  await running.canopy[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

test("canopyd recover prints a recovery pairing beside a running server, and claiming it replaces every device", async () => {
  const child = Bun.spawn(["bun", "packages/canopyd/src/cli.ts", "recover", "~owner", "--data", join(sandbox, "canopy"), "--url", running.url], {
    cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  const payload = JSON.parse(stdout.trim().split("\n").at(-1)!) as { version: number; origin: string; pairing: { id: string; secret: string } };
  expect(payload).toMatchObject({ version: 1, origin: new URL(running.url).origin });

  const { publicKey } = generateKeyPairSync("ed25519");
  const key = `ed25519:${Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(12).toString("base64url")}`;
  const device = generateArborID("dv");
  const owner = await deviceClient(running.url, token);
  await new ProtocolClient(running.url).claimPairing(payload.pairing.id, payload.pairing.secret, { id: device, label: "Recovered laptop", key });
  // The old credential is revoked with every other device.
  await expect(owner.account()).rejects.toThrow("unauthenticated");
  const unknown = Bun.spawn(["bun", "packages/canopyd/src/cli.ts", "recover", "nobody", "--data", join(sandbox, "canopy"), "--url", running.url], {
    cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
  });
  expect(await unknown.exited).not.toBe(0);
  expect(await new Response(unknown.stderr).text()).toContain("Unknown account");
});
