import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CanopyDaemon } from "@overstory/canopyd";

const root = await mkdtemp(join(tmpdir(), "arbor-canopy-resolve-"));
const canopy = await CanopyDaemon.open(root, {
  handle: "community",
  name: "Community",
  accounts: [{ handle: "owner", token: "test-token" }],
});
afterAll(async () => {
  await canopy[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
});

test("resolve picks the closest enclosing canonical boundary", () => {
  const community = canopy.boundary("/")!;
  const owner = canopy.boundary("/~owner")!;
  const at = (path: string) => {
    const resolved = canopy.resolve(path);
    return resolved && { tree: resolved.tree.id, path: resolved.path };
  };
  expect(at("/")).toEqual({ tree: community.id, path: "/" });
  expect(at("/notes/today")).toEqual({ tree: community.id, path: "/notes/today" });
  expect(at("/~owner")).toEqual({ tree: owner.id, path: "/" });
  expect(at("/~owner/")).toEqual({ tree: owner.id, path: "/" });
  expect(at("/~owner/a/b")).toEqual({ tree: owner.id, path: "/a/b" });
  // A shared name prefix is not an enclosing boundary.
  expect(at("/~ownerx/a")).toEqual({ tree: community.id, path: "/~ownerx/a" });
  expect(canopy.resolve("/~owner/a")!.tree).toEqual(owner);
});
