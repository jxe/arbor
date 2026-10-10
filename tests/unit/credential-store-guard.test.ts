import { describe, expect, test } from "bun:test";

// The preload (tests/helpers/data-home-guard.ts) keeps the suite off the
// developer's Keychain; these assertions fail if it stops doing so.
describe("test credential store", () => {
  test("defaults to the file store, which spawned processes inherit", () => {
    expect(process.env.STORY_CREDENTIAL_STORE).toBe("file");
  });

  test("the OS credential store refuses every call", async () => {
    const location = { service: "org.arbor.person-profile", name: "guard-probe" };
    await expect(Bun.secrets.get(location)).rejects.toThrow("real OS credential store");
    await expect(Bun.secrets.set({ ...location, value: "x" })).rejects.toThrow("real OS credential store");
    await expect(Bun.secrets.delete(location)).rejects.toThrow("real OS credential store");
  });
});
