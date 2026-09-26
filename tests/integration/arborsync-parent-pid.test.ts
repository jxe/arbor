import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("a control helper launched with --parent-pid stops once that process is gone", async () => {
  const home = await mkdtemp(join(tmpdir(), "arbor-parent-pid-"));
  const parent = Bun.spawn(["sleep", "60"]);
  const helper = Bun.spawn([process.execPath, join(import.meta.dir, "../../packages/arborsync/src/cli.ts"), "--control", "--port", "0", "--parent-pid", String(parent.pid)], {
    env: { ...Bun.env, ARBOR_DATA_HOME: home, ARBOR_CREDENTIAL_STORE: "file" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = helper.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("control service is listening");
    reader.releaseLock();
    parent.kill();
    await parent.exited;
    const exit = await Promise.race([helper.exited, Bun.sleep(5000).then(() => "running" as const)]);
    expect(exit).toBe(0);
  } finally {
    helper.kill();
    parent.kill();
    await rm(home, { recursive: true, force: true });
  }
});
