import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let sandbox: string;

beforeAll(async () => { sandbox = await realpath(await mkdtemp(join(tmpdir(), "story-cli-backup-"))); });
afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

async function story(home: string, args: string[], stdin = ""): Promise<{ exit: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, STORY_HOME: home, STORY_CREDENTIAL_STORE: "file" },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, stdout, stderr };
}

test("story me backup encrypts under a passphrase read from standard input, and restore needs it", async () => {
  const home = join(sandbox, "home"), recovered = join(sandbox, "recovered"), backup = join(sandbox, "me.backup");
  const created = await story(home, ["me", "create", join(sandbox, "profile")]);
  expect(created.exit).toBe(0);
  const profileTree = /Profile TreeID: (tr_\w+)/.exec(created.stdout)![1];

  expect((await story(home, ["me", "backup", backup], "a passphrase for tests\n")).exit).toBe(0);
  expect(JSON.parse(await readFile(backup, "utf8"))).toMatchObject({ version: 2, profileTree });

  const wrong = await story(recovered, ["me", "restore", backup, join(sandbox, "restored")], "another passphrase\n");
  expect(wrong.exit).not.toBe(0);
  expect(wrong.stderr).toContain("does not open");
  const restored = await story(recovered, ["me", "restore", backup, join(sandbox, "restored")], "a passphrase for tests\n");
  expect(restored.stdout).toContain(`Restored ${profileTree}`);
});
