import { describe, expect, test } from "bun:test";
import {
  authorizeAccountConfigTransition,
  mergeAccountConfigGraphs,
  mergeAccountConfigTrees,
} from "../../../packages/canopyd/src/account-policy.ts";
import { readAccountConfigGraph, snapshotAccountConfig, type AccountConfigGraph, type AccountConfigValues } from "@overstory/protocol";

const profile = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const tree = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const admin = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const phone = "dv_bbbbbbbbbbbbbbbbbbbbbbbbbb";

function graph(): AccountConfigValues {
  return {
    account: { canopy: "https://canopy.example", profile },
    resources: { [tree]: { canonical: "https://canopy.example/~joe/notes", access: [] } },
    devices: {
      [admin]: { id: admin, label: "Mac", administrator: true },
      [phone]: { id: phone, label: "Phone", administrator: false },
    },
  };
}

function roundTrip(value = graph()): AccountConfigGraph {
  return readAccountConfigGraph(snapshotAccountConfig(value));
}

describe("account-config-v2 policy", () => {
  test("round-trips the exact three-file graph", () => {
    expect(roundTrip()).toMatchObject(graph());
  });

  test("ordinary devices may change only their own label", () => {
    const current = roundTrip();
    const renamed = roundTrip({ ...graph(), devices: { ...graph().devices, [phone]: { ...graph().devices[phone]!, label: "iPhone" } } });
    expect(() => authorizeAccountConfigTransition(current, renamed, phone)).not.toThrow();
    const promoted = roundTrip({ ...graph(), devices: { ...graph().devices, [phone]: { ...graph().devices[phone]!, administrator: true } } });
    expect(() => authorizeAccountConfigTransition(current, promoted, phone)).toThrow("only its own label");
  });

  test("administrators may promote and revoke but cannot remove the last administrator", () => {
    const current = roundTrip();
    const promoted = roundTrip({ ...graph(), devices: { ...graph().devices, [phone]: { ...graph().devices[phone]!, administrator: true } } });
    expect(() => authorizeAccountConfigTransition(current, promoted, admin)).not.toThrow();
    const noAdmin: AccountConfigGraph = { ...current, devices: { [phone]: current.devices[phone]! } };
    expect(() => authorizeAccountConfigTransition(current, noAdmin, admin)).toThrow("administrator must remain");
  });

  test("device deletion wins a concurrent edit", () => {
    const base = roundTrip();
    const removed = roundTrip({ ...graph(), devices: { [admin]: graph().devices[admin]! } });
    const edited = roundTrip({ ...graph(), devices: { ...graph().devices, [phone]: { ...graph().devices[phone]!, label: "Edited" } } });
    expect(mergeAccountConfigGraphs(base, removed, edited).graph.devices[phone]).toBeUndefined();
  });

  test("canopyd merges the tree itself: independent labels merge, same-field edits conflict by file", async () => {
    const labels = (a: string, b: string) => snapshotAccountConfig({ ...graph(), devices: {
      [admin]: { ...graph().devices[admin]!, label: a }, [phone]: { ...graph().devices[phone]!, label: b },
    } });
    const snapshots = [labels("Mac", "Phone"), labels("Desktop", "Phone"), labels("Mac", "Mobile"), labels("Laptop", "Phone")];
    const objects = new Map(snapshots.flatMap(s => [...s.objects]));
    const load = async (hash: string) => objects.get(hash)!;
    const [base, current, incoming, competing] = snapshots.map(s => s.root);
    const merged = await mergeAccountConfigTrees(base!, incoming!, current!, load);
    expect(merged.root).toBe(labels("Desktop", "Mobile").root);
    expect(merged.conflicts).toEqual([]);
    expect(merged.summary).toEqual({ version: "account-config-v2", mergedFields: 1 });
    const conflicted = await mergeAccountConfigTrees(base!, competing!, current!, load);
    expect(conflicted.conflicts).toEqual([{ path: "/devices.yaml", reason: "account-configuration" }]);
  });
});

describe("resource policy configuration", () => {
  function resourceGraph(allow: string[]) {
    return roundTrip({ ...graph(), resources: { [tree]: { canonical: "https://canopy.example/~joe/notes", access: allow.length ? [{ who: "me", via: "tr_supplies", allow: allow as any }] : [] } } });
  }
  test("policy-only entries survive serialization without becoming hosted trees", () => {
    const result = roundTrip({ ...graph(), resources: { [tree]: { access: [{ who: "me", via: "tr_supplies", allow: ["read"] }] } } });
    expect(result.trees[tree]).toBeUndefined();
    expect(result.resources?.[tree]?.access[0]?.via).toBe("tr_supplies");
  });
  test("ordinary devices cannot add grants even when hosting projection is unchanged", () => {
    expect(() => authorizeAccountConfigTransition(resourceGraph(["read"]), resourceGraph(["write"]), phone)).toThrow("administrator");
  });
  test("concurrent narrowing and removal never union back privilege", () => {
    const base = resourceGraph(["write"]);
    const a = resourceGraph(["read"]), b = resourceGraph(["create-child"]);
    const merged = mergeAccountConfigGraphs(base, a, b);
    expect(merged.conflicts.length).toBeGreaterThan(0);
    expect(merged.graph.resources?.[tree]?.access).toEqual([]);
    expect(mergeAccountConfigGraphs(base, resourceGraph([]), b).graph.resources?.[tree]?.access).toEqual([]);
  });
});

test("spelling the default scope explicitly is not a competing policy edit", () => {
  const initial = graph();
  const base = roundTrip({ ...initial, resources: { [tree]: { canonical: initial.resources[tree]!.canonical,
    access: [{ who: "me", via: "tr_supplies", allow: ["read"] }] } } });
  const candidate = structuredClone(base);
  candidate.resources![tree]!.access[0]!.within = "/";
  const remote = structuredClone(base);
  remote.resources![tree]!.access[0]!.allow = ["read", "create-child"];
  const merged = mergeAccountConfigGraphs(base, candidate, remote);
  expect(merged.conflicts).toEqual([]);
  expect(merged.graph.resources![tree]!.access[0]!.allow).toEqual(["create-child", "read"]);
});
