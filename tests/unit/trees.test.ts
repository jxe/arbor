import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deviceKeyFromSeed, HostAccountStore, HostPlacementStore, parseAccessYAML, parseAccountDevicesConfiguration, parseMountsYAML, saveCurrentAccountDeviceID, treeConfigurationID } from "@ovst/protocol";
import { loadTreeRegistry, savePlacementSyncMetadata } from "@ovst/story-sync/state";
import { addLocalPlacement, loadLocalPlacements, parseLocalPlacements, replaceLocalPlacement } from "@ovst/client";
const previousDataHome = process.env.STORY_HOME;
const previousCredentialStore = process.env.STORY_CREDENTIAL_STORE;
const temporary: string[] = [];
const profile = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", shared = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb", cfg = treeConfigurationID(profile), device = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const overstoryd = "https://community.example", seed = "A".repeat(43);
async function dataHome() {
  const home = await mkdtemp(join(tmpdir(), "story-account-config-"));
  temporary.push(home); process.env.STORY_HOME = home; process.env.STORY_CREDENTIAL_STORE = "file"; return home;
}
async function writeConfiguration(home: string, placementPath: string) {
  const checkout = join(home, "configurations", cfg);
  await mkdir(checkout, { recursive: true });
  await writeFile(join(checkout, "access.yaml"), `- who: {profile: ${profile}}\n  allow: [admin]\n`);
  await writeFile(join(checkout, "mounts.yaml"), `shared: ${shared}\n`);
  await writeFile(join(checkout, "devices.yaml"), JSON.stringify({ [device]: { label: "Mac", administrator: true, key: deviceKeyFromSeed(seed) } }));
  await writeFile(join(home, "placements.yaml"), JSON.stringify({ [cfg]: { [placementPath]: shared } }));
  await saveCurrentAccountDeviceID(cfg, device);
  await new HostAccountStore(cfg).setDeviceKey(seed, { origin: overstoryd, account: `${overstoryd}/~joe`, accountID: profile, profileTree: profile, deviceID: device });
}
afterEach(async () => {
  if (previousCredentialStore === undefined) delete process.env.STORY_CREDENTIAL_STORE;
  else process.env.STORY_CREDENTIAL_STORE = previousCredentialStore;
  if (previousDataHome === undefined) delete process.env.STORY_HOME;
  else process.env.STORY_HOME = previousDataHome;
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
    expect.objectContaining({ tree: cfg, configurationTree: cfg, path: join(home, "configurations", cfg), kind: "tree-configuration" }),
    expect.objectContaining({ tree: shared, configurationTree: cfg, path: placed, endpoint: overstoryd }),
  ]);
  // A placement's canonical path is the one the host last reported.
  expect(result.placements[1]!.canonical).toBeUndefined();
  await savePlacementSyncMetadata(shared, { canonicalPath: "/~joe/shared" }, cfg);
  const reported = await loadTreeRegistry();
  expect(reported.placements[1]).toMatchObject({ canonicalPath: "/~joe/shared", canonical: "overstory://community.example/~joe/shared" });
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
  await writeFile(join(home, "configurations", cfg, "access.yaml"), "- who: everyone\n  allow: [read]\n");
  const result = await loadTreeRegistry();
  expect(result.invalidAccounts).toContain(cfg);
  expect(result.placements.filter((placement) => placement.kind === "tree-configuration")).toEqual([]);
  expect(result.diagnostics.map(d => d.code)).toContain("invalid-access-yaml");
});
test("a placement may name a placement host; a bare TreeID stays the home host", () => {
  const orchard = "https://orchard.example";
  const other = "tr_cccccccccccccccccccccccccc";
  expect(parseLocalPlacements(`${cfg}:\n  /tmp/notes: ${shared}\n  /tmp/orchard:\n    tree: ${other}\n    host: ${orchard}\n`)).toEqual([
    { configurationTree: cfg, path: "/tmp/notes", tree: shared },
    { configurationTree: cfg, path: "/tmp/orchard", tree: other, host: orchard },
  ]);
  expect(parseLocalPlacements(`${cfg}:\n  /tmp/orchard: {tree: ${other}}\n`)).toEqual([{ configurationTree: cfg, path: "/tmp/orchard", tree: other }]);
  expect(() => parseLocalPlacements(`${cfg}:\n  /tmp/orchard: {tree: ${other}, origin: ${orchard}}\n`)).toThrow("unknown field");
  expect(() => parseLocalPlacements(`${cfg}:\n  /tmp/orchard: {host: ${orchard}}\n`)).toThrow();
  for (const host of ["http://orchard.example", `${orchard}/~joe`, "orchard.example"]) {
    expect(() => parseLocalPlacements(`${cfg}:\n  /tmp/orchard: {tree: ${other}, host: "${host}"}\n`)).toThrow("HTTPS origin");
  }
});
test("adding and moving a placement keeps its host and leaves the home placements' form alone", async () => {
  const home = await dataHome();
  const orchard = "https://orchard.example";
  const other = "tr_cccccccccccccccccccccccccc";
  const original = `# Joe's folders\n${cfg}:\n  /tmp/notes: ${shared}\n`;
  await writeFile(join(home, "placements.yaml"), original);
  await addLocalPlacement({ configurationTree: cfg, path: "/tmp/orchard", tree: other, host: orchard });
  const added = await readFile(join(home, "placements.yaml"), "utf8");
  expect(added.startsWith(original)).toBe(true);
  // The same tree and path at another host is a different placement.
  await expect(addLocalPlacement({ configurationTree: cfg, path: "/tmp/orchard", tree: other })).rejects.toThrow("already placed");
  await addLocalPlacement({ configurationTree: cfg, path: "/tmp/orchard", tree: other, host: orchard });
  expect(await readFile(join(home, "placements.yaml"), "utf8")).toBe(added);
  await expect(replaceLocalPlacement({ configurationTree: cfg, path: "/tmp/orchard", tree: other }, { configurationTree: cfg, path: "/tmp/moved" }))
    .rejects.toThrow("changed before update");
  await replaceLocalPlacement({ configurationTree: cfg, path: "/tmp/orchard", tree: other, host: orchard }, { configurationTree: cfg, path: "/tmp/moved" });
  expect((await loadLocalPlacements()).placements).toEqual([
    { configurationTree: cfg, path: "/tmp/notes", tree: shared },
    { configurationTree: cfg, path: "/tmp/moved", tree: other, host: orchard },
  ]);
});
test("a placement on a placement host takes its endpoint from the placement connection, and needs one", async () => {
  const home = await dataHome(), placed = join(home, "orchard-tree");
  const orchard = "https://orchard.example";
  await mkdir(placed); await writeConfiguration(home, join(home, "unused"));
  await writeFile(join(home, "placements.yaml"), `${cfg}:\n  ${placed}: {tree: ${shared}, host: "${orchard}"}\n`);
  const missing = await loadTreeRegistry();
  expect(missing.placementsValid).toBe(false);
  expect(missing.diagnostics.map((diagnostic) => diagnostic.code)).toContain("unknown-placement-host");
  expect(missing.placements.some((placement) => placement.tree === shared)).toBe(false);

  await new HostPlacementStore(cfg, orchard).set({ account: `${orchard}/~joe`, accountID: profile, profileTree: profile, homeHost: overstoryd, placementRoot: "tr_dddddddddddddddddddddddddd" });
  await savePlacementSyncMetadata(shared, { canonicalPath: "/~joe/shared" }, cfg);
  const result = await loadTreeRegistry();
  expect(result.diagnostics).toEqual([]);
  const placement = result.placements.find((candidate) => candidate.tree === shared)!;
  expect(placement).toMatchObject({ configurationTree: cfg, path: placed, endpoint: orchard, canonical: "overstory://orchard.example/~joe/shared" });
  expect(placement).not.toHaveProperty("host");
  // The configuration checkout stays at the home host.
  expect(result.placements.find((candidate) => candidate.kind === "tree-configuration")?.endpoint).toBe(overstoryd);

  // A host naming the home is the home.
  await writeFile(join(home, "placements.yaml"), `${cfg}:\n  ${placed}: {tree: ${shared}, host: "${overstoryd}"}\n`);
  expect((await loadTreeRegistry()).placements.find((candidate) => candidate.tree === shared)?.endpoint).toBe(overstoryd);
});
