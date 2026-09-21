import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLocalStateLock } from "../../packages/arborsync/src/state/local-state-lock.ts";

test("setup locks are released by process death", async () => {
  const root = await mkdtemp(join(tmpdir(), "arbor-setup-lock-"));
  const lock = join(root, "setup.sqlite");
  const source = new URL("../../packages/arborsync/src/state/local-state-lock.ts", import.meta.url).pathname;
  const script = `import { withLocalStateLock } from ${JSON.stringify(source)};
    await withLocalStateLock(${JSON.stringify(lock)}, async () => {
      console.log("locked"); await new Promise(() => {});
    });`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("locked");
    reader.releaseLock();
    child.kill("SIGKILL");
    await child.exited;
    expect(await withLocalStateLock(lock, async () => "recovered")).toBe("recovered");
  } finally {
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});
