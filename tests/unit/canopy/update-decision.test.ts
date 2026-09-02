import { describe, expect, test } from "bun:test";
import { decideUpdate } from "@arbor/canopy";
import type { ObjectHash } from "@arbor/wire";

const A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ObjectHash;
const B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as ObjectHash;
const C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as ObjectHash;

describe("updates-v1 identity decision table", () => {
  test.each([
    [A, A, A, "modelHash", "current"],
    [A, A, B, "modelHash", "current"],
    [A, B, B, "modelHash", "current"],
    [A, B, A, "modelHash", "accept"],
    [A, B, C, "modelHash", "reconcile"],
    [A, B, A, "bytesHash", "accept"],
    [A, B, C, "bytesHash", "reject"],
  ] as const)("base=%s candidate=%s current=%s ifMatch=%s chooses %s", (base, candidate, current, ifMatch, expected) => {
    expect(decideUpdate(base, candidate, current, ifMatch)).toBe(expected);
  });
});
