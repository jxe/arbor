import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostAccountStore, parseAccessYAML, parseAccountDevicesConfiguration, parseMountsYAML, saveCurrentAccountDeviceID, treeConfigurationID } from "@overstory/protocol";
import { loadTreeRegistry, parseLocalPlacements, savePlacementSyncMetadata } from "@overstory/arborsync/state";
const previousDataHome = process.env.ARBOR_DATA_HOME;
const previousCredentialStore = process.env.ARBOR_CREDENTIAL_STORE;
const temporary: string[] = [];
const profile = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", shared = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb", cfg = treeConfigurationID(profile), device = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const canopy = "https://community.example";
async function dataHome() {
  const home = await mkdtemp(join(tmpdir(), "arbor-account-config-"));
  temporary.push(home); process.env.ARBOR_DATA_HOME = home; process.env.ARBOR_CREDENTIAL_STORE = "file"; return home;
}
async function writeConfiguration(home: string, placementPath: string) {
  const checkout = join(home, "accounts", cfg);
  await mkdir(checkout, { recursive: true });
  await writeFile(join(checkout, "access.yaml"), `- who: {profile: ${profile}}\n  allow: [admin]\n`);
  await writeFile(join(checkout, "mounts.yaml"), `shared: ${shared}\n`);
  await writeFile(join(checkout, "devices.yaml"), JSON.stringify({ [device]: { label: "Mac", administrator: true } }));
  await writeFile(join(home, "placements.yaml"), JSON.stringify({ [cfg]: { [placementPath]: shared } }));
  await saveCurrentAccountDeviceID(cfg, device);
  await new HostAccountStore(cfg).set("fixture-token", { origin: canopy, account: `${canopy}/~joe`, accountID: profile, profileTree: profile, deviceID: device });
}
afterEach(async () => {
  if (previousCredentialStore === undefined) delete process.env.ARBOR_CREDENTIAL_STORE;
  else process.env.ARBOR_CREDENTIAL_STORE = previousCredentialStore;
  if (previousDataHome === undefined) delete process.env.ARBOR_DATA_HOME;
  else process.env.ARBOR_DATA_HOME = previousDataHome;
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
test("an empty data home has an empty current registry", async () => {
  await dataHome(); const result = await loadTreeRegistry();
  expect(result.accounts).toEqual([]); expect(result.placements).toEqual([]); expect(result.diagnostics).toEqual([]);
});
test("uses an explicit local placement and the profile configuration's checkout", async () => {
  const home = await dataHome(), placed = join(home, "authored-tree");
  await mkdir(placed); await writeConfiguration(home, placed);
  const result = await loadTreeRegistry();
  expect(result.diagnostics).toEqual([]);
  expect(result.accounts[0]?.currentDevice?.id).toBe(device);
  expect(result.accounts[0]?.profile).toBe(profile);
  expect(result.placements).toEqual([
    expect.objectContaining({ tree: cfg, configurationTree: cfg, path: join(home, "accounts", cfg), kind: "tree-configuration" }),
    expect.objectContaining({ tree: shared, configurationTree: cfg, path: placed, endpoint: canopy }),
  ]);
  // A placement's canonical path is the one the host last reported.
  expect(result.placements[1]!.canonical).toBeUndefined();
  await savePlacementSyncMetadata(shared, { canonicalPath: "/~joe/shared" }, cfg);
  const reported = await loadTreeRegistry();
  expect(reported.placements[1]).toMatchObject({ canonicalPath: "/~joe/shared", canonical: "arbor://community.example/~joe/shared" });
});
test("strict YAML rejects duplicates, aliases, unknown fields, stored none and relative local paths", () => {
  expect(() => parseMountsYAML(`notes: ${shared}\nnotes: ${shared}\n`)).toThrow();
  expect(() => parseMountsYAML("a: &x tr_x\nb: *x\n")).toThrow();
  expect(() => parseAccessYAML(`- who: {profile: ${profile}}\n  allow: [admin]\n- who: everyone\n  allow: [none]\n`)).toThrow();
  expect(() => parseAccessYAML(`- who: {profile: ${profile}}\n  allow: [admin]\n  status: syncing\n`)).toThrow();
  expect(() => parseLocalPlacements(JSON.stringify({ [cfg]: { "relative/path": shared } }))).toThrow("canonical and absolute");
  expect(parseLocalPlacements(`${cfg}:\n  /tmp/notes: ${shared}\n`)).toEqual([{ configurationTree: cfg, path: "/tmp/notes", tree: shared }]);
  expect(() => parseLocalPlacements(`${cfg}:\n  /tmp/one: ${shared}\n${profile}:\n  /tmp/two: ${shared}\n`)).toThrow("Tree appears in several placements");
  expect(() => parseAccountDevicesConfiguration(JSON.stringify({ [device]: { label: "Mac", administrator: true, placements: {} } }))).toThrow();
});
test("invalid account candidates do not invent an active projection", async () => {
  const home = await dataHome(); await writeConfiguration(home, join(home, "tree"));
  await writeFile(join(home, "accounts", cfg, "access.yaml"), "- who: everyone\n  allow: [read]\n");
  const result = await loadTreeRegistry();
  expect(result.invalidAccounts).toContain(cfg);
  expect(result.placements.filter((placement) => placement.kind === "tree-configuration")).toEqual([]);
  expect(result.diagnostics.map(d => d.code)).toContain("invalid-access-yaml");
});
