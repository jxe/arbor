import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArborError,
  BacklinksPage,
  MutationReceipt,
  MutationRequest,
  NodeSnapshot,
  RecoveryPage,
  WorkspaceEvent,
  WorkspaceOperation,
} from "@arbor/core";
import { stableJSONString, decodeNodeRef, parseSSEFrame, parseSSEStream } from "@arbor/core";
import type { AccessEntry, NodeResponse, RemoteTreeDescriptor, TreeDescriptor } from "@arbor/core";
import { WireClient, decodeAcceptedUpdateJSON, decodeUpdateRequestJSON, updateRequestDigest } from "@arbor/wire";
import { nodeDocument } from "../helpers/node-snapshot.ts";

// Test-local checks mirroring ArborWire's `WireTreeDescriptor.validated()` and
// `WireSafeAccessSubject` decoding; the TypeScript packages export no descriptor
// validator, so these only assert that the shared vectors are self-consistent.
const TREE_KINDS = new Set(["community-profile", "person-profile", "group-profile", "shared-subtree", "account-configuration"]);
const ACCESS_LEVELS = new Set(["none", "read", "write"]);
function validateTreeDescriptor(value: unknown): TreeDescriptor {
  const descriptor = value as Partial<TreeDescriptor>;
  if (typeof descriptor.id !== "string" || !descriptor.id.startsWith("tr_")) throw new TypeError("descriptor.id must be a TreeID");
  if (!TREE_KINDS.has(descriptor.kind as string)) throw new TypeError("unknown tree kind");
  if (!ACCESS_LEVELS.has(descriptor.access as string)) throw new TypeError("unknown access level");
  if (descriptor.kind === "account-configuration") {
    if (descriptor.canonical !== null) throw new TypeError("account configuration must be noncanonical");
  } else {
    const canonical = descriptor.canonical;
    if (!canonical || !canonical.path.startsWith("/")) throw new TypeError("ordinary trees need canonical data");
    for (const url of [canonical.locator, canonical.endpoint, canonical.httpURL]) new URL(url);
    if (canonical.parentTree !== null && typeof canonical.parentTree !== "string") throw new TypeError("parentTree must be a TreeID or null");
  }
  return descriptor as TreeDescriptor;
}
function validateAccessEntry(value: unknown): AccessEntry {
  const entry = value as Partial<AccessEntry>;
  if (typeof entry.id !== "string" || (entry.access !== "read" && entry.access !== "write")) throw new TypeError("malformed access entry");
  const subject = entry.subject as Record<string, unknown> | undefined;
  if (!subject) throw new TypeError("access entry needs a subject");
  if (subject.kind === "everyone") return entry as AccessEntry;
  if (subject.kind === "profile" && typeof subject.tree === "string") return entry as AccessEntry;
  if (subject.kind === "link" && Object.keys(subject).length === 1) return entry as AccessEntry;
  throw new TypeError("unsafe or unknown access subject");
}
function decodeWireValue(value: unknown): unknown {
  const record = value as Record<string, unknown>;
  if ("subject" in record) return validateAccessEntry(record);
  if ("ref" in record) {
    if (!record.enclosingTree) throw new TypeError("resolution requires enclosingTree");
    return { ref: decodeNodeRef(record.ref), enclosingTree: validateTreeDescriptor(record.enclosingTree) };
  }
  return validateTreeDescriptor(record);
}

const fixtures = join(import.meta.dir, "../fixtures/arborsync");
const conformance = join(import.meta.dir, "../../conformance");
const canopyFixtures = join(import.meta.dir, "../fixtures/canopy");
const json = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(join(fixtures, name), "utf8")) as T;
const conformanceJSON = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(join(conformance, name), "utf8")) as T;

describe("REST v1 protocol fixtures", () => {
  test("decode the shared node, mutation, receipt, and unknown error values", async () => {
    const node = await json<NodeResponse>("node.json");
    const mutation = await json<MutationRequest>("mutation.json");
    const receipt = await json<MutationReceipt>("receipt.json");
    const error = await json<ArborError>("error.json");
    expect(node.ref).toEqual({ tree: "tr_notes7f3q2ab7c", path: "/notes/today", stableKey: '[["id","abc123"]]' });
    expect(node.ref.tree).toBe("tr_notes7f3q2ab7c");
    expect(node.enclosingTree?.osPath).toBe("/Users/joe/notes");
    expect(mutation.operations[0]?.op).toBe("move");
    expect(receipt.effects[0]?.previousPath).toBe("/notes/today");
    expect(receipt.effects[0]?.ref.tree).toBe("tr_notes7f3q2ab7c");
    expect(receipt.effects[0]?.propertiesRevision).toBe("sha256:properties");
    expect(error.error).toBe("future-error-code");
  });

  test("decodes the tree-scoped, unpromoted, and system fixtures", async () => {
    const untracked = await json<NodeResponse>("node-untracked.json");
    const systemTree = await json<NodeResponse>("node-system-tree.json");
    const backlinks = await json<BacklinksPage>("backlinks.json");
    const recovery = await json<RecoveryPage>("recovery.json");
    expect(untracked.ref.tree).toBe("local");
    expect(untracked.ref.path).toBe("/Users/joe/Desktop/stray");
    expect(untracked.enclosingTree).toBeUndefined();
    expect(systemTree.ref.tree).toBe("system");
    expect(systemTree.capabilities.content?.writable).toBe(false);
    expect(nodeDocument(systemTree)?.frontmatter.credentialAvailable).toBe(true);
    expect(backlinks.entries[0]?.ref.stableKey).toBe('[["id","week01"]]');
    expect(recovery.entries.map((entry) => entry.kind)).toEqual(["block", "trash"]);
  });

  test("keeps unknown fields decodable while requiring explicit tree scope", async () => {
    const node = await json<NodeResponse>("node-unknown-field.json");
    expect(node.ref.tree).toBe("tr_notes7f3q2ab7c");
    expect(node.ref.tree).toBe("tr_notes7f3q2ab7c");
  });

  test("covers every operation, current error code, cursor, and unknown response field", async () => {
    const operationRequests = await json<MutationRequest[]>("operations.json");
    const errors = await json<ArborError[]>("errors.json");
    const node = await json<NodeSnapshot>("node-unknown-field.json");
    const cursors = await json<{ current: string; foreignEpoch: string; malformed: string }>("cursors.json");
    expect(operationRequests
      .flatMap((request) => [...request.operations] as WorkspaceOperation[])
      .map((operation) => operation.op)).toEqual([
      "writeMarkdown",
      "writeProperties",
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
    expect(stableJSONString({ b: 2, a: { y: 2, x: 1 } }))
      .toBe(stableJSONString({ a: { x: 1, y: 2 }, b: 2 }));
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

  test("observation-events.sse frames satisfy id === cursor and event === kind", async () => {
    const source = await readFile(join(conformance, "observation-events.sse"), "utf8");
    const frames = await Array.fromAsync(parseSSEStream(new Response(source).body!));
    expect(frames.map((frame) => frame.event)).toEqual(["tree.ref", "tree.activation"]);
    for (const frame of frames) {
      const data = JSON.parse(frame.data) as { cursor: string; tree: string; kind: string; change: unknown };
      expect(frame.id).toBe(data.cursor);
      expect(frame.event).toBe(data.kind);
      expect(data.tree).toStartWith("tr_");
    }
    const ref = JSON.parse(frames[0]!.data) as { change: { descriptor: RemoteTreeDescriptor } };
    validateTreeDescriptor(ref.change.descriptor);
    expect(ref.change.descriptor.canonical?.endpoint).toBe(`https://community.example/.arbor/trees/${ref.change.descriptor.id}`);
    const activation = JSON.parse(frames[1]!.data) as { tree: string; change: unknown };
    expect(activation.tree).toBe("tr_cccccccccccccccccccccccccc");
    expect(activation.change).toEqual({ tree: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", status: "active" });
  });

  test("observation-events-invalid.json frames are rejected by the wire watch decode path", async () => {
    const { cases } = await conformanceJSON<{ cases: Array<{ name: string; frame: string }> }>("observation-events-invalid.json");
    expect(cases.map((item) => item.name)).toEqual(["id-cursor-mismatch", "event-kind-mismatch", "missing-tree"]);
    const originalFetch = globalThis.fetch;
    try {
      for (const item of cases) {
        globalThis.fetch = (async () => new Response(item.frame, {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        })) as unknown as typeof fetch;
        const client = new WireClient("https://community.example");
        await expect(Array.fromAsync(client.watch("tr_a", null))).rejects.toThrow("Malformed Arbor watch event");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("wire-values.json values decode and every invalid value is rejected", async () => {
    const values = await conformanceJSON<{
      valid: {
        treeDescriptor: TreeDescriptor;
        accountConfigurationDescriptor: TreeDescriptor;
        remoteTreeDescriptor: RemoteTreeDescriptor;
        accessEntries: AccessEntry[];
        error: ArborError;
        resolution: { ref: unknown; enclosingTree: TreeDescriptor; historical: boolean; observedThrough: string };
      };
      invalid: Array<{ name: string; value: unknown }>;
    }>("wire-values.json");
    const { valid } = values;
    for (const descriptor of [valid.treeDescriptor, valid.remoteTreeDescriptor, valid.resolution.enclosingTree]) {
      validateTreeDescriptor(descriptor);
      expect(descriptor.canonical?.endpoint).toBe(`https://community.example/.arbor/trees/${descriptor.id}`);
    }
    expect(validateTreeDescriptor(valid.accountConfigurationDescriptor).canonical).toBeNull();
    expect(valid.remoteTreeDescriptor.ref).toStartWith("sha256:");
    expect(valid.accessEntries.map((entry) => validateAccessEntry(entry).subject.kind)).toEqual(["everyone", "profile", "link"]);
    expect(decodeNodeRef(valid.resolution.ref)).toEqual({ tree: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", path: "/notes", stableKey: '[["id","page-1"]]' });
    expect(valid.error.tree).not.toBe("local");
    expect(values.invalid.map((item) => item.name)).toEqual([
      "descriptor-for-local",
      "ordinary-tree-without-canonical",
      "link-entry-leaks-digest",
      "resolution-omits-tree",
    ]);
    for (const item of values.invalid) {
      expect(() => decodeWireValue(item.value), item.name).toThrow();
    }
  });

  test("publishes configuration and wire conformance vectors separately from reference merge cases", async () => {
    const registry = await conformanceJSON<{ valid: Array<{ name: string }>; invalid: Array<{ name: string }>; behavior: Array<{ name: string }> }>("configuration-yaml.json");
    const endpoints = await conformanceJSON<{
      tree: RemoteTreeDescriptor;
      cases: Array<{
        name: string;
        request: { body?: unknown; derivedRequestDigest?: string };
        response: { status: number; body?: Record<string, unknown>; frame?: string };
      }>;
    }>("wire-endpoints.json");
    const wireErrors = await conformanceJSON<ArborError[]>("errors.json");
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

    // Decode each response body with the matching wire decoder where one exists.
    const byName = new Map(endpoints.cases.map((item) => [item.name, item]));
    const tree = validateTreeDescriptor(endpoints.tree);
    expect(tree.canonical?.endpoint).toBe("https://community.example/.arbor/trees/tr_atlas");
    for (const name of ["read-ref", "link-read"]) {
      const snapshot = validateTreeDescriptor(byName.get(name)!.response.body!.snapshot) as RemoteTreeDescriptor;
      expect(snapshot.canonical).toEqual(tree.canonical);
      expect(byName.get(name)!.response.body!.observedThrough).toBe(snapshot.update);
    }
    const submit = byName.get("submit-current-update")!;
    const request = decodeUpdateRequestJSON(submit.request.body);
    expect(updateRequestDigest("tr_atlas", request)).toBe(submit.request.derivedRequestDigest!);
    expect(submit.response.body!.requestDigest).toBe(submit.request.derivedRequestDigest);
    const current = decodeAcceptedUpdateJSON(submit.response.body!.current);
    expect(current).toMatchObject({ id: "up_atlas1", tree: "tr_atlas", sequence: 1, kind: "initial", previousRoot: null });
    expect(current.root).toBe(request.candidate);
    const watch = parseSSEFrame(byName.get("watch-ref")!.response.frame!.trim())!;
    const watched = JSON.parse(watch.data) as { cursor: string; tree: string; kind: string; change: { descriptor: unknown } };
    expect(watch.id).toBe(watched.cursor);
    expect(watch.event).toBe(watched.kind);
    expect(watched.tree).toBe("tr_atlas");
    expect(validateTreeDescriptor(watched.change.descriptor).canonical).toEqual(tree.canonical);
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
