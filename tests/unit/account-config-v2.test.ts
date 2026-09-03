import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseAccountDevicesConfiguration,
  parseCanopyAccountConfiguration,
  parseHostedTreesConfiguration,
  parseLocalPlacements,
} from "@arbor/stores";

const profile = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const tree = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const device = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("account configuration v2", () => {
  test("accepts every shared flat-graph conformance case", async () => {
    const registry = JSON.parse(await readFile(join(import.meta.dir, "../../conformance/configuration-yaml.json"), "utf8")) as {
      valid: Array<{ configurationTree: string; files: Record<"account.yaml" | "trees.yaml" | "devices.yaml", string> }>;
    };
    for (const candidate of registry.valid) {
      const account = parseCanopyAccountConfiguration(candidate.files["account.yaml"]);
      expect(() => parseHostedTreesConfiguration(candidate.files["trees.yaml"], account), candidate.configurationTree).not.toThrow();
      expect(() => parseAccountDevicesConfiguration(candidate.files["devices.yaml"]), candidate.configurationTree).not.toThrow();
    }
  });

  test("parses the three flat authored maps and local placements", () => {
    const account = parseCanopyAccountConfiguration(`canopy: https://canopy.example\nprofile: ${profile}\n`);
    expect(account).toEqual({ canopy: "https://canopy.example", profile });
    expect(parseHostedTreesConfiguration([
      `${tree}:`,
      "  canonical: https://canopy.example/~joe/notes",
      "  access: [{ subject: { kind: everyone }, access: read }]",
    ].join("\n"), account)[tree]?.canonical).toBe("https://canopy.example/~joe/notes");
    expect(parseAccountDevicesConfiguration(`${device}:\n  label: Joe's Mac\n  administrator: true\n`)[device])
      .toEqual({ id: device, label: "Joe's Mac", administrator: true });
    expect(parseLocalPlacements(`${profile}:\n  /tmp/notes: ${tree}\n`)).toEqual([
      { configurationTree: profile, path: "/tmp/notes", tree },
    ]);
  });

  test("defaults administrator to false when another administrator remains", () => {
    const other = "dv_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(parseAccountDevicesConfiguration([
      `${device}:`, "  label: Mac", "  administrator: true",
      `${other}:`, "  label: Phone",
    ].join("\n"))[other]?.administrator).toBe(false);
  });

  test("rejects old wrappers, version keys, aliases, and foreign canonical origins", () => {
    expect(() => parseCanopyAccountConfiguration(`version: 2\ncanopy: https://canopy.example\nprofile: ${profile}\n`)).toThrow("unknown fields");
    expect(() => parseCanopyAccountConfiguration(`canopy: https://canopy.example\nhandle: joe\nprofile: ${profile}\n`)).toThrow("unknown fields");
    expect(() => parseCanopyAccountConfiguration(`community: https://canopy.example\nprofile: { tree: ${profile}, handle: joe }\nadmins: []\n`)).toThrow("unknown fields");
    expect(() => parseAccountDevicesConfiguration(`devices: &d {}\ncopy: *d\n`)).toThrow("aliases");
    const account = parseCanopyAccountConfiguration(`canopy: https://canopy.example\nprofile: ${profile}\n`);
    expect(() => parseHostedTreesConfiguration(`${tree}:\n  canonical: https://elsewhere.example/~joe/notes\n  access: []\n`, account)).toThrow("account Canopy origin");
    expect(() => parseLocalPlacements(`${profile}:\n  relative: ${tree}\n`)).toThrow("canonical and absolute");
  });
});
