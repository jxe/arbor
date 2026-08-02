import { describe, expect, test } from "bun:test";
import { browseTarget } from "../../packages/cli/src/index.ts";

describe("arbor browse operands", () => {
  test("resolves local filesystem paths", () => {
    expect(browseTarget("notes", "/Users/alice")).toEqual({ path: "/Users/alice/notes" });
  });

  test("opens reserved profile URLs through the local claim flow", () => {
    expect(browseTarget("https://garden.example/~alice/", "/Users/alice")).toEqual({
      path: "/Users/alice",
      claimURL: "https://garden.example/~alice",
    });
  });

  test("does not reinterpret other remote URLs as local paths", () => {
    expect(() => browseTarget("https://garden.example/~alice/notes", "/Users/alice"))
      .toThrow("Remote browsing currently accepts a reserved profile URL");
  });
});
