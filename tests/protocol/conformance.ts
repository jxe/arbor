import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveWorkspace } from "@arbor/arbord";
import { serveWireHost } from "@arbor/authority";

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
      },
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
    await run(
      ["swift", "test", "--package-path", "native/Packages/ArborWire"],
      {
        ARBOR_PROTOCOL_FIXTURES: join(import.meta.dir, "../../spec/fixtures"),
        ARBOR_WIRE_TEST_URL: authority.url,
        ARBOR_WIRE_TEST_TOKEN: authorityToken,
      },
    );
    await run(
      ["swift", "test", "--package-path", "native/Packages/ArborSync"],
      {
        ARBOR_PROTOCOL_FIXTURES: join(import.meta.dir, "../../spec/fixtures"),
        ARBOR_WIRE_TEST_URL: authority.url,
        ARBOR_WIRE_TEST_TOKEN: authorityToken,
      },
    );
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
