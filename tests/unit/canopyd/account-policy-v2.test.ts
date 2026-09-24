import { describe, expect, test } from "bun:test";
import {
  authorizeAccountConfigTransitionV2,
  mergeAccountConfigGraphsV2,
  mergeAccountConfigTreesV2,
  readAccountConfigGraphV2,
  snapshotAccountConfigV2,
  type AccountConfigGraphV2,
} from "../../../packages/canopyd/src/account-policy-v2.ts";
import type { AccountConfigValuesV2 } from "@overstory/protocol";

const profile = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const tree = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const admin = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const phone = "dv_bbbbbbbbbbbbbbbbbbbbbbbbbb";

function graph(): AccountConfigValuesV2 {
  return {
    account: { canopy: "https://canopy.example", profile },
    resources: { [tree]: { canonical: "https://canopy.example/~joe/notes", access: [] } },
    devices: {
      [admin]: { id: admin, label: "Mac", administrator: true },
      [phone]: { id: phone, label: "Phone", administrator: false },
    },
  };
}

function roundTrip(value = graph()): AccountConfigGraphV2 {
  return readAccountConfigGraphV2(snapshotAccountConfigV2(value));
}

describe("account-config-v2 policy", () => {
  test("round-trips the exact three-file graph", () => {
    expect(roundTrip()).toMatchObject(graph());
  });

  test("ordinary devices may change only their own label", () => {
    const current = roundTrip();
    const renamed = roundTrip({ ...graph(), devices: { ...graph().devices, [phone]: { ...graph().devices[phone]!, label: "iPhone" } } });
    expect(() => authorizeAccountConfigTransitionV2(current, renamed, phone)).not.toThrow();
    const promoted = roundTrip({ ...graph(), devices: { ...graph().devices, [phone]: { ...graph().devices[phone]!, administrator: true } } });
    expect(() => authorizeAccountConfigTransitionV2(current, promoted, phone)).toThrow("only its own label");
  });

  test("administrators may promote and revoke but cannot remove the last administrator", () => {
    const current = roundTrip();
    const promoted = roundTrip({ ...graph(), devices: { ...graph().devices, [phone]: { ...graph().devices[phone]!, administrator: true } } });
    expect(() => authorizeAccountConfigTransitionV2(current, promoted, admin)).not.toThrow();
    const noAdmin: AccountConfigGraphV2 = { ...current, devices: { [phone]: current.devices[phone]! } };
    expect(() => authorizeAccountConfigTransitionV2(current, noAdmin, admin)).toThrow("administrator must remain");
  });

  test("device deletion wins a concurrent edit", () => {
    const base = roundTrip();
    const removed = roundTrip({ ...graph(), devices: { [admin]: graph().devices[admin]! } });
    const edited = roundTrip({ ...graph(), devices: { ...graph().devices, [phone]: { ...graph().devices[phone]!, label: "Edited" } } });
    expect(mergeAccountConfigGraphsV2(base, removed, edited).graph.devices[phone]).toBeUndefined();
  });

  test("canopyd merges the tree itself: independent labels merge, same-field edits conflict by file", async () => {
    const labels = (a: string, b: string) => snapshotAccountConfigV2({ ...graph(), devices: {
      [admin]: { ...graph().devices[admin]!, label: a }, [phone]: { ...graph().devices[phone]!, label: b },
    } });
    const snapshots = [labels("Mac", "Phone"), labels("Desktop", "Phone"), labels("Mac", "Mobile"), labels("Laptop", "Phone")];
    const objects = new Map(snapshots.flatMap(s => [...s.objects]));
    const load = async (hash: string) => objects.get(hash)!;
    const [base, current, incoming, competing] = snapshots.map(s => s.root);
    const merged = await mergeAccountConfigTreesV2(base!, incoming!, current!, load);
    expect(merged.root).toBe(labels("Desktop", "Mobile").root);
    expect(merged.conflicts).toEqual([]);
    expect(merged.summary).toEqual({ version: "account-config-v2", mergedFields: 1 });
    const conflicted = await mergeAccountConfigTreesV2(base!, competing!, current!, load);
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
    expect(() => authorizeAccountConfigTransitionV2(resourceGraph(["read"]), resourceGraph(["write"]), phone)).toThrow("administrator");
  });
  test("concurrent narrowing and removal never union back privilege", () => {
    const base = resourceGraph(["write"]);
    const a = resourceGraph(["read"]), b = resourceGraph(["create-child"]);
    const merged = mergeAccountConfigGraphsV2(base, a, b);
    expect(merged.conflicts.length).toBeGreaterThan(0);
    expect(merged.graph.resources?.[tree]?.access).toEqual([]);
    expect(mergeAccountConfigGraphsV2(base, resourceGraph([]), b).graph.resources?.[tree]?.access).toEqual([]);
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
  const merged = mergeAccountConfigGraphsV2(base, candidate, remote);
  expect(merged.conflicts).toEqual([]);
  expect(merged.graph.resources![tree]!.access[0]!.allow).toEqual(["create-child", "read"]);
});
