import { describe, expect, test } from "bun:test";
import { dnsLines, parseCanopyDeploymentConfig } from "../../deploy/railway-canopy.ts";

const valid = [
  "ARBOR_RAILWAY_SERVICE=canopy-arb-nxhx-org",
  "ARBOR_RAILWAY_REPO=jxe/arbor",
  "ARBOR_RAILWAY_BRANCH=main",
  "ARBOR_DOMAIN=arb.nxhx.org",
  "ARBOR_COMMUNITY_HANDLE=garden",
  "ARBOR_FIRST_WRITER_HANDLE=joe",
  "",
].join("\n");

describe("Railway Canopy deployment config", () => {
  test("parses the checked-in non-secret desired state", () => {
    expect(parseCanopyDeploymentConfig(valid)).toEqual({
      ARBOR_RAILWAY_SERVICE: "canopy-arb-nxhx-org",
      ARBOR_RAILWAY_REPO: "jxe/arbor",
      ARBOR_RAILWAY_BRANCH: "main",
      ARBOR_DOMAIN: "arb.nxhx.org",
      ARBOR_COMMUNITY_HANDLE: "garden",
      ARBOR_FIRST_WRITER_HANDLE: "joe",
    });
  });

  test("rejects unmanaged names and extra settings", () => {
    expect(() => parseCanopyDeploymentConfig(valid.replace("canopy-arb-nxhx-org", "production"))).toThrow("must start with canopy-");
    expect(() => parseCanopyDeploymentConfig(`${valid}ARBOR_ACCOUNT_TOKEN=secret\n`)).toThrow("Unsupported Canopy deployment setting");
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
