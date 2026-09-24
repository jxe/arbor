import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { accountCheckoutPath, parseAccountDevicesConfiguration, parseAccountConfiguration, parseHostedTreesConfiguration, saveCurrentAccountDeviceID } from "@overstory/protocol";
import { clearRehomeTransaction, loadTreeRegistry, parseLocalPlacements, saveRehomeTransaction } from "@overstory/arborsync/state";

const profile = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const tree = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const device = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("account configuration v2", () => {
  test("accepts every shared flat-graph conformance case", async () => {
    const registry = JSON.parse(await readFile(join(import.meta.dir, "../../docs/overstory-spec/conformance/configuration-yaml.json"), "utf8")) as {
      valid: Array<{ configurationTree: string; files: Record<"account.yaml" | "trees.yaml" | "devices.yaml", string> }>;
      invalid: Array<{ name: string; path: string; source: string }>;
    };
    for (const candidate of registry.valid) {
      const account = parseAccountConfiguration(candidate.files["account.yaml"]);
      expect(() => parseHostedTreesConfiguration(candidate.files["trees.yaml"], account), candidate.configurationTree).not.toThrow();
      expect(() => parseAccountDevicesConfiguration(candidate.files["devices.yaml"]), candidate.configurationTree).not.toThrow();
    }
    const account = parseAccountConfiguration(registry.valid[0]!.files["account.yaml"]);
    for (const candidate of registry.invalid.filter(item => item.path === "trees.yaml")) {
      expect(() => parseHostedTreesConfiguration(candidate.source, account), candidate.name).toThrow();
    }
  });

  test("parses the three flat authored maps and local placements", () => {
    const account = parseAccountConfiguration(`canopy: https://canopy.example\nprofile: ${profile}\n`);
    expect(account).toEqual({ canopy: "https://canopy.example", profile });
    expect(parseHostedTreesConfiguration([
      `${tree}:`,
      "  canonical: https://canopy.example/~joe/notes",
      "  access: [{ who: everyone, allow: [read] }]",
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
    expect(() => parseAccountConfiguration(`version: 2\ncanopy: https://canopy.example\nprofile: ${profile}\n`)).toThrow("unknown fields");
    expect(() => parseAccountConfiguration(`canopy: https://canopy.example\nhandle: joe\nprofile: ${profile}\n`)).toThrow("unknown fields");
    expect(() => parseAccountConfiguration(`community: https://canopy.example\nprofile: { tree: ${profile}, handle: joe }\nadmins: []\n`)).toThrow("unknown fields");
    expect(() => parseAccountDevicesConfiguration(`devices: &d {}\ncopy: *d\n`)).toThrow("aliases");
    const account = parseAccountConfiguration(`canopy: https://canopy.example\nprofile: ${profile}\n`);
    expect(() => parseHostedTreesConfiguration(`${tree}:\n  canonical: https://elsewhere.example/~joe/notes\n  access: []\n`, account)).toThrow("account Canopy origin");
    expect(() => parseLocalPlacements(`${profile}:\n  relative: ${tree}\n`)).toThrow("canonical and absolute");
    expect(() => parseLocalPlacements([
      `${profile}:`,
      `  /tmp/one: ${tree}`,
      `${tree}:`,
      `  /tmp/two: ${tree}`,
    ].join("\n"))).toThrow("Tree appears in several placements");
  });

  test("allows duplicate account declarations only during an explicit rehome transaction", async () => {
    const prior = process.env.ARBOR_DATA_HOME;
    const home = await mkdtemp(join(tmpdir(), "arbor-rehome-config-"));
    const sourceAccount = "tr_cccccccccccccccccccccccccc";
    const destinationAccount = "tr_dddddddddddddddddddddddddd";
    try {
      process.env.ARBOR_DATA_HOME = home;
      await writeFile(join(home, "placements.yaml"), "{}\n");
      for (const [configuration, canopy] of [
        [sourceAccount, "https://source.example"],
        [destinationAccount, "https://destination.example"],
      ] as const) {
        const path = accountCheckoutPath(configuration);
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "account.yaml"), `canopy: ${canopy}\nprofile: ${profile}\n`);
        await writeFile(join(path, "trees.yaml"), `${tree}:\n  canonical: ${canopy}/~joe/notes\n  access: []\n`);
        await writeFile(join(path, "devices.yaml"), `${device}:\n  label: Test device\n  administrator: true\n`);
        await saveCurrentAccountDeviceID(configuration, device);
      }
      const invalid = await loadTreeRegistry();
      expect(invalid.placementsValid).toBe(false);
      expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toContain("multiply-declared-tree");

      await saveRehomeTransaction({
        version: 1,
        tree,
        sourceConfigurationTree: sourceAccount,
        destinationConfigurationTree: destinationAccount,
        sourceCanonical: "https://source.example/~joe/notes",
        destinationCanonical: "https://destination.example/~joe/wrong",
      });
      const mismatched = await loadTreeRegistry();
      expect(mismatched.placementsValid).toBe(false);
      expect(mismatched.diagnostics.map((diagnostic) => diagnostic.code)).toContain("multiply-declared-tree");

      await saveRehomeTransaction({
        version: 1,
        tree,
        sourceConfigurationTree: sourceAccount,
        destinationConfigurationTree: destinationAccount,
        sourceCanonical: "https://source.example/~joe/notes",
        destinationCanonical: "https://destination.example/~joe/notes",
      });
      const migrating = await loadTreeRegistry();
      expect(migrating.placementsValid).toBe(true);
      expect(migrating.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("multiply-declared-tree");
      await clearRehomeTransaction(tree);
    } finally {
      if (prior === undefined) delete process.env.ARBOR_DATA_HOME;
      else process.env.ARBOR_DATA_HOME = prior;
      await rm(home, { recursive: true, force: true });
    }
  });
});
