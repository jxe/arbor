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
