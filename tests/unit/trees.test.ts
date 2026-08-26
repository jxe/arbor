import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  arborPrivateRoot,
  loadAccountConfiguration,
  loadTreeRegistry,
  migrateLegacyDeviceConfiguration,
  parseAccountConfiguration,
  parseDeviceConfiguration,
  parseTreesConfiguration,
  saveCurrentDeviceID,
} from "@arbor/stores";

const previousDataHome = process.env.ARBOR_DATA_HOME;
const temporary: string[] = [];
const profile = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const shared = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const device = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";

async function dataHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "arbor-account-config-"));
  temporary.push(path);
  process.env.ARBOR_DATA_HOME = path;
  return path;
}

async function writeConfiguration(home: string, placementPath?: string): Promise<void> {
  await mkdir(join(home, "devices"), { recursive: true });
  await writeFile(join(home, "account.yaml"), [
    "version: 1",
    "community: https://community.example",
    `profile: { tree: ${profile}, handle: joe }`,
    `admins: [${device}]`,
    "",
  ].join("\n"));
  await writeFile(join(home, "trees.yaml"), [
    "version: 1",
    "trees:",
    `  ${profile}:`,
    "    kind: person-profile",
    "    canonicalPath: /~joe",
    "    access: [{ subject: { kind: everyone }, access: read }]",
    `  ${shared}:`,
    "    kind: shared-subtree",
    "    canonicalPath: /~joe/shared",
    "    access: []",
    "",
  ].join("\n"));
  await writeFile(join(home, "devices", `${device}.yaml`), [
    "version: 1",
    "label: Joe's Mac",
    "placements:",
    `  ${shared}:`,
    "    server: https://community.example",
    ...(placementPath ? [`    path: ${JSON.stringify(placementPath)}`] : []),
    "",
  ].join("\n"));
  await saveCurrentDeviceID(device);
}

afterEach(async () => {
  if (previousDataHome === undefined) delete process.env.ARBOR_DATA_HOME;
  else process.env.ARBOR_DATA_HOME = previousDataHome;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("account configuration YAML", () => {
  test("loads only the current device placements and materializes a pathless private replica", async () => {
    const home = await dataHome();
    await writeConfiguration(home);
    const snapshot = await loadTreeRegistry();
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.configuration.currentDevice?.id).toBe(device);
    expect(snapshot.placements).toEqual([expect.objectContaining({
      tree: shared,
      endpoint: "https://community.example",
      path: join(arborPrivateRoot(), "replicas", shared),
      replica: true,
      access: "write",
    })]);
  });

  test("uses an explicit filesystem placement without copying or normalizing it", async () => {
    const home = await dataHome();
    const placed = join(home, "authored-tree");
    await mkdir(placed);
    await writeConfiguration(home, placed);
    expect((await loadTreeRegistry()).placements).toEqual([
      expect.objectContaining({ tree: shared, path: placed, replica: false }),
    ]);
  });

  test("strictly rejects duplicate keys, aliases, unknown fields, stored none, and relative paths", async () => {
    expect(() => parseTreesConfiguration("version: 1\ntrees: {}\ntrees: {}\n")).toThrow();
    expect(() => parseTreesConfiguration("version: 1\ntrees: &x {}\ncopy: *x\n")).toThrow("aliases");
    expect(() => parseAccountConfiguration([
      "version: 1",
      "community: https://community.example",
      `profile: { tree: ${profile}, handle: joe }`,
      `admins: [${device}]`,
      "status: syncing",
    ].join("\n"))).toThrow("unknown fields");
    expect(() => parseTreesConfiguration([
      "version: 1", "trees:", `  ${profile}:`, "    kind: person-profile", "    canonicalPath: /~joe",
      "    access: [{ subject: { kind: everyone }, access: none }]",
    ].join("\n"))).toThrow("read or write");
    expect(() => parseDeviceConfiguration([
      "version: 1", "label: Laptop", "placements:", `  ${profile}:`,
      "    server: https://community.example", "    path: relative/path",
    ].join("\n"), device, `devices/${device}.yaml`)).toThrow("canonical and absolute");
  });

  test("accepts and source-preservingly migrates the legacy authority placement key", async () => {
    const legacy = [
      "# device comment",
      "version: 1",
      "label: 'Joe Laptop' # label comment",
      "placements:",
      `  ${shared}:`,
      "    authority: \"https://community.example\" # endpoint comment",
      "    path: '/Users/joe/Notes'",
      "",
    ].join("\n");
    const migrated = migrateLegacyDeviceConfiguration(legacy);
    expect(migrated.changed).toBe(true);
    expect(migrated.source).toContain("# device comment");
    expect(migrated.source).toContain("label: 'Joe Laptop' # label comment");
    expect(migrated.source).toContain('server: "https://community.example" # endpoint comment');
    expect(migrated.source).toContain("path: '/Users/joe/Notes'");
    expect(parseDeviceConfiguration(migrated.source, device, `devices/${device}.yaml`).placements[shared]?.server)
      .toBe("https://community.example");

    const home = await dataHome();
    await writeConfiguration(home);
    const path = join(home, "devices", `${device}.yaml`);
    await writeFile(path, legacy);
    expect((await loadAccountConfiguration()).diagnostics).toEqual([]);
    expect(await readFile(path, "utf8")).toContain('server: "https://community.example" # endpoint comment');
  });

  test("rejects ambiguous placement files containing server and authority", () => {
    expect(() => parseDeviceConfiguration([
      "version: 1", "label: Laptop", "placements:", `  ${profile}:`,
      "    server: https://community.example", "    authority: https://legacy.example",
    ].join("\n"), device, `devices/${device}.yaml`)).toThrow("cannot contain both");
  });

  test("reports invalid candidates without inventing active configuration", async () => {
    const home = await dataHome();
    await mkdir(join(home, "devices"));
    await writeFile(join(home, "account.yaml"), "version: 1\nadmins: []\n");
    await writeFile(join(home, "trees.yaml"), "version: 1\ntrees: {}\ntrees: {}\n");
    await writeFile(join(home, "devices", "laptop.yaml"), "version: 1\nlabel: Laptop\nplacements: {}\n");
    const result = await loadAccountConfiguration();
    expect(result.account).toBeUndefined();
    expect(result.trees).toBeUndefined();
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      "invalid-account-yaml", "invalid-trees-yaml", "invalid-device-file",
    ]);
  });
});
