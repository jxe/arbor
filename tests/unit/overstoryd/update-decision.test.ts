import { describe, expect, test } from "bun:test";
import { decideUpdate } from "@ovst/overstoryd";
import type { ObjectHash } from "@ovst/protocol";

const A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ObjectHash;
const B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as ObjectHash;
const C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as ObjectHash;

describe("snapshot identity decision table", () => {
  test.each([
    [A, A, A, "current"],
    [A, A, B, "current"],
    [A, B, B, "current"],
    [A, B, A, "accept"],
    [A, B, C, "reconcile"],
  ] as const)("base=%s candidate=%s current=%s chooses %s", (base, candidate, current, expected) => {
    expect(decideUpdate(base, candidate, current)).toBe(expected);
  });
});
