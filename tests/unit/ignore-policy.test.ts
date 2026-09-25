import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadIgnorePolicy } from "@overstory/fs";

interface IgnoreCase {
  name: string;
  files: Record<string, string>;
  bytes?: Record<string, string>;
  excludedRoots?: string[];
  path: string;
  isDirectory: boolean;
  decision: "included" | "ignored" | "mandatory";
  diagnostics?: string[];
}

const { cases } = JSON.parse(await readFile(join(import.meta.dir, "../fixtures/ignore-policy/cases.json"), "utf8")) as { cases: IgnoreCase[] };
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function place(root: string, path: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
}

describe("the shared ignore fixture", () => {
  for (const item of cases) {
    test(item.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "arbor-ignore-case-"));
      temporaryPaths.push(root);
      for (const [path, text] of Object.entries(item.files)) await place(root, path, text);
      for (const [path, base64] of Object.entries(item.bytes ?? {})) await place(root, path, Buffer.from(base64, "base64"));
      const excludedRoots = (item.excludedRoots ?? []).map((path) => join(root, path));
      for (const path of excludedRoots) await mkdir(path, { recursive: true });

      const policy = await loadIgnorePolicy(root, { excludedRoots });
      const decision = await policy.decision(item.path, item.isDirectory);
      expect(decision.membership).toBe(item.decision);
      if (decision.membership === "ignored") {
        expect(decision.source).toMatch(/\/\.(git|arbor)ignore$/);
        expect(decision.pattern).toBeString();
      }
      expect(policy.diagnostics.map((diagnostic) => diagnostic.path)).toEqual(item.diagnostics ?? []);
    });
  }
});

describe("ignore policy diagnostics", () => {
  test("an ignore file that is not UTF-8 is named without its contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-ignore-utf8-"));
    temporaryPaths.push(root);
    await place(root, "sub/.gitignore", Buffer.from([0xff, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74, 0x0a]));
    const policy = await loadIgnorePolicy(root);
    expect((await policy.decision("/sub/secret", false)).membership).toBe("included");
    expect(policy.diagnostics).toEqual([{
      code: "ignore-file-not-utf8",
      path: "/sub/.gitignore",
      severity: "warning",
      message: "/sub/.gitignore is not valid UTF-8, so none of its ignore rules apply.",
    }]);
    expect(JSON.stringify(policy.diagnostics)).not.toContain("secret");
  });

  test("machine-private Git sources have no effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-ignore-private-"));
    const home = await mkdtemp(join(tmpdir(), "arbor-ignore-home-"));
    temporaryPaths.push(root, home);
    await place(root, ".git/info/exclude", "*.secret\n");
    await place(root, ".git/config", "[core]\n\texcludesFile = " + join(home, "global-ignore") + "\n");
    await place(home, "global-ignore", "*.private\n");
    await place(home, ".config/git/ignore", "*.private\n");
    const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, ".config");
    try {
      const policy = await loadIgnorePolicy(root);
      expect((await policy.decision("/a.secret", false)).membership).toBe("included");
      expect((await policy.decision("/a.private", false)).membership).toBe("included");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
