import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STORY_SYNC_LABEL,
  DarwinStoryDaemonSupervisor,
  darwinDaemonCommand,
  darwinDaemonPaths,
  darwinLaunchAgentPlist,
} from "../../packages/cli/src/daemon.ts";

const roots: string[] = [];
const previousDataHome = process.env.STORY_HOME;

// Supervision owns only the default data home, so tests that install clear the
// override inside their own body; it is restored before the next test starts.
afterEach(async () => {
  if (previousDataHome === undefined) delete process.env.STORY_HOME;
  else process.env.STORY_HOME = previousDataHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Story daemon supervision", () => {
  test("generates a literal per-user launch agent without data-home secrets", () => {
    const paths = darwinDaemonPaths("/Users/alice");
    const command = darwinDaemonCommand({ executable: "/Applications/Story CLI/bin/story-sync" });
    const plist = darwinLaunchAgentPlist(command, paths);

    expect(plist).toContain(`<string>${STORY_SYNC_LABEL}</string>`);
    expect(plist).toContain("<string>/Applications/Story CLI/bin/story-sync</string>");
    expect(plist).toContain("<string>--control</string>");
    expect(plist).toContain("<key>Crashed</key>");
    expect(plist).toContain("/Users/alice/Library/Logs/Story/story-sync.log");
    expect(plist).not.toContain("STORY_HOME");
  });

  test("installs, reports, stops, restarts, and uninstalls one launchd job", async () => {
    delete process.env.STORY_HOME;
    const home = await mkdtemp(join(tmpdir(), "story-daemon-supervision-"));
    roots.push(home);
    const commands: string[][] = [];
    let loaded = false;
    let running = false;
    let instance = 0;
    const supervisor = new DarwinStoryDaemonSupervisor({
      home,
      executable: "/opt/story/story-sync",
      fetcher: (async () => running
        ? Response.json({ service: "story-sync", protocolVersion: "v1", instanceID: `instance-${instance}` })
        : Promise.reject(new Error("stopped"))),
      run: async (command) => {
        commands.push(command);
        const action = command[1];
        if (action === "print") {
          return loaded
            ? { exitCode: 0, stdout: `state = ${running ? "running" : "waiting"}\npid = 812`, stderr: "" }
            : { exitCode: 113, stdout: "", stderr: "not found" };
        }
        if (action === "bootstrap") { loaded = true; running = true; instance += 1; }
        if (action === "kickstart") { running = true; instance += 1; }
        if (action === "kill") running = false;
        if (action === "bootout") { loaded = false; running = false; }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(await supervisor.install()).toContain("Installed and started");
    expect(await readFile(darwinDaemonPaths(home).plist, "utf8")).toContain("/opt/story/story-sync");
    expect(await supervisor.status()).toMatchObject({ state: "running", installed: true, pid: 812 });
    expect(await supervisor.stop()).toContain("Stopped");
    expect((await supervisor.status()).state).toBe("stopped");
    expect(await supervisor.restart()).toContain("Restarted");
    expect(await supervisor.uninstall()).toContain("data was left untouched");
    expect((await supervisor.status()).state).toBe("not-installed");
    expect(commands.some((command) => command[1] === "bootstrap")).toBe(true);
    expect(commands.some((command) => command.includes("-k"))).toBe(true);
  });

  test("does not register an alternate Story data home as the default service", async () => {
    process.env.STORY_HOME = "/tmp/story-isolated";
    const supervisor = new DarwinStoryDaemonSupervisor({
      run: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    });
    await expect(supervisor.install()).rejects.toThrow("default Story data home");
  });

  test("refuses to install over an unsupervised process on the well-known port", async () => {
    delete process.env.STORY_HOME;
    const home = await mkdtemp(join(tmpdir(), "story-daemon-collision-"));
    roots.push(home);
    const supervisor = new DarwinStoryDaemonSupervisor({
      home,
      fetcher: async () => Response.json({ service: "story-sync", protocolVersion: "v1" }),
      run: async () => ({ exitCode: 113, stdout: "", stderr: "not found" }),
    });
    await expect(supervisor.install()).rejects.toThrow("unsupervised Story Sync");
  });

  test("does not report restart success while the old instance still owns the port", async () => {
    delete process.env.STORY_HOME;
    const supervisor = new DarwinStoryDaemonSupervisor({
      fetcher: async () => Response.json({ service: "story-sync", protocolVersion: "v1", instanceID: "old-instance" }),
      run: async (command) => command[1] === "print"
        ? { exitCode: 0, stdout: "state = running\npid = 812", stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" },
    });
    await expect(supervisor.restart()).rejects.toThrow("did not produce a new service instance");
  }, 10_000);
});
