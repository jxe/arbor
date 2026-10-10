import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostDaemon } from "@ovst/overstoryd";
import { daemonSession, testAccount } from "../../helpers/devices.ts";

const root = await mkdtemp(join(tmpdir(), "overstoryd-queries-"));
const overstoryd = await HostDaemon.open(root, {
  handle: "community",
  name: "Community",
  accounts: [testAccount("owner", "test-token")],
});
afterAll(async () => {
  await overstoryd[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
});

test("resolve picks the closest enclosing canonical boundary", () => {
  const community = overstoryd.boundary("/")!;
  const owner = overstoryd.boundary("/~owner")!;
  const at = (path: string) => {
    const resolved = overstoryd.resolve(path);
    return resolved && { tree: resolved.tree.id, path: resolved.path };
  };
  expect(at("/")).toEqual({ tree: community.id, path: "/" });
  expect(at("/notes/today")).toEqual({ tree: community.id, path: "/notes/today" });
  expect(at("/~owner")).toEqual({ tree: owner.id, path: "/" });
  expect(at("/~owner/")).toEqual({ tree: owner.id, path: "/" });
  expect(at("/~owner/a/b")).toEqual({ tree: owner.id, path: "/a/b" });
  // A shared name prefix is not an enclosing boundary.
  expect(at("/~ownerx/a")).toEqual({ tree: community.id, path: "/~ownerx/a" });
  expect(overstoryd.resolve("/~owner/a")!.tree).toEqual(owner);
});

test("the authorization epoch moves only when authorization inputs may have changed", async () => {
  const session = await daemonSession(overstoryd, "test-token");
  const reset = new Database(join(root, "overstoryd.sqlite3"));
  reset.run("UPDATE devices SET last_used_at = NULL");
  reset.close();
  const before = overstoryd.authorizationEpoch();
  overstoryd.canRead(null, overstoryd.boundary("/")!.id);
  expect(overstoryd.authorizationEpoch()).toBe(before);
  // Authenticating writes the device's last-use time, which no decision
  // reads: open streams need not check again.
  expect(overstoryd.authenticateToken(session)).not.toBeNull();
  expect((new Database(join(root, "overstoryd.sqlite3"), { readonly: true }).query("SELECT COUNT(*) AS n FROM devices WHERE last_used_at IS NOT NULL").get() as { n: number }).n).toBe(1);
  expect(overstoryd.authorizationEpoch()).toBe(before);
  overstoryd.createPairing(overstoryd.accountByHandle("owner")!);
  const written = overstoryd.authorizationEpoch();
  expect(written).not.toBe(before);
  overstoryd.execution.invalidate();
  const invalidated = overstoryd.authorizationEpoch();
  expect(invalidated).not.toBe(written);
  // A commit by another connection, such as an operator tool, also counts.
  const other = new Database(join(root, "overstoryd.sqlite3"));
  other.run("UPDATE devices SET label = label || ' (renamed)'");
  other.close();
  expect(overstoryd.authorizationEpoch()).not.toBe(invalidated);
});
