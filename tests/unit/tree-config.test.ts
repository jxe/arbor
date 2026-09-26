import { describe, expect, test } from "bun:test";
import {
  mergeTreeConfigs,
  parseTreeReference,
  readTreeConfigGraph,
  semanticTreeConfig,
  snapshotTreeConfig,
  snapshotTreeConfigFiles,
  treeConfigurationID,
  type TreeConfigFile,
  type TreeConfigKind,
  type TreeConfigValues,
} from "@overstory/protocol";
import vectors from "../../docs/overstory-spec/conformance/tree-configuration.json";

const base: Record<TreeConfigKind, Partial<Record<TreeConfigFile, string>>> = {
  tree: { "access.yaml": "- who: {profile: tr_jjjjjjjjjjjjjjjjjjjjjjjjjj}\n  allow: [admin]\n", "mounts.yaml": "{}\n" },
  group: { "access.yaml": "- who: {profile: tr_jjjjjjjjjjjjjjjjjjjjjjjjjj}\n  allow: [admin]\n", "mounts.yaml": "{}\n" },
  person: {
    "access.yaml": "- who: {profile: tr_2pnrfg7hncrmqbeojpqt7qzhcf67ofz3vlqse6aw46sr3kxlvsiq}\n  allow: [admin]\n",
    "mounts.yaml": "{}\n",
    "devices.yaml": "dv_mmmmmmmmmmmmmmmmmmmmmmmmmm:\n  label: Mac\n  administrator: true\n",
  },
};
const person = "tr_2pnrfg7hncrmqbeojpqt7qzhcf67ofz3vlqse6aw46sr3kxlvsiq";

describe("tree-configuration.json", () => {
  test("derives each configuration TreeID", () => {
    for (const vector of vectors.derivation) expect(treeConfigurationID(vector.tree)).toBe(vector.configuration);
  });

  test("parses tree references", () => {
    for (const vector of vectors.references) {
      if ("invalid" in vector) expect(() => parseTreeReference(vector.value)).toThrow();
      else expect(parseTreeReference(vector.value)).toEqual({ tree: vector.tree!, configuration: vector.configuration! });
    }
  });

  test("accepts every valid graph", () => {
    for (const vector of vectors.valid) {
      const graph = readTreeConfigGraph(snapshotTreeConfigFiles(vector.files as Record<TreeConfigFile, string>), vector.kind as TreeConfigKind, vector.tree);
      if ("values" in vector) {
        const { sources: _sources, ...values } = graph;
        expect(values as unknown).toEqual(vector.values);
      }
      // Canonical files parse back to the same values.
      const { sources: _sources, ...values } = graph;
      const { sources: _canonical, ...reread } = readTreeConfigGraph(snapshotTreeConfig(values), vector.kind as TreeConfigKind, vector.tree);
      expect(semanticTreeConfig(reread)).toEqual(semanticTreeConfig(values));
    }
  });

  test("rejects every invalid file", () => {
    for (const vector of vectors.invalid) {
      const kind = vector.kind as TreeConfigKind;
      const files = { ...base[kind], [vector.file]: vector.source } as Record<TreeConfigFile, string>;
      expect(() => readTreeConfigGraph(snapshotTreeConfigFiles(files), kind, kind === "person" ? person : undefined), vector.name).toThrow();
    }
  });

  test("merges three configurations as the vectors say", () => {
    for (const vector of vectors.merges) {
      const merged = mergeTreeConfigs(vector.base as TreeConfigValues, vector.candidate as TreeConfigValues, vector.remote as TreeConfigValues);
      expect(merged.conflicts.map(({ file, policy }) => ({ file, policy })) as unknown, vector.name).toEqual(vector.conflicts);
      if ("result" in vector) {
        const order = (values: TreeConfigValues) => ({ ...values, access: [...values.access].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1) });
        expect(order(merged.values), vector.name).toEqual(order(vector.result as TreeConfigValues));
      }
    }
  });
});
