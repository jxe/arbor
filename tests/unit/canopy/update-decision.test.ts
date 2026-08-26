import { describe, expect, test } from "bun:test";
import { decideUpdate } from "@arbor/canopy";
import type { ObjectHash } from "@arbor/wire";

const A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ObjectHash;
const B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as ObjectHash;
const C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as ObjectHash;

describe("updates-v1 identity decision table", () => {
  test.each([
    [A, A, A, "current"],
    [A, A, B, "current"],
    [A, B, B, "current"],
    [A, B, A, "accept"],
    [A, B, C, "merge"],
  ] as const)("base=%s candidate=%s current=%s chooses %s", (base, candidate, current, expected) => {
    expect(decideUpdate(base, candidate, current)).toBe(expected);
  });
});
