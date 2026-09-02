import { stableJSONString } from "@arbor/core";

/** Exact top-level property names changed by a complete property-map write. */
export function changedPropertyNames(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((name) => stableJSONString({ value: before[name] }) !== stableJSONString({ value: after[name] }))
    .sort();
}
