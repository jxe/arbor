import { describe, expect, test } from "bun:test";
import { browseTarget } from "../../packages/cli/src/index.ts";
import { resolveUserPath } from "@arbor/arbord";

describe("arbor browse operands", () => {
  test("resolves local filesystem paths", () => {
    expect(browseTarget("notes", "/Users/alice")).toEqual({ path: "/Users/alice/notes" });
  });

  test("recognizes a profile URL while preserving it as a remote location", () => {
    expect(browseTarget("https://garden.example/~alice/", "/Users/alice")).toEqual({
      remoteURL: "https://garden.example/~alice/",
      profile: { origin: "https://garden.example", handle: "alice", path: "/~alice" },
    });
  });

  test("passes other Arbor locations to the remote browser", () => {
    expect(browseTarget("arbor://garden.example/~alice/notes", "/Users/alice")).toEqual({
      remoteURL: "https://garden.example/~alice/notes",
    });
  });

  test("expands a typed home-relative profile path", () => {
    expect(resolveUserPath("~/.arbor/profile", "/Users/alice")).toBe("/Users/alice/.arbor/profile");
  });
});
