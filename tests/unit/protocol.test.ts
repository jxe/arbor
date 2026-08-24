import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArbordErrorEnvelope,
  BacklinksPage,
  MutationReceipt,
  MutationRequest,
  NodeSnapshot,
  RecoveryPage,
  WorkspaceEvent,
  WorkspaceOperation,
} from "@arbor/core";
import { canonicalJSONString } from "@arbor/core";

const fixtures = join(import.meta.dir, "../../spec/fixtures");
const json = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(join(fixtures, name), "utf8")) as T;

describe("REST v1 protocol fixtures", () => {
  test("decode the shared node, mutation, receipt, and unknown error values", async () => {
    const node = await json<NodeSnapshot>("node.json");
    const mutation = await json<MutationRequest>("mutation.json");
    const receipt = await json<MutationReceipt>("receipt.json");
    const error = await json<ArbordErrorEnvelope>("error.json");
    expect(node.ref).toEqual({ tree: "tr_notes7f3q2ab7c", path: "/notes/today", pageID: "abc123" });
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
    expect(systemTree.document?.frontmatter.placement).toBe("shared");
    expect(backlinks.entries[0]?.ref.pageID).toBe("week01");
    expect(recovery.entries.map((entry) => entry.kind)).toEqual(["block", "trash"]);
  });

  test("keeps a legacy no-tree payload decodable (omitted scope = session root)", async () => {
    const node = await json<NodeSnapshot>("node-unknown-field.json");
    expect(node.tree).toBeUndefined();
    expect(node.ref.tree).toBeUndefined();
  });

  test("covers every operation, current error code, cursor, and unknown response field", async () => {
    const operationRequests = await json<MutationRequest[]>("operations.json");
    const errors = await json<ArbordErrorEnvelope[]>("errors.json");
    const node = await json<NodeSnapshot>("node-unknown-field.json");
    const cursors = await json<{ current: string; foreignEpoch: string; malformed: string }>("cursors.json");
    expect(operationRequests
      .flatMap((request) => [...request.operations] as WorkspaceOperation[])
      .map((operation) => operation.op)).toEqual([
      "writeMarkdown",
      "createMarkdown",
      "createDirectory",
      "rename",
      "move",
      "move",
      "copy",
      "trash",
      "restore",
      "restoreRecovery",
      "ensureDocumentIdentity",
      "connectCommunity",
      "promoteTree",
      "placeTree",
      "setTreeAccess",
      "claimProfile",
      "disconnectCommunity",
      "createGroupProfile",
      "removeTreePlacement",
      "resolveTreeConflict",
    ]);
    expect(errors.map((value) => value.error)).toContain("internal-error");
    expect(errors.at(-1)?.error).toBe("future-error-code");
    expect(node.ref.pageID).toBe("abc123");
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
    expect(event.origin).toBe("api");
  });

  test("keeps a malformed SSE frame as a negative fixture", async () => {
    const source = await readFile(join(fixtures, "malformed-event.sse"), "utf8");
    const data = JSON.parse(source.split(/\r?\n/).find((line) => line.startsWith("data:"))!.slice(5));
    expect(data.cursor).toBeUndefined();
  });

  test("publishes registry and wire endpoint conformance vectors", async () => {
    const registry = await json<{ cases: Array<{ name: string }> }>("trees-yaml.json");
    const endpoints = await json<{ cases: Array<{ name: string; response: { status: number } }> }>("wire-endpoints.json");
    const merges = await json<{
      version: number;
      markdownCases: Array<{ name: string }>;
      pageMoveCases: Array<{ name: string }>;
      structuralCases: Array<{ name: string }>;
      replayCases: Array<{ name: string }>;
    }>("wire-merge.json");
    expect(registry.cases.map((item) => item.name)).toEqual(expect.arrayContaining([
      "valid-empty",
      "valid-shared",
      "comments-and-order-survive-edit",
      "duplicate-key",
      "unknown-field",
      "source-tree-mismatch",
      "noncanonical-path",
      "malformed-replacement-retains-active",
      "nested-placement-excluded-from-parent",
      "remove-placement-preserves-data",
    ]));
    expect(endpoints.cases.map((item) => item.name)).toEqual([
      "read-ref",
      "submit-current-update",
      "link-read",
      "watch-ref",
    ]);
    expect(endpoints.cases.map((item) => item.response.status)).toEqual([200, 200, 200, 200]);
    expect(merges.version).toBe(1);
    expect(merges.markdownCases.length).toBeGreaterThanOrEqual(10);
    expect(merges.pageMoveCases.map((item) => item.name)).toContain("divergent-page-id-renames-conflict");
    expect(merges.structuralCases.map((item) => item.name)).toEqual(expect.arrayContaining([
      "divergent-binary-file",
      "divergent-nested-boundary",
      "file-directory-kind-collision",
    ]));
    expect(merges.replayCases.map((item) => item.name)).toEqual([
      "exact-success-replay",
      "changed-intent-reuses-key",
    ]);
  });
});
