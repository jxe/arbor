import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArbordErrorEnvelope,
  MutationReceipt,
  MutationRequest,
  NodeSnapshot,
  WorkspaceEvent,
  WorkspaceOperation,
} from "@arbor/core";
import { canonicalJSONString } from "@arbor/core";

const fixtures = join(import.meta.dir, "../fixtures/protocol");
const json = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(join(fixtures, name), "utf8")) as T;

describe("REST v1 protocol fixtures", () => {
  test("decode the shared node, mutation, receipt, and unknown error values", async () => {
    const node = await json<NodeSnapshot>("node.json");
    const mutation = await json<MutationRequest>("mutation.json");
    const receipt = await json<MutationReceipt>("receipt.json");
    const error = await json<ArbordErrorEnvelope>("error.json");
    expect(node.ref).toEqual({ path: "/notes/today", pageID: "abc123" });
    expect(mutation.operations[0]?.op).toBe("move");
    expect(receipt.effects[0]?.previousPath).toBe("/notes/today");
    expect(error.error.code).toBe("future-error-code");
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
    ]);
    expect(errors.map((value) => value.error.code)).toContain("internal-error");
    expect(errors.at(-1)?.error.code).toBe("future-error-code");
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
});
