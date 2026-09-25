import { describe, expect, test } from "bun:test";
import { canonicalStableKey, markdownIDFromStableKey, markdownStableKey } from "@overstory/protocol";

describe("Markdown identity codec", () => {
  test("a frontmatter id is the single-pair id key and back", () => {
    for (const id of ["h31mlm", "pg_2418e521-42b7-4581-8905-8a6ae1803039", "with space"]) {
      expect(markdownStableKey(id)).toBe(canonicalStableKey([["id", id]]));
      expect(markdownIDFromStableKey(markdownStableKey(id))).toBe(id);
    }
  });

  test("any other key is not a Markdown id", () => {
    expect(markdownIDFromStableKey(null)).toBeNull();
    expect(markdownIDFromStableKey(canonicalStableKey([["slug", "walking"]]))).toBeNull();
    expect(markdownIDFromStableKey(canonicalStableKey([["id", 42]]))).toBeNull();
    expect(markdownIDFromStableKey(canonicalStableKey([["id", "a"], ["lang", "en"]]))).toBeNull();
    expect(markdownIDFromStableKey("not json")).toBeNull();
  });
});
