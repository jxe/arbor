import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_CLOUD_BUNDLE_LENGTH,
  cloudPlacementPath,
  decodeCloudBundle,
  encodeCloudBundle,
  loadCloudBundles,
  saveCloudBundleRecord,
  validateCloudPlacementPaths,
  type CloudBundlePayload,
} from "../../packages/cli/src/cloud.ts";

const originalCloudHome = process.env.ARBOR_CLOUD_HOME;
const temporaryHomes: string[] = [];

afterEach(async () => {
  if (originalCloudHome === undefined) delete process.env.ARBOR_CLOUD_HOME;
  else process.env.ARBOR_CLOUD_HOME = originalCloudHome;
  await Promise.all(temporaryHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function payload(overrides: Partial<CloudBundlePayload> = {}): CloudBundlePayload {
  return {
    version: 1,
    bundleID: "cb_0123456789abcdefghij",
    label: "Cloud agent",
    createdAt: "2026-09-06T12:00:00.000Z",
    origin: "https://garden.example",
    account: "https://garden.example/~joe",
    accountID: "account-1",
    configurationTree: "tr_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst",
    profileTree: "tr_bcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstu",
    deviceID: "dv_abcdefghijklmnopqrstuvwxyz",
    credential: `arb_${"a".repeat(64)}`,
    placements: [{
      treeID: "tr_cdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv",
      canonicalURL: "https://garden.example/~joe/code",
      relativePath: "src/code",
    }],
    ...overrides,
  };
}

describe("cloud bundle strings", () => {
  test("round-trip authorization and placements in a versioned opaque string", () => {
    const original = payload();
    const encoded = encodeCloudBundle(original);
    expect(encoded.startsWith(`arbor-cloud-v1.${original.bundleID}.`)).toBe(true);
    expect(decodeCloudBundle(encoded)).toEqual(original);
  });

  test("decodes a bundle Canopy's Share panel encoded", () => {
    // Made by `CanopyCloudBundle.encode` (swift/CanopyApp/CanopyAgentBundle.swift):
    // Apple's raw DEFLATE of sorted-key JSON must stay readable here.
    const fromCanopy = "arbor-cloud-v1.cb_0123456789abcdefghij.pZLBTsMwDIZfZcqZrmmBwnqbxAWJA0LjAkKTm7htRpqUNCmDaTw77jq0C0wCohwi54v9-3c2DISwwXiWs9r7tsvjuAIn0UxxDU2rMf5YWWQnX9z1FZH7c5RQvAhGatyFRbHkSXp6dp5dXM6gEBLLqlYrgoQ1paqCA6-sWThEor1bHphn3RjbvrjOh_51_fY-ZvnufsjmEDzK-SA65WkW8VnEs0WS5pzTnnLOH0aM-vAK9CDZFUv456KcEnslxm5lf0Q_oRoKHCrPKxIxKa2bCCsHJ61TlTI_Gk5Eq0FgQ886lj9umABjjRKg7-9ujs8p3pdwqMnqHm_B18Ngxqgn43fSyfrfGx96tn0ibc6WSuNhiH-YYSAxPbqOPgPLk-0n";
    expect(decodeCloudBundle(fromCanopy)).toEqual(payload({
      label: "Agent for code",
      placements: [{ ...payload().placements[0]!, relativePath: "code" }],
    }));
  });

  test("rejects corrupt, unsupported, and mismatched payloads", () => {
    const encoded = encodeCloudBundle(payload());
    expect(() => decodeCloudBundle(encoded.replace("arbor-cloud-v1", "arbor-cloud-v2"))).toThrow("unsupported version");
    expect(() => decodeCloudBundle(`${encoded.slice(0, -3)}xxx`)).toThrow("corrupt");
    expect(() => decodeCloudBundle(encoded.replace("cb_0123456789abcdefghij", "cb_0123456789abcdefghik"))).toThrow("does not match");
  });

  test("enforces portable, disjoint placement paths", () => {
    expect(validateCloudPlacementPaths(["code", "docs/reference"])).toEqual(["code", "docs/reference"]);
    expect(() => validateCloudPlacementPaths(["code", "code/tests"])).toThrow("must not overlap");
    expect(() => validateCloudPlacementPaths(["../code"])).toThrow("parent segments");
    expect(() => validateCloudPlacementPaths(["code\\windows"])).toThrow("portable relative path");
    expect(cloudPlacementPath("/workspace", "code/tests")).toBe(join("/workspace", "code", "tests"));
  });

  test("rejects encoded strings over the public limit", () => {
    const random = Array.from(crypto.getRandomValues(new Uint8Array(40_000)), (value) => String.fromCharCode(33 + (value % 90))).join("");
    expect(() => encodeCloudBundle(payload({ placements: [{
      ...payload().placements[0]!,
      relativePath: `code/${Buffer.from(random).toString("base64url")}`,
    }] }))).toThrow(`${MAX_CLOUD_BUNDLE_LENGTH}-character limit`);
  });

  test("safe registry never stores the credential or placements", async () => {
    const home = await mkdtemp(join(tmpdir(), "arbor-cloud-registry-"));
    temporaryHomes.push(home);
    process.env.ARBOR_CLOUD_HOME = home;
    await saveCloudBundleRecord({
      bundleID: "cb_0123456789abcdefghij",
      label: "Cloud agent",
      createdAt: "2026-09-06T12:00:00.000Z",
      origin: "https://garden.example",
      account: "https://garden.example/~joe",
      configurationTree: payload().configurationTree,
      deviceID: payload().deviceID,
    });
    expect(await loadCloudBundles()).toEqual([{
      bundleID: "cb_0123456789abcdefghij",
      label: "Cloud agent",
      createdAt: "2026-09-06T12:00:00.000Z",
      origin: "https://garden.example",
      account: "https://garden.example/~joe",
      configurationTree: payload().configurationTree,
      deviceID: payload().deviceID,
    }]);
    expect(JSON.stringify(await loadCloudBundles())).not.toContain("credential");
    expect(JSON.stringify(await loadCloudBundles())).not.toContain("placements");
  });

  test("safe registry keeps the placed TreeIDs and rejects malformed ones", async () => {
    const home = await mkdtemp(join(tmpdir(), "arbor-cloud-registry-trees-"));
    temporaryHomes.push(home);
    process.env.ARBOR_CLOUD_HOME = home;
    const record = {
      bundleID: "cb_0123456789abcdefghij",
      label: "Cloud agent",
      createdAt: "2026-09-06T12:00:00.000Z",
      origin: "https://garden.example",
      account: "https://garden.example/~joe",
      configurationTree: payload().configurationTree,
      deviceID: payload().deviceID,
      trees: [payload().placements[0]!.treeID],
    };
    await saveCloudBundleRecord(record);
    expect(await loadCloudBundles()).toEqual([record]);
    await writeFile(join(home, "bundles.json"), JSON.stringify([{ ...record, trees: ["code"] }]));
    expect(loadCloudBundles()).rejects.toThrow("tree 1 must be a TreeID");
  });

  test("rejects injected registry fields instead of echoing them", async () => {
    const home = await mkdtemp(join(tmpdir(), "arbor-cloud-registry-corrupt-"));
    temporaryHomes.push(home);
    process.env.ARBOR_CLOUD_HOME = home;
    await writeFile(join(home, "bundles.json"), JSON.stringify([{
      bundleID: "cb_0123456789abcdefghij",
      label: "Cloud agent",
      createdAt: "2026-09-06T12:00:00.000Z",
      origin: "https://garden.example",
      account: "https://garden.example/~joe",
      configurationTree: payload().configurationTree,
      deviceID: payload().deviceID,
      credential: payload().credential,
    }]));
    expect(loadCloudBundles()).rejects.toThrow("unknown fields: credential");
  });
});
