import { describe, expect, test } from "bun:test";
import {
  authorizeAccountConfigTransitionV2,
  mergeAccountConfigGraphsV2,
  readAccountConfigGraphV2,
  snapshotAccountConfigV2,
  type AccountConfigGraphV2,
} from "../../../packages/canopy/src/account-policy-v2.ts";

const profile = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const tree = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const admin = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const phone = "dv_bbbbbbbbbbbbbbbbbbbbbbbbbb";

function graph(): Omit<AccountConfigGraphV2, "sources"> {
  return {
    account: { canopy: "https://canopy.example", profile },
    trees: { [tree]: { canonical: "https://canopy.example/~joe/notes", access: [] } },
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
});
