import { describe, expect, test } from "bun:test";
import { canonicalStableKey, type JSONValue, type NodeRef, type NodeSummary } from "@arbor/core";
import { collectionRowNavigationTarget, writeCollectionProperty } from "../../packages/render/src/CollectionView.tsx";

function row(writable = true): NodeSummary {
  return {
    ref: {
      tree: "tr_records",
      path: "/records/first",
      stableKey: canonicalStableKey([["id", "first"]]),
    },
    name: "First",
    revision: "sha256:row",
    properties: { id: "first", title: "Before", count: 1, active: false },
    capabilities: {
      properties: { revision: "sha256:properties", writable },
    },
    materialization: "available",
    diagnostics: [],
  };
}

describe("collection property editing", () => {
  test("navigates with the complete stable row reference", () => {
    const source = row();
    expect(collectionRowNavigationTarget(source)).toEqual(source.ref);
    expect(collectionRowNavigationTarget(source).stableKey).not.toBeNull();
  });

  test("writes complete generic properties through the row's stable reference", async () => {
    let written: { ref: NodeRef; revision: string; properties: Record<string, JSONValue> } | undefined;
    const source = row();

    const changed = await writeCollectionProperty(async (ref, revision, properties) => {
      written = { ref, revision, properties };
    }, source, "count", "2");

    expect(changed).toBe(true);
    expect(written).toEqual({
      ref: source.ref,
      revision: "sha256:properties",
      properties: { id: "first", title: "Before", count: 2, active: false },
    });
  });

  test("preserves boolean property types", async () => {
    let properties: Record<string, JSONValue> | undefined;
    await writeCollectionProperty(async (_ref, _revision, value) => { properties = value; }, row(), "active", "true");
    expect(properties?.active).toBe(true);
  });

  test("does not invoke a writer for read-only rows", async () => {
    let calls = 0;
    const changed = await writeCollectionProperty(async () => { calls += 1; }, row(false), "title", "After");
    expect(changed).toBe(false);
    expect(calls).toBe(0);
  });
});
