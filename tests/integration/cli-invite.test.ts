import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostAccountStore, ProtocolClient, resolveLogicalURL } from "@ovst/protocol";
import { StorySyncDaemon } from "@ovst/story-sync";
import { serveHost } from "@ovst/overstoryd";
import { ProfileIdentityStore } from "@ovst/client";
import { LocalAccountService } from "../../packages/story-sync/src/account-service.ts";

/**
 * Sharing 002: `story invite` talks to the host itself with the device's key,
 * through `@ovst/client`. No Story Sync runs during these commands: the CLI
 * is pointed at a port nothing listens on.
 */

let sandbox: string;
let state: string;
let host: Awaited<ReturnType<typeof serveHost>>;

async function story(args: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, STORY_HOME: state, STORY_SYNC_URL: "http://127.0.0.1:9" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, stdout: stdout.trim(), stderr: stderr.trim() };
}

beforeAll(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "story-cli-invite-")));
  state = join(sandbox, "state");
  const profile = join(sandbox, "profile");
  await Promise.all([state, profile].map((path) => mkdir(path, { recursive: true })));
  process.env.STORY_HOME = state;
  const profileTree = (await new ProfileIdentityStore().create(profile)).profileTree;
  host = await serveHost({
    dataRoot: join(sandbox, "host"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "garden", name: "garden", firstWriter: { handle: "joe", profileTree } },
  });
  const daemon = await StorySyncDaemon.open(profile);
  try {
    await new LocalAccountService({ trees: daemon.trees, events: daemon.events }).claimHostAccount(`${host.url}/~joe`, profile, "Joe");
  } finally {
    await daemon[Symbol.asyncDispose]();
  }
});

afterAll(async () => {
  process.env.STORY_HOME = state;
  for (const account of await HostAccountStore.list()) await new HostAccountStore(account.configurationTree).remove();
  host?.server.stop(true);
  await host?.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("story invite", () => {
  test("invites, lists, renews and cancels with no Story Sync running", async () => {
    const account = `${new URL(host.url).origin}/~chungus`;
    const made = await story(["invite", account]);
    expect(made.exit, made.stderr).toBe(0);
    expect(made.stdout.startsWith(`${account}#overstory-invite=`)).toBe(true);
    expect(made.stdout.split("\n")).toHaveLength(1);
    expect(host.overstoryd.accountReservation(account)?.inviteDigest).toMatch(/^sha256:/);

    const listed = await story(["invite", "list", host.url]);
    expect(listed.stdout).toBe(account);

    const again = await story(["invite", account]);
    expect(again.exit).toBe(1);
    expect(again.stderr).toContain("already has a pending invitation");

    const renewed = await story(["invite", "renew", account]);
    expect(renewed.exit, renewed.stderr).toBe(0);
    expect(renewed.stdout).not.toBe(made.stdout);
    const code = (link: string) => {
      const resolved = resolveLogicalURL("/", link);
      return resolved?.kind === "overstory" ? resolved.invite! : "";
    };
    const anonymous = new ProtocolClient(host.url);
    await expect(anonymous.createAccountChallenge({ profileTree: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", inviteCode: code(made.stdout) })).rejects.toThrow();

    const cancelled = await story(["invite", "cancel", account]);
    expect(cancelled.exit, cancelled.stderr).toBe(0);
    expect(host.overstoryd.accountReservation(account)).toBeNull();
    expect((await story(["invite", "list"])).stdout).toBe("");
  });

  test("refuses a host this device has no account at, and a URL that names no account", async () => {
    const elsewhere = await story(["invite", "https://elsewhere.example/~dana"]);
    expect(elsewhere.exit).toBe(1);
    expect(elsewhere.stderr).toContain("no account whose home is elsewhere.example");
    const bad = await story(["invite", `${host.url}/notes`]);
    expect(bad.exit).toBe(2);
    expect(bad.stderr).toContain("Not an account URL");
  });
});
