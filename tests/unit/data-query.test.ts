import { describe, expect, test } from "bun:test";
import { logicalPathFrom, node, nodeIn, nodesNamedIn } from "overstory/data";
import { codeVersion, importCandidates } from "@ovst/exec-protocol";

describe("node paths", () => {
  test("reads an overstory: node path and refuses other schemes", () => {
    expect(node("overstory://garden.example/~ada/data/List").children).toBeDefined();
    expect(() => node("arbor://garden.example/~ada/data/List")).toThrow("node() requires");
    expect(() => node("ftp://garden.example/data/List")).toThrow("node() requires");
  });

  test("tree code names nodes from its own module's place, never outside its tree", () => {
    expect(logicalPathFrom("/supplies/scripts/views.ts", "../data/List")).toBe("/supplies/data/List");
    expect(logicalPathFrom("/supplies/List.tsx", "./data")).toBe("/supplies/data");
    expect(logicalPathFrom("/supplies/List.tsx", "/other/data")).toBe("/other/data");
    expect(() => logicalPathFrom("/supplies/List.tsx", "../../escape")).toThrow("leaves its tree");
    expect(() => logicalPathFrom("/supplies/List.tsx", "overstory://garden.example/~ada/data")).toThrow("names a path in that tree");
    const helper = nodeIn({ key: "helper", path: "/supplies/scripts/views.ts" }, "../data/List");
    expect(helper.path).toBe("/supplies/data/List");
    nodeIn({ key: "page", path: "/supplies/List.tsx" }, "./data/List");
    expect(nodesNamedIn("helper")).toEqual(["/supplies/data/List"]);
    expect(nodesNamedIn("page")).toEqual(["/supplies/data/List"]);
  });
});

describe("tree code", () => {
  test("relative imports resolve inside the tree, with extensions tried in order", () => {
    expect(importCandidates("/supplies/List.tsx", "./scripts/views").slice(0, 2)).toEqual(["/supplies/scripts/views.ts", "/supplies/scripts/views.tsx"]);
    expect(importCandidates("/supplies/views/list.tsx", "../scripts/views.ts")[0]).toBe("/supplies/scripts/views.ts");
    expect(importCandidates("/List.tsx", "../escape")).toEqual([]);
  });

  test("a code version names the files, not where else the tree changed", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    const one = codeVersion({ "/a.ts": bytes("export const a = 1"), "/b.ts": bytes("export const b = 2") });
    expect(codeVersion({ "/b.ts": bytes("export const b = 2"), "/a.ts": bytes("export const a = 1") })).toBe(one);
    expect(codeVersion({ "/a.ts": bytes("export const a = 2"), "/b.ts": bytes("export const b = 2") })).not.toBe(one);
    expect(codeVersion({ "/c.ts": bytes("export const a = 1"), "/b.ts": bytes("export const b = 2") })).not.toBe(one);
    expect(one).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
