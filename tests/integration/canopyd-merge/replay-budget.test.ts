import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { serveHost } from "@overstory/canopyd";
import { stableJSONString, ProtocolClient, ProtocolHTTPError, decodeProtocolDirectory, encodeProtocolDirectory, hashObject, type CandidateUpdate, type ObjectHash } from "@overstory/protocol";
import { EvaluationFailure } from "../../../packages/canopyd-merge/src/engine-contract.ts";
import { executeExactSourceEdits } from "../../support/source-edits.ts";
import { acceptedEntries } from "../../support/log-entries.ts";
import { recordedQuestion, sidecar } from "../../support/replay-check.ts";

/** A cold rebuild longer than the sidecar's replay budget answers retryably
 * and keeps what it rebuilt, so retries finish it: a long chain after a
 * restart costs retries, never a stuck tree. */
let dir: string, running: Awaited<ReturnType<typeof serveHost>>, client: ProtocolClient, tree: string;
const objects = new Map<string, Uint8Array>();
const start = async () => {
  running = await serveHost({ dataRoot: dir, publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    accounts: [{ handle: "owner", token: "owner-token", communityWriter: true }] });
  client = new ProtocolClient(running.url, "owner-token");
};
const stop = async () => { running.server.stop(true); await running.canopy[Symbol.asyncDispose](); };
beforeAll(async () => { dir = await mkdtemp(`${tmpdir()}/arbor-replay-budget-`); await start(); tree = (await client.account()).account.community.id; });
afterAll(async () => { delete process.env.ARBOR_MERGE_REPLAY_MS; await stop(); await rm(dir, { recursive: true, force: true }); });

function snapshot(basis: string, files: Record<string, string>): CandidateUpdate {
  const directory = decodeProtocolDirectory(objects.get(basis)!);
  for (const [name, text] of Object.entries(files)) {
    const bytes = new TextEncoder().encode(text), file = hashObject(bytes); objects.set(file, bytes);
    directory.entries = [...directory.entries.filter((e) => e.name !== name), { name, file }].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  }
  const bytes = encodeProtocolDirectory(directory), candidate = hashObject(bytes); objects.set(candidate, bytes);
  return { change: crypto.randomUUID(), candidate: candidate as ObjectHash, trace: null, resolves: [], deltas: [], objects: [...objects].map(([hash, bytes]) => ({ hash, bytes })) };
}
async function traced(basis: string, text: string): Promise<CandidateUpdate> {
  const file = decodeProtocolDirectory(objects.get(basis)!).entries.find((e) => e.name === "note.md")!.file!;
  const operations = [{ key: "edit", kind: "editSource" as const, source: { material: { kind: "basis" as const, path: "/note.md", object: file }, range: [0, 1] as [number, number] }, text }];
  const executed = await executeExactSourceEdits(basis, operations, async (hash) => objects.get(hash)!);
  for (const [hash, bytes] of executed.generated) objects.set(hash, bytes);
  return { change: crypto.randomUUID(), candidate: executed.root as ObjectHash, trace: [{ before: basis, after: executed.root, operations }], resolves: [], deltas: [],
    objects: [...executed.generated].map(([hash, bytes]) => ({ hash, bytes })) };
}

test("a rebuild over the budget answers retryably, keeps its progress, and retries give the unbudgeted answer", async () => {
  const head = (await client.descriptor(tree)).tree;
  for (const [hash, bytes] of (await client.snapshot(tree, head.root)).objects) objects.set(hash, bytes);
  let at = (await client.submitUpdates(tree, { base: head.update, updates: [snapshot(head.root, { "note.md": "abc\n", "a.bin": "a\0" })] })).results[0]!.update;
  const base = at;
  // Plain edits fast-forward: the sidecar meets them only when it replays.
  for (let i = 0; i < 12; i++) at = (await client.submitUpdates(tree, { base: at.id, updates: [await traced(at.root, String.fromCharCode(65 + i))] })).results[0]!.update;
  const last = acceptedEntries(dir, tree).at(-1)!;
  const question = recordedQuestion(last.entry);
  const expected = await sidecar(dir).answer(question);
  expect(expected.root).toBe(last.entry.root);
  // In process: a budget too small for one entry more still progresses by one per attempt.
  const budgeted = sidecar(dir, 0.001);
  let attempts = 0, answer;
  for (;;) {
    attempts++;
    try { answer = await budgeted.answer(question); break; }
    catch (error) {
      expect(error).toBeInstanceOf(EvaluationFailure);
      expect((error as EvaluationFailure).code).toBe("unavailable");
      expect(attempts).toBeLessThan(50);
    }
  }
  expect(attempts).toBeGreaterThan(1);
  expect(stableJSONString(answer)).toBe(stableJSONString(expected));
  // Through canopyd: a cold sidecar over the same chain answers a snapshot on
  // an old base with a retryable 503 until it has caught up, then merges it.
  await stop();
  process.env.ARBOR_MERGE_REPLAY_MS = "0.001";
  await start();
  const stale = snapshot(base.root, { "a.bin": "stale\0" });
  let failures = 0, accepted;
  for (;;) {
    try { accepted = (await client.submitUpdates(tree, { base: base.id, updates: [stale] })).results[0]!.update; break; }
    catch (error) {
      expect(error).toBeInstanceOf(ProtocolHTTPError);
      expect((error as ProtocolHTTPError).status).toBe(503);
      expect(++failures).toBeLessThan(50);
    }
  }
  expect(failures).toBeGreaterThan(0);
  expect(accepted.previous?.id).toBe(at.id);
  await running.canopy.verifyIntegrity();
});
