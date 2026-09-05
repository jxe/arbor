import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalStableKey, rowPathSegment, stableKeyFromProperties } from "@arbor/core/node-key";
import {
  decodeChildrenPage,
  decodeIdentityRule,
  decodeNodeCapabilities,
  decodeNodeSnapshot,
  decodeCollectionFileDescriptor,
} from "@arbor/core/node-model";

const conformance = join(import.meta.dir, "../../conformance");

interface NodeModelFixture {
  version: string;
  identityRules: Array<{
    name: string;
    rule: unknown;
    properties: Record<string, unknown>;
    stableKey: string;
  }>;
  invalidIdentityRules: Array<{ name: string; value: unknown }>;
  snapshots: Array<{ name: string; value: unknown }>;
  childrenPages: Array<{ name: string; value: unknown }>;
  collectionFiles: unknown[];
  forwardCompatibleSnapshot: Record<string, unknown>;
  invalidSnapshots: Array<{ name: string; value: unknown }>;
}

async function fixture(): Promise<NodeModelFixture> {
  return JSON.parse(await readFile(join(conformance, "node-model.json"), "utf8")) as NodeModelFixture;
}

describe("unified node-model conformance", () => {
  test("derives keys through one declaration-site-scoped identity rule", async () => {
    const value = await fixture();
    expect(value.version).toBe("node-model-v1");
    for (const item of value.identityRules) {
      const rule = decodeIdentityRule(item.rule);
      const pairs = rule.properties.map((property) => [property, item.properties[property]] as const);
      expect(canonicalStableKey(pairs), item.name).toBe(item.stableKey);
    }
    for (const item of value.invalidIdentityRules) {
      expect(() => decodeIdentityRule(item.value), item.name).toThrow();
    }
  });

  test("derives portable row keys and deterministic logical child segments", () => {
    const readable = stableKeyFromProperties(["slug"], { slug: "walking", title: "Walking" });
    expect(readable).toBe('[["slug","walking"]]');
    expect(rowPathSegment(readable!)).toBe("walking");

    const compound = stableKeyFromProperties(["list", "position"], { list: "a", position: 2 });
    expect(compound).toBe('[["list","a"],["position",2]]');
    expect(rowPathSegment(compound!)).toStartWith("~row-");
    expect(rowPathSegment('[["id","unsafe.md"]]')).toStartWith("~row-");
    expect(stableKeyFromProperties(["id"], { id: null })).toBeNull();
    expect(stableKeyFromProperties(["id"], { id: Number.NaN })).toBeNull();
  });

  test("decodes snapshots, summaries, capabilities, and collection files without kinds", async () => {
    const value = await fixture();
    const snapshots = value.snapshots.map((item) => decodeNodeSnapshot(item.value));
    const pages = value.childrenPages.map((item) => decodeChildrenPage(item.value));
    const collectionFiles = value.collectionFiles.map(decodeCollectionFileDescriptor);

    expect(snapshots.map((item) => item.ref.path)).toEqual(["/practices", "/data", "/assets/portrait.png"]);
    expect(snapshots[0]?.capabilities.content?.format).toBe("markdown");
    expect(snapshots[0]?.capabilities.children?.backing).toEqual({ type: "expanded-files" });
    expect(snapshots[1]?.capabilities.children?.backing).toEqual({ type: "external-store", driver: "postgres" });
    expect(snapshots[2]?.materialization).toBe("placeholder");
    expect(pages[0]?.items.every((item) => item.ref.stableKey !== null)).toBe(true);
    expect(pages[0]?.items.every((item) => !("kind" in item))).toBe(true);
    expect(collectionFiles.map((item) => item.format)).toEqual(["csv", "json", "jsonl"]);
    expect(new Set(collectionFiles.map((item) => item.childSetHash)).size).toBe(1);
    expect(() => decodeCollectionFileDescriptor({
      ...collectionFiles[0],
      format: "sqlite",
    })).toThrow();
  });

  test("ignores unknown capabilities without granting behavior", async () => {
    const value = await fixture();
    const snapshot = decodeNodeSnapshot(value.forwardCompatibleSnapshot);
    expect(snapshot.capabilities).toEqual({ properties: { revision: "future:1", writable: false } });
    expect(snapshot.capabilities.content).toBeUndefined();
    expect(snapshot.capabilities.children).toBeUndefined();
    expect(snapshot.capabilities.executable).toBeUndefined();
    expect(decodeNodeCapabilities({ futureWrite: { writable: true } })).toEqual({});
  });

  test("rejects the frozen legacy and implicit-authority shapes", async () => {
    const value = await fixture();
    expect(value.invalidSnapshots.map((item) => item.name)).toEqual([
      "missing-nullable-stable-key",
      "legacy-page-reference",
      "duplicated-location",
      "public-kind-taxonomy",
      "implicit-write-grant",
    ]);
    for (const item of value.invalidSnapshots) {
      expect(() => decodeNodeSnapshot(item.value), item.name).toThrow();
    }
  });

  test("freezes tree-scoped query and mutate endpoint names", async () => {
    const endpoints = JSON.parse(await readFile(join(conformance, "wire-endpoints.json"), "utf8")) as {
      version: number;
      cases: Array<{ name: string; request: { method: string; path: string } }>;
    };
    expect(endpoints.version).toBe(8);
    expect(endpoints.cases.find((item) => item.name === "query-derived-model-state")?.request).toMatchObject({
      method: "QUERY",
      path: "/.arbor/trees/tr_atlas/queries",
    });
    expect(endpoints.cases.find((item) => item.name === "mutate-reviewed-model-intent")?.request).toMatchObject({
      method: "POST",
      path: "/.arbor/trees/tr_atlas/mutate",
    });
  });
});
