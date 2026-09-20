import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateArborID, WireClient, hashObject } from "@overstory/protocol";
import { snapshotDirectory } from "@overstory/fs";
import { FilesystemObjectSource } from "../../packages/arborsync/src/filesystem-object-source.ts";
import { TreeObjectCache } from "../../packages/arborsync/src/object-cache.ts";
import { objectReadError, type ObjectReadDiagnostic } from "../../packages/arborsync/src/object-read-diagnostics.ts";

const scope = { boundaries: new Map<string, string>(), exclusions: [] };

test("filesystem diagnostics distinguish missing files, changed bytes and failed reads", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "arbor-read-evidence-")));
  try {
    const root = join(base, "files");
    await mkdir(root);
    const path = join(root, "file.txt");
    await writeFile(path, "original");
    const diagnostics: ObjectReadDiagnostic[] = [];
    await using source = new FilesystemObjectSource(root, join(base, "index.sqlite"), {
      exclusions: () => [], changed: () => {}, revalidationMs: 0, report: (value) => diagnostics.push(value),
    });
    const original = hashObject(new TextEncoder().encode("original"));
    await snapshotDirectory(root, scope.boundaries, [], undefined, source.index());
    await writeFile(path, "changed");
    expect(await source.bytes(original, scope)).toBeUndefined();
    expect(diagnostics).toContainEqual({ source: "filesystem", reason: "hash-mismatch", hash: original, path });
    await snapshotDirectory(root, scope.boundaries, [], undefined, source.index());
    const changed = hashObject(new TextEncoder().encode("changed"));
    await rm(path);
    diagnostics.length = 0;
    expect(await source.bytes(changed, scope)).toBeUndefined();
    expect(diagnostics).toContainEqual({ source: "filesystem", reason: "missing", hash: changed, path, code: "ENOENT" });
    // A directory taking the file's place forces a deterministic read error.
    await writeFile(path, "changed");
    await snapshotDirectory(root, scope.boundaries, [], undefined, source.index());
    await rm(path);
    await mkdir(path);
    diagnostics.length = 0;
    expect(await source.bytes(changed, scope)).toBeUndefined();
    expect(diagnostics).toContainEqual({ source: "filesystem", reason: "io-error", hash: changed, path, code: "EISDIR" });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("permission diagnostics exclude arbitrary exception text and secrets", () => {
  const error = Object.assign(new Error("Authorization: Bearer private-token; private response body"), { code: "EACCES" });
  const diagnostic = objectReadError({ source: "filesystem", path: "/file" }, error);
  expect(diagnostic).toEqual({ source: "filesystem", path: "/file", reason: "permission-denied", code: "EACCES" });
  expect(JSON.stringify(diagnostic)).not.toContain("private-token");
});

test("object fallback survives a local failure and distinguishes remote missing, denied and corrupt bytes", async () => {
  const state = await mkdtemp(join(tmpdir(), "arbor-read-fallback-"));
  const previous = process.env.ARBOR_DATA_HOME;
  process.env.ARBOR_DATA_HOME = state;
  const bytes = new TextEncoder().encode("verified fallback");
  const hash = hashObject(bytes);
  const tree = generateArborID("tr");
  let status = 200;
  let corrupt = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    status === 200 ? (corrupt ? "wrong bytes" : bytes) : "private server response",
    { status },
  ) });
  try {
    const diagnostics: ObjectReadDiagnostic[] = [];
    const cache = new TreeObjectCache({
      workspaceFor: async () => { throw Object.assign(new Error("private local failure"), { code: "EACCES" }); },
      boundariesFor: () => scope.boundaries,
      exclusionsFor: () => [],
      clientFor: async () => new WireClient(server.url.origin),
      maxFetchedBytes: 0,
      report: (value) => diagnostics.push(value),
    });
    expect(await cache.bytes(tree, hash)).toEqual(bytes);
    expect(diagnostics).toContainEqual({ source: "workspace", reason: "permission-denied", tree, hash, code: "EACCES" });
    for (const [responseStatus, reason] of [[404, "missing"], [403, "permission-denied"], [503, "http-error"]] as const) {
      status = responseStatus;
      diagnostics.length = 0;
      expect(await cache.bytes(tree, hash)).toBeUndefined();
      expect(diagnostics).toContainEqual({ source: "canopy", reason, tree, hash, status });
      expect(JSON.stringify(diagnostics)).not.toContain("private");
    }
    status = 200;
    corrupt = true;
    diagnostics.length = 0;
    expect(await cache.bytes(tree, hash)).toBeUndefined();
    expect(diagnostics).toContainEqual({ source: "canopy", reason: "hash-mismatch", tree, hash });
  } finally {
    server.stop(true);
    if (previous === undefined) delete process.env.ARBOR_DATA_HOME;
    else process.env.ARBOR_DATA_HOME = previous;
    await rm(state, { recursive: true, force: true });
  }
});
