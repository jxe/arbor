import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serveMaintenance } from "../../packages/canopyd/src/cli.ts";
import { dnsLines, parseHostDeploymentConfig } from "../../packages/canopyd/deploy/railway-canopy.ts";

const valid = [
  "ARBOR_RAILWAY_SERVICE=canopy-arb-nxhx-org",
  "ARBOR_RAILWAY_REPO=jxe/arbor",
  "ARBOR_RAILWAY_BRANCH=main",
  "ARBOR_DOMAIN=arb.nxhx.org",
  "ARBOR_COMMUNITY_HANDLE=garden",
  "ARBOR_FIRST_WRITER_HANDLE=joe",
  "ARBOR_FIRST_WRITER_PROFILE=tr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "",
].join("\n");

describe("Railway Canopy deployment config", () => {
  test("railway.toml names a Dockerfile that exists", () => {
    const root = join(import.meta.dir, "..", "..");
    const toml = readFileSync(join(root, "railway.toml"), "utf8");
    const match = /dockerfilePath = "([^"]+)"/.exec(toml);
    expect(match).not.toBeNull();
    expect(existsSync(join(root, match![1]!))).toBe(true);
  });

  test("keeps Railway's root probe healthy during offline maintenance", async () => {
    const server = serveMaintenance(0, "127.0.0.1");
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const root = await fetch(`${origin}/`);
      expect(root.status).toBe(200);
      expect(await root.json()).toEqual({ status: "maintenance" });
      const health = await fetch(`${origin}/.arbor/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "maintenance" });
      const application = await fetch(`${origin}/~joe`);
      expect(application.status).toBe(503);
    } finally {
      server.stop(true);
    }
  });

  test("parses the checked-in non-secret desired state", () => {
    expect(parseHostDeploymentConfig(valid)).toEqual({
      ARBOR_RAILWAY_SERVICE: "canopy-arb-nxhx-org",
      ARBOR_RAILWAY_REPO: "jxe/arbor",
      ARBOR_RAILWAY_BRANCH: "main",
      ARBOR_DOMAIN: "arb.nxhx.org",
      ARBOR_COMMUNITY_HANDLE: "garden",
      ARBOR_FIRST_WRITER_HANDLE: "joe",
      ARBOR_FIRST_WRITER_PROFILE: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  test("rejects unmanaged names and extra settings", () => {
    expect(() => parseHostDeploymentConfig(valid.replace("canopy-arb-nxhx-org", "production"))).toThrow("must start with canopy-");
    expect(() => parseHostDeploymentConfig(`${valid}ARBOR_ACCOUNT_TOKEN=secret\n`)).toThrow("Unsupported Canopy deployment setting");
  });

  test("formats Railway's custom-domain CNAME and ownership TXT records", () => {
    expect(dnsLines({
      domain: {
        dnsRecords: [{
          recordType: "DNS_RECORD_TYPE_CNAME",
          name: "arb",
          requiredValue: "example.up.railway.app",
        }],
        verification: {
          dnsHost: "_railway-verify.arb",
          token: "railway-verify=example",
        },
      },
    })).toEqual([
      "CNAME arb example.up.railway.app",
      "TXT _railway-verify.arb railway-verify=example",
    ]);
  });
});
