import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentBundleID, agentDevice, buildAgentLink, deviceKeyFromSeed, generateAgentCode, isGeneratedOverstoryID, parseAgentLink } from "@ovst/protocol";

const vectors = JSON.parse(await readFile(join(import.meta.dir, "../../docs/overstory-spec/conformance/agent-code.json"), "utf8")) as {
  devices: Array<{ code: string; deviceID: string; key: string }>;
  links: Array<{ link: string; origin: string; canonicalPath: string; code: string }>;
  rejected: string[];
};

test("an agent code derives its device as the shared vectors say", () => {
  for (const vector of vectors.devices) {
    const device = agentDevice(vector.code);
    expect(device.deviceID).toBe(vector.deviceID);
    expect(deviceKeyFromSeed(device.deviceKeySeed)).toBe(vector.key);
  }
});

test("agent links round-trip and nothing else parses as one", () => {
  for (const vector of vectors.links) {
    expect(parseAgentLink(vector.link)).toMatchObject({ origin: vector.origin, canonicalPath: vector.canonicalPath, code: vector.code });
    expect(buildAgentLink(`${vector.origin}${vector.canonicalPath}`, vector.code)).toBe(vector.link);
  }
  for (const link of vectors.rejected) expect(parseAgentLink(link)).toBeNull();
});

test("a fresh code names a well-formed device and a stable bundle ID", () => {
  const code = generateAgentCode();
  const { deviceID } = agentDevice(code);
  expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(isGeneratedOverstoryID(deviceID, "dv")).toBe(true);
  expect(agentBundleID(deviceID)).toBe(agentBundleID(agentDevice(code).deviceID));
  expect(() => agentDevice("short")).toThrow("22 characters");
});
