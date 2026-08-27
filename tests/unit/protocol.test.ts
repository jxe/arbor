import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArborSyncErrorEnvelope,
  BacklinksPage,
  MutationReceipt,
  MutationRequest,
  NodeSnapshot,
  RecoveryPage,
  WorkspaceEvent,
  WorkspaceOperation,
} from "@arbor/core";
import { canonicalJSONString } from "@arbor/core";

const fixtures = join(import.meta.dir, "../fixtures/arborsync");
const conformance = join(import.meta.dir, "../../conformance");
const canopyFixtures = join(import.meta.dir, "../fixtures/canopy");
const json = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(join(fixtures, name), "utf8")) as T;
const conformanceJSON = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(join(conformance, name), "utf8")) as T;

describe("REST v1 protocol fixtures", () => {
  test("decode the shared node, mutation, receipt, and unknown error values", async () => {
    const node = await json<NodeSnapshot>("node.json");
    const mutation = await json<MutationRequest>("mutation.json");
    const receipt = await json<MutationReceipt>("receipt.json");
    const error = await json<ArborSyncErrorEnvelope>("error.json");
    expect(node.ref).toEqual({ tree: "tr_notes7f3q2ab7c", path: "/notes/today", stableKey: '[["id","abc123"]]' });
    expect(node.tree).toBe("tr_notes7f3q2ab7c");
    expect(node.enclosingTree?.osPath).toBe("/Users/joe/notes");
    expect(mutation.operations[0]?.op).toBe("move");
    expect(receipt.effects[0]?.previousPath).toBe("/notes/today");
    expect(receipt.effects[0]?.tree).toBe("tr_notes7f3q2ab7c");
    expect(error.error).toBe("future-error-code");
  });

  test("decodes the tree-scoped, unpromoted, and system fixtures", async () => {
    const untracked = await json<NodeSnapshot>("node-untracked.json");
    const systemTree = await json<NodeSnapshot>("node-system-tree.json");
    const backlinks = await json<BacklinksPage>("backlinks.json");
    const recovery = await json<RecoveryPage>("recovery.json");
    expect(untracked.tree).toBe("local");
    expect(untracked.path).toBe("/Users/joe/Desktop/stray");
    expect(untracked.enclosingTree).toBeUndefined();
    expect(systemTree.tree).toBe("system");
    expect(systemTree.writable).toBe(false);
    expect(systemTree.document?.frontmatter.credentialAvailable).toBe(true);
    expect(backlinks.entries[0]?.ref.stableKey).toBe('[["id","week01"]]');
    expect(recovery.entries.map((entry) => entry.kind)).toEqual(["block", "trash"]);
  });

  test("keeps unknown fields decodable while requiring explicit tree scope", async () => {
    const node = await json<NodeSnapshot>("node-unknown-field.json");
    expect(node.tree).toBe("tr_notes7f3q2ab7c");
    expect(node.ref.tree).toBe("tr_notes7f3q2ab7c");
  });

  test("covers every operation, current error code, cursor, and unknown response field", async () => {
    const operationRequests = await json<MutationRequest[]>("operations.json");
    const errors = await json<ArborSyncErrorEnvelope[]>("errors.json");
    const node = await json<NodeSnapshot>("node-unknown-field.json");
    const cursors = await json<{ current: string; foreignEpoch: string; malformed: string }>("cursors.json");
    expect(operationRequests
      .flatMap((request) => [...request.operations] as WorkspaceOperation[])
      .map((operation) => operation.op)).toEqual([
      "writeMarkdown",
      "writeText",
      "createMarkdown",
      "createDirectory",
      "rename",
      "move",
      "copy",
      "trash",
      "restore",
      "restoreRecovery",
      "ensureDocumentIdentity",
    ]);
    expect(errors.map((value) => value.error)).toContain("internal-error");
    expect(errors.at(-1)?.error).toBe("future-error-code");
    expect(node.ref.stableKey).toBe('[["id","abc123"]]');
    expect(cursors.current).toEndWith(":5");
    expect(cursors.foreignEpoch).not.toStartWith("11111111");
    expect(cursors.malformed).not.toContain(":");
  });

  test("canonical request encoding ignores object-key order", () => {
    expect(canonicalJSONString({ b: 2, a: { y: 2, x: 1 } }))
      .toBe(canonicalJSONString({ a: { x: 1, y: 2 }, b: 2 }));
  });

  test("decodes the shared SSE data frame", async () => {
    const source = await readFile(join(fixtures, "events.sse"), "utf8");
    const data = source.split(/\r?\n/).find((line) => line.startsWith("data:"))!.slice(5).trim();
    const event = JSON.parse(data) as WorkspaceEvent;
    expect(event.cursor).toEndWith(":5");
    expect(event.change.origin).toBe("api");
  });

  test("keeps a malformed SSE frame as a negative fixture", async () => {
    const source = await readFile(join(fixtures, "malformed-event.sse"), "utf8");
    const data = JSON.parse(source.split(/\r?\n/).find((line) => line.startsWith("data:"))!.slice(5));
    expect(data.cursor).toBeUndefined();
  });

  test("publishes configuration and wire conformance vectors separately from reference merge cases", async () => {
    const registry = await conformanceJSON<{ valid: Array<{ name: string }>; invalid: Array<{ name: string }>; behavior: Array<{ name: string }> }>("configuration-yaml.json");
    const endpoints = await conformanceJSON<{ cases: Array<{ name: string; response: { status: number } }> }>("wire-endpoints.json");
    const wireErrors = await conformanceJSON<ArborSyncErrorEnvelope[]>("errors.json");
    const merges = JSON.parse(await readFile(join(canopyFixtures, "wire-merge.json"), "utf8")) as {
      version: number;
      markdownCases: Array<{ name: string }>;
      pageMoveCases: Array<{ name: string }>;
      structuralCases: Array<{ name: string }>;
    };
    const intents = await conformanceJSON<{ version: number; replayCases: Array<{ name: string }> }>("wire-update-intent.json");
    expect([...registry.valid, ...registry.invalid, ...registry.behavior].map((item) => item.name)).toEqual(expect.arrayContaining([
      "filesystem-placement",
      "pathless-replica-and-link-rule",
      "duplicate-key",
      "unknown-field",
      "invalid-edit-retains-last-valid",
      "removing-placement-preserves",
    ]));
    expect(endpoints.cases.map((item) => item.name)).toEqual([
      "read-ref",
      "submit-current-update",
      "link-read",
      "watch-ref",
      "query-derived-model-state",
      "mutate-reviewed-model-intent",
    ]);
    expect(endpoints.cases.map((item) => item.response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(wireErrors.every((item) => item.tree !== "local" && item.tree !== "system")).toBe(true);
    expect(merges.version).toBe(2);
    expect(merges.markdownCases.length).toBeGreaterThanOrEqual(10);
    expect(merges.pageMoveCases.map((item) => item.name)).toContain("divergent-page-id-renames-conflict");
    expect(merges.structuralCases.map((item) => item.name)).toEqual(expect.arrayContaining([
      "divergent-binary-file",
      "divergent-nested-boundary",
      "file-directory-kind-collision",
    ]));
    expect(intents.version).toBe(1);
    expect(intents.replayCases.map((item) => item.name)).toEqual([
      "same-intent-different-object-envelope",
      "different-candidate-has-different-digest",
    ]);
  });
});
