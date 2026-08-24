import { describe, expect, test } from "bun:test";
import { labChildEnvironment, tailscaleAuthKeyFromEnvironment } from "../../tools/hcloud-sync-lab";

describe("hcloud sync lab Tailscale authentication", () => {
  test("keeps interactive authentication when the environment variable is absent", () => {
    expect(tailscaleAuthKeyFromEnvironment({})).toBeUndefined();
  });

  test("returns an auth key without transforming it", () => {
    const authKey = "tskey-auth-example";
    expect(tailscaleAuthKeyFromEnvironment({ TAILSCALE_AUTH_KEY: authKey })).toBe(authKey);
  });

  test("removes the auth key from every child process environment", () => {
    expect(labChildEnvironment({ TAILSCALE_AUTH_KEY: "secret", PATH: "/bin" }))
      .toEqual({ PATH: "/bin" });
  });

  test.each(["", " ", "tskey-auth-example\n", "two values"])(
    "rejects an invalid value without echoing it: %j",
    (authKey) => {
      expect(() => tailscaleAuthKeyFromEnvironment({ TAILSCALE_AUTH_KEY: authKey }))
        .toThrow("TAILSCALE_AUTH_KEY must contain exactly one non-whitespace auth key");
    },
  );
});
