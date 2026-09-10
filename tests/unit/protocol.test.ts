import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArborError,
  SyncConflictWorkspace,
  WorkspaceEvent,
} from "@arbor/core";
import { canonicalArborLocator, canonicalHTTPURL, stableJSONString, decodeNodeRef, parseSSEFrame, parseSSEStream } from "@arbor/core";
import type { AccessEntry, RemoteTreeDescriptor, TreeDescriptor } from "@arbor/core";
import { WireClient, decodeAcceptedUpdateJSON, decodeSnapshotBundle, decodeSparseSnapshotBundle, decodeUpdateRequestJSON, decodeWireObject, hashObject, updateRequestDigests } from "@arbor/wire";
import type { ArborSyncStatus, TreeBootstrap, TreeCredential } from "@arbor/arborsync-client";

// Test-local checks mirroring ArborWire's `WireTreeDescriptor.validated()` and
// `WireSafeAccessSubject` decoding; the TypeScript packages export no descriptor
// validator, so these only assert that the shared vectors are self-consistent.
const TREE_KINDS = new Set(["ordinary", "account-configuration"]);
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
    for (const url of [canonical.endpoint, canonicalHTTPURL(canonical), canonicalArborLocator(canonical)]) new URL(url);
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
  test("decode the shared status, conflict-workspace, and unknown error values", async () => {
    const status = await json<ArborSyncStatus>("status.json");
    const error = await json<ArborError>("error.json");
    const conflict = await json<SyncConflictWorkspace>("conflict-workspace.json");
    expect(error.error).toBe("future-error-code");
    expect(conflict.items[0]?.draft).toEqual({ kind: "text", text: "both\n" });
    expect(conflict.tree).toStartWith("tr_");
    expect(status).toEqual({
      service: "arborsync",
      version: "0.1.0",
      protocolVersion: "v1",
      instanceID: "instance-fixture-01",
      runtimeKind: "cloud",
      deviceID: "dv_fixturedevice23456723456723",
    });
  });

  test("decodes the bootstrap and credential fixtures", async () => {
    const clean = await json<TreeBootstrap>("bootstrap.json");
    const pending = await json<TreeBootstrap>("bootstrap-pending.json");
    const credential = await json<TreeCredential>("credential.json");
    expect(clean.tree.id).toBe("tr_notes7f3q2ab7c");
    expect(clean.accepted.cursor).toBe(clean.accepted.update);
    expect(clean.blocked).toBeUndefined();
    expect(clean.pending).toBeUndefined();
    // The spine is sparse: the root directory and its Markdown child are present, the binary is not.
    const spine = decodeSparseSnapshotBundle(Buffer.from(clean.spine, "base64"));
    const root = decodeWireObject(spine.get(clean.accepted.root as never)!);
    if (root.type !== "directory") throw new Error("Expected a directory root");
    expect(root.entries.map((entry) => entry.name)).toEqual(["_index.md", "photo.bin"]);
    expect(spine.has(root.entries[0]!.hash!)).toBe(true);
    expect(spine.has(root.entries[1]!.hash!)).toBe(false);
    expect(clean.files["/photo.bin"]).toEqual({ size: 5, mtime: 1725192000000 });
    // A pending bootstrap carries the daemon's request string verbatim with digests the client can recompute.
    const request = decodeUpdateRequestJSON({ base: pending.pending!.base, updates: pending.pending!.updates });
    expect(pending.pending!.requestDigests).toEqual(updateRequestDigests(pending.tree.id, request));
    expect(pending.pending!.updates[0]!.candidate).toBe(pending.accepted.root);
    expect(credential.token).toBe("canopy-account-token-fixture");
  });

  test("covers every current error code, cursor shape, and the control routes' fixtures", async () => {
    const errors = await json<ArborError[]>("errors.json");
    const cursors = await json<{ current: string; foreignEpoch: string; malformed: string }>("cursors.json");
    expect(errors.map((value) => value.error)).toContain("internal-error");
    expect(errors.at(-1)?.error).toBe("future-error-code");
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
    expect(event.change.origin).toBe("sync");
    expect(event.change.acceptedRequestDigests).toEqual([
      `sha256:${"a".repeat(64)}`,
    ]);
  });

  test("keeps a malformed SSE frame as a negative fixture", async () => {
    const source = await readFile(join(fixtures, "malformed-event.sse"), "utf8");
    const data = JSON.parse(source.split(/\r?\n/).find((line) => line.startsWith("data:"))!.slice(5));
    expect(data.cursor).toBeUndefined();
  });

  test("observation-events.sse frames satisfy id === cursor and event === kind", async () => {
    const source = await readFile(join(conformance, "observation-events.sse"), "utf8");
    const frames = await Array.fromAsync(parseSSEStream(new Response(source).body!));
    expect(frames.map((frame) => frame.event)).toEqual(["tree.update"]);
    for (const frame of frames) {
      const data = JSON.parse(frame.data) as { cursor: string; tree: string; kind: string; change: unknown };
      expect(frame.id).toBe(data.cursor);
      expect(frame.event).toBe(data.kind);
      expect(data.tree).toStartWith("tr_");
    }
    const ref = JSON.parse(frames[0]!.data) as { change: { descriptor: RemoteTreeDescriptor } };
    validateTreeDescriptor(ref.change.descriptor);
    expect(ref.change.descriptor.canonical?.endpoint).toBe(`https://community.example/.arbor/trees/${ref.change.descriptor.id}`);
  });

  test("observation-events-invalid.json frames are rejected by the wire watch decode path", async () => {
    const { cases } = await conformanceJSON<{ cases: Array<{ name: string; frame: string }> }>("observation-events-invalid.json");
    expect(cases.map((item) => item.name)).toEqual(["id-cursor-mismatch", "event-kind-mismatch", "unsupported-event-kind", "missing-tree"]);
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
    expect(valid.remoteTreeDescriptor.root).toStartWith("sha256:");
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
        request: { path?: string; body?: unknown; derivedRequestDigest?: string };
        response: { status: number; body?: Record<string, unknown>; bodyBase64?: string; frame?: string; headers?: Record<string, string>; contentType?: string };
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
      "flat-account-graph",
      "same-profile-second-canopy",
      "same-origin-distinct-account",
      "duplicate-key",
      "handle-in-portable-account",
      "invalid-account-retains-last-valid-account",
      "invalid-placements-retains-last-valid-local-projection",
      "unplacing-preserves",
    ]));
    expect(endpoints.cases.map((item) => item.name)).toEqual([
      "read-ref",
      "read-accepted-snapshot",
      "submit-current-update",
      "activate-with-null-base",
      "link-read",
      "watch-ref",
      "query-derived-model-state",
      "mutate-reviewed-model-intent",
    ]);
    expect(endpoints.cases.map((item) => item.response.status)).toEqual([200, 200, 200, 201, 200, 200, 200, 200]);

    // Decode each response body with the matching wire decoder where one exists.
    const byName = new Map(endpoints.cases.map((item) => [item.name, item]));
    const tree = validateTreeDescriptor(endpoints.tree);
    expect(tree.canonical?.endpoint).toBe("https://community.example/.arbor/trees/tr_atlas");
    for (const name of ["read-ref", "link-read"]) {
      const snapshot = validateTreeDescriptor(byName.get(name)!.response.body!.tree) as RemoteTreeDescriptor;
      expect(snapshot.canonical).toEqual(tree.canonical);
      expect(byName.get(name)!.response.body!.observedThrough).toBe(snapshot.update);
    }
    const snapshotCase = byName.get("read-accepted-snapshot")!;
    const snapshotBody = new Uint8Array(Buffer.from(snapshotCase.response.bodyBase64!, "base64"));
    const snapshotRoot = snapshotCase.request.path!.split("/").at(-1)!;
    expect(decodeSnapshotBundle(snapshotRoot, snapshotBody).root).toBe(snapshotRoot);
    expect(`\"${hashObject(snapshotBody)}\"`).toBe(snapshotCase.response.headers!.ETag!);
    const activate = byName.get("activate-with-null-base")!;
    const activation = decodeUpdateRequestJSON(activate.request.body);
    const activationUpdate = activation.updates[0]!;
    const activationResponse = activate.response.body as { results: Array<{ requestDigest: string; update: unknown }> };
    expect(activation.base).toBeNull();
    expect(updateRequestDigests("tr_new", activation)).toEqual([activate.request.derivedRequestDigest!]);
    expect(activationResponse.results[0]!.requestDigest).toBe(activate.request.derivedRequestDigest!);
    expect(decodeAcceptedUpdateJSON(activationResponse.results[0]!.update)).toMatchObject({ tree: "tr_new", root: activationUpdate.candidate, previousRoot: null, kind: "initial" });
    const submit = byName.get("submit-current-update")!;
    const request = decodeUpdateRequestJSON(submit.request.body);
    const submitResponse = submit.response.body as { results: Array<{ requestDigest: string; update: unknown }> };
    expect(updateRequestDigests("tr_atlas", request)).toEqual([submit.request.derivedRequestDigest!]);
    expect(submitResponse.results[0]!.requestDigest).toBe(submit.request.derivedRequestDigest!);
    const current = decodeAcceptedUpdateJSON(submitResponse.results[0]!.update);
    expect(current).toMatchObject({ id: "1", tree: "tr_atlas", kind: "initial", previousRoot: null });
    expect(current.root).toBe(request.updates[0]!.candidate);
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
    expect(intents.version).toBe(2);
    expect(intents.replayCases.map((item) => item.name)).toEqual([
      "same-intent-different-object-envelope",
      "different-candidate-has-different-digest",
    ]);
  });
});

describe("canonical descriptor helpers", () => {
  // The exact strings the retired `canonical.locator` / `canonical.httpURL`
  // fields carried when Canopy's `descriptor()` produced them.
  function canopyDescriptorStrings(origin: string, canonicalPath: string, id: string) {
    const encodedPath = canonicalPath === "/"
      ? ""
      : `/${canonicalPath.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
    const host = new URL(origin).host;
    return {
      locator: `arbor://${host}${encodedPath || "/"}`,
      endpoint: `${origin}/.arbor/trees/${encodeURIComponent(id)}`,
      httpURL: `${origin}${encodedPath || "/"}`,
    };
  }

  test("derive exactly the strings the Canopy descriptor producer emitted", () => {
    const cases = [
      ["https://community.example", "/", "tr_root"],
      ["https://community.example", "/~joe", "tr_a"],
      ["https://community.example", "/~alice/atlas", "tr_atlas"],
      ["http://127.0.0.1:8787", "/~owner/garden", "tr_garden"],
      ["https://community.example", "/~joe/my notes/ünïcode/a&b?c#d", "tr_odd"],
    ] as const;
    for (const [origin, path, id] of cases) {
      const legacy = canopyDescriptorStrings(origin, path, id);
      const canonical = { path, endpoint: legacy.endpoint, parentTree: null };
      expect(canonicalHTTPURL(canonical), path).toBe(legacy.httpURL);
      expect(canonicalArborLocator(canonical), path).toBe(legacy.locator);
    }
  });

  test("derive the strings the arborsync placement producer emitted from a bare server origin", () => {
    // tree-manager built `httpURL` as `${placement.endpoint}${path}` and stores
    // built the locator as `arbor://${new URL(endpoint).host}${path}`.
    const placement = { endpoint: "https://notes.example", canonicalPath: "/~joe/notes" };
    const canonical = { path: placement.canonicalPath, endpoint: placement.endpoint, parentTree: null };
    expect(canonicalHTTPURL(canonical)).toBe(`${placement.endpoint}${placement.canonicalPath}`);
    expect(canonicalArborLocator(canonical)).toBe(`arbor://${new URL(placement.endpoint).host}${placement.canonicalPath}`);
  });

  test("agree with the shared conformance vectors", async () => {
    const values = await conformanceJSON<{ valid: { remoteTreeDescriptor: RemoteTreeDescriptor } }>("wire-values.json");
    const canonical = values.valid.remoteTreeDescriptor.canonical!;
    expect(canonicalHTTPURL(canonical)).toBe("https://community.example/~joe");
    expect(canonicalArborLocator(canonical)).toBe("arbor://community.example/~joe");
    const bootstrap = await json<TreeBootstrap>("bootstrap.json");
    expect(canonicalHTTPURL(bootstrap.tree.canonical!)).toBe("https://notes.example/~joe/notes");
    expect(canonicalArborLocator(bootstrap.tree.canonical!)).toBe("arbor://notes.example/~joe/notes");
  });
});
