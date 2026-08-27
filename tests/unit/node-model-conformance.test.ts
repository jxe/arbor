import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalStableKey } from "@arbor/core/node-key";
import {
  decodeChildrenPage,
  decodeIdentityRule,
  decodeNodeCapabilities,
  decodeNodeSnapshot,
  decodeRollupDescriptor,
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
  snapshots: Array<{ name: string; value: unknown }>;
  childrenPages: Array<{ name: string; value: unknown }>;
  rollups: unknown[];
  forwardCompatibleSnapshot: Record<string, unknown>;
  invalidSnapshots: Array<{ name: string; value: unknown }>;
}

async function fixture(): Promise<NodeModelFixture> {
  return JSON.parse(await readFile(join(conformance, "node-model.json"), "utf8")) as NodeModelFixture;
}

describe("unified node-model conformance", () => {
  test("derives tree- and parent-scoped keys through one identity rule", async () => {
    const value = await fixture();
    expect(value.version).toBe("node-model-v1");
    for (const item of value.identityRules) {
      const rule = decodeIdentityRule(item.rule);
      const pairs = rule.properties.map((property) => [property, item.properties[property]] as const);
      expect(canonicalStableKey(pairs), item.name).toBe(item.stableKey);
    }
  });

  test("decodes snapshots, summaries, capabilities, and rollups without kinds", async () => {
    const value = await fixture();
    const snapshots = value.snapshots.map((item) => decodeNodeSnapshot(item.value));
    const pages = value.childrenPages.map((item) => decodeChildrenPage(item.value));
    const rollups = value.rollups.map(decodeRollupDescriptor);

    expect(snapshots.map((item) => item.ref.path)).toEqual(["/practices", "/data", "/assets/portrait.png"]);
    expect(snapshots[0]?.capabilities.content?.format).toBe("markdown");
    expect(snapshots[0]?.capabilities.children?.representation).toEqual({ type: "expanded" });
    expect(snapshots[1]?.capabilities.children?.representation).toEqual({ type: "external", driver: "postgres" });
    expect(snapshots[2]?.materialization).toBe("placeholder");
    expect(pages[0]?.items.every((item) => item.ref.stableKey !== null)).toBe(true);
    expect(pages[0]?.items.every((item) => !("kind" in item))).toBe(true);
    expect(rollups.map((item) => item.codec)).toEqual(["csv", "json", "jsonl", "sqlite"]);
    expect(new Set(rollups.slice(0, 3).map((item) => item.modelDigest)).size).toBe(1);
    expect(rollups.at(-1)?.scope).toBe("subtree");
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
    expect(endpoints.version).toBe(6);
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
