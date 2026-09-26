import { describe, expect, test } from "bun:test";
import { authorizePersonConfigTransition, mergeTreeConfigTrees } from "../../../packages/canopyd/src/tree-config-policy.ts";
import { readTreeConfigGraph, snapshotTreeConfig, type TreeConfigValues } from "@overstory/protocol";

const profile = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const admin = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const phone = "dv_bbbbbbbbbbbbbbbbbbbbbbbbbb";

function person(): TreeConfigValues {
  return {
    access: [{ who: { profile }, allow: ["admin"] }],
    mounts: {},
    apps: {},
    devices: {
      [admin]: { id: admin, label: "Mac", administrator: true },
      [phone]: { id: phone, label: "Phone", administrator: false },
    },
  };
}

function roundTrip(value = person()): TreeConfigValues {
  return readTreeConfigGraph(snapshotTreeConfig(value), "person", profile);
}

describe("tree-config-v1: a person's own configuration", () => {
  test("round-trips the four-file graph", () => {
    expect(roundTrip()).toMatchObject(person());
  });

  test("ordinary devices may change only their own label", () => {
    const current = roundTrip();
    const renamed = roundTrip({ ...person(), devices: { ...person().devices, [phone]: { ...person().devices![phone]!, label: "iPhone" } } });
    expect(() => authorizePersonConfigTransition(current, renamed, phone)).not.toThrow();
    const promoted = roundTrip({ ...person(), devices: { ...person().devices, [phone]: { ...person().devices![phone]!, administrator: true } } });
    expect(() => authorizePersonConfigTransition(current, promoted, phone)).toThrow("only its own label");
    const revoking = roundTrip({ ...person(), devices: { [phone]: person().devices![phone]!, [admin]: person().devices![admin]! } });
    expect(() => authorizePersonConfigTransition(current, { ...revoking, devices: { [admin]: person().devices![admin]! } }, phone)).toThrow("only its own label");
  });

  test("ordinary devices cannot edit rules, mounts or app approvals", () => {
    const current = roundTrip();
    expect(() => authorizePersonConfigTransition(current, roundTrip({ ...person(), access: [...person().access, { who: "everyone", allow: ["read"] }] }), phone)).toThrow("administrator device");
    expect(() => authorizePersonConfigTransition(current, roundTrip({ ...person(), apps: { tr_code: [{ resource: "tr_data", who: "me", allow: ["read"] }] } }), phone)).toThrow("administrator device");
    expect(() => authorizePersonConfigTransition(current, roundTrip({ ...person(), apps: { tr_code: [{ resource: "tr_data", who: "me", allow: ["read"] }] } }), admin)).not.toThrow();
  });

  test("an unlisted device may not edit, and revoking the last administrator device is invalid", () => {
    expect(() => authorizePersonConfigTransition(roundTrip(), roundTrip(), "dv_cccccccccccccccccccccccccc")).toThrow("not active");
    expect(() => roundTrip({ ...person(), devices: { [phone]: person().devices![phone]! } })).toThrow("administrator");
  });

  test("a co-administrator on a person's profile is invalid", () => {
    expect(() => roundTrip({ ...person(), access: [...person().access, { who: { profile: "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb" }, allow: ["admin"] }] })).toThrow("no one else");
  });

  test("canopyd merges configurations itself: independent labels merge, same-field edits conflict by file", async () => {
    const labels = (a: string, b: string) => snapshotTreeConfig({ ...person(), devices: {
      [admin]: { ...person().devices![admin]!, label: a }, [phone]: { ...person().devices![phone]!, label: b },
    } });
    const snapshots = [labels("Mac", "Phone"), labels("Desktop", "Phone"), labels("Mac", "Mobile"), labels("Laptop", "Phone")];
    const objects = new Map(snapshots.flatMap((s) => [...s.objects]));
    const load = async (hash: string) => objects.get(hash)!;
    const [base, current, incoming, competing] = snapshots.map((s) => s.root);
    const merged = await mergeTreeConfigTrees("person", base!, incoming!, current!, load);
    expect(merged.root).toBe(labels("Desktop", "Mobile").root);
    expect(merged.conflicts).toEqual([]);
    const conflicted = await mergeTreeConfigTrees("person", base!, competing!, current!, load);
    expect(conflicted.conflicts).toEqual([{ path: "/devices.yaml", reason: "tree-configuration" }]);
  });

  test("an ambiguous rule edit is a policy conflict holding the intersection", async () => {
    const tree = "tr_tttttttttttttttttttttttttt";
    const rules = (allow: string[]) => snapshotTreeConfig({
      access: [{ who: { profile }, allow: ["admin"] }, { who: { profile: tree }, allow: allow as any }],
      mounts: {},
    });
    const snapshots = [rules(["write"]), rules(["read", "create-child"]), rules(["read", "delete"])];
    const objects = new Map(snapshots.flatMap((s) => [...s.objects]));
    const merged = await mergeTreeConfigTrees("tree", snapshots[0]!.root, snapshots[1]!.root, snapshots[2]!.root, async (hash) => objects.get(hash)!);
    expect(merged.conflicts).toEqual([{ path: "/access.yaml", reason: "tree-configuration-policy" }]);
    expect(merged.root).toBe(rules(["read"]).root);
  });
});
