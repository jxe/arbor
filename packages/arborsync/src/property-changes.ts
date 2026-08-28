import { canonicalJSONString } from "@arbor/core";

/** Exact top-level property names changed by a complete property-map write. */
export function changedPropertyNames(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((name) => canonicalJSONString({ value: before[name] }) !== canonicalJSONString({ value: after[name] }))
    .sort();
}
