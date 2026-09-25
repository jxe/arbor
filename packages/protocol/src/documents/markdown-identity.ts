import { canonicalStableKey, parseCanonicalStableKey } from "../model/node-key.ts";

/**
 * The Markdown representation's identity codec: a document's frontmatter `id`
 * is its stable key `[["id", <id>]]`. Generic locator, workspace and backlink
 * code handles stable keys only; this is the one place an authored Markdown
 * ID and a stable key convert.
 */
export function markdownStableKey(id: string): string {
  return canonicalStableKey([["id", id]]);
}

export function markdownIDFromStableKey(stableKey: string | null): string | null {
  const pairs = stableKey ? parseCanonicalStableKey(stableKey) : null;
  return pairs?.length === 1 && pairs[0]?.[0] === "id" && typeof pairs[0][1] === "string" ? pairs[0][1] : null;
}
