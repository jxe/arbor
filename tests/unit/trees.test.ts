import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CanopyAccountStore, saveCurrentAccountDeviceID, parseCanopyAccountConfiguration, parseHostedTreesConfiguration, parseAccountDevicesConfiguration } from "@overstory/protocol";
import { loadTreeRegistry, parseLocalPlacements } from "@overstory/arborsync/state";
const previousDataHome = process.env.ARBOR_DATA_HOME;
const previousCredentialStore = process.env.ARBOR_CREDENTIAL_STORE;
const temporary: string[] = [];
const profile = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", shared = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb", cfg = "tr_cccccccccccccccccccccccccc", device = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const account = { canopy: "https://community.example", profile };
async function dataHome() {
  const home = await mkdtemp(join(tmpdir(), "arbor-account-config-"));
  temporary.push(home); process.env.ARBOR_DATA_HOME = home; process.env.ARBOR_CREDENTIAL_STORE = "file"; return home;
}
async function writeConfiguration(home: string, placementPath: string) {
  const checkout = join(home, "accounts", cfg);
  await mkdir(checkout, { recursive: true });
  await writeFile(join(checkout, "account.yaml"), JSON.stringify(account));
  await writeFile(join(checkout, "trees.yaml"), JSON.stringify({ [shared]: { canonical: `${account.canopy}/~joe/shared`, access: [] } }));
  await writeFile(join(checkout, "devices.yaml"), JSON.stringify({ [device]: { label: "Mac", administrator: true } }));
  await writeFile(join(home, "placements.yaml"), JSON.stringify({ [cfg]: { [placementPath]: shared } }));
  await saveCurrentAccountDeviceID(cfg, device);
  await new CanopyAccountStore(cfg).set("fixture-token", { origin: account.canopy, account: `${account.canopy}/~joe`, accountID: "joe", profileTree: profile, deviceID: device });
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
test("uses an explicit local placement and separate account checkout", async () => {
  const home = await dataHome(), placed = join(home, "authored-tree");
  await mkdir(placed); await writeConfiguration(home, placed);
  const result = await loadTreeRegistry();
  expect(result.diagnostics).toEqual([]);
  expect(result.accounts[0]?.currentDevice?.id).toBe(device);
  expect(result.placements).toEqual([
    expect.objectContaining({ tree: cfg, configurationTree: cfg, path: join(home, "accounts", cfg), kind: "account-configuration" }),
    expect.objectContaining({ tree: shared, configurationTree: cfg, path: placed, endpoint: account.canopy }),
  ]);
});
test("strict YAML rejects duplicates, aliases, unknown fields, stored none and relative local paths", () => {
  expect(() => parseHostedTreesConfiguration(`${shared}: {}\n${shared}: {}\n`, account)).toThrow();
  expect(() => parseHostedTreesConfiguration("a: &x {}\nb: *x\n", account)).toThrow();
  expect(() => parseCanopyAccountConfiguration(JSON.stringify({ ...account, status: "syncing" }))).toThrow();
  expect(() => parseHostedTreesConfiguration(JSON.stringify({ [shared]: { canonical: `${account.canopy}/~joe/shared`, access: [{ subject: { kind: "everyone" }, access: "none" }] } }), account)).toThrow();
  expect(() => parseHostedTreesConfiguration(JSON.stringify({ [shared]: { kind: "person-profile", canonical: `${account.canopy}/~joe/shared`, access: [] } }), account)).toThrow();
  expect(() => parseLocalPlacements(JSON.stringify({ [cfg]: { "relative/path": shared } }))).toThrow("canonical and absolute");
  expect(() => parseAccountDevicesConfiguration(JSON.stringify({ [device]: { label: "Mac", administrator: true, placements: {} } }))).toThrow();
});
test("invalid account candidates do not invent an active projection", async () => {
  const home = await dataHome(); await writeConfiguration(home, join(home, "tree"));
  await writeFile(join(home, "accounts", cfg, "account.yaml"), "canopy: invalid\n");
  const result = await loadTreeRegistry();
  expect(result.invalidAccounts).toContain(cfg);
  expect(result.placements).toEqual([]);
  expect(result.diagnostics.map(d => d.code)).toContain("invalid-account-yaml");
});
