import { decodeWireDirectory, wireEntryObject, type ObjectHash, type TreeSnapshot } from "@arbor/wire";
import type { ObjectStore } from "@arbor/object-store";
import { isIntentRequest, parseRequest, parseResponse, type MergeRequest, type MergeResponse, type ProjectionRequest, type ProjectionResponse } from "./contract.ts";
import { mergeWireTrees, type MergeResult } from "./merge.ts";
import { markdownProseSourceRule, plainTextSourceRule } from "./merge-rules.ts";
import { readAccountConfigGraph, mergeAccountConfigGraphs, snapshotAccountConfig } from "./account.ts";
import { readAccountConfigGraphV2, mergeAccountConfigGraphsV2, snapshotAccountConfigV2 } from "./account-v2.ts";
export { isIntentRequest, parseRequest, parseResponse, type MergeRequest, type MergeResponse, type ProjectionRequest, type ProjectionResponse } from "./contract.ts";
import { mergeIntent } from "./intent-engine.ts";
import type { IntentRequest, IntentResponse } from "./intent-model.ts";
export type { IntentRequest, IntentResponse } from "./intent-model.ts";
export type { MergeSummary } from "./summary.ts";

export interface MergeObjects {
  read(hash: ObjectHash): Promise<Uint8Array>;
  store: ObjectStore["store"];
}

async function snapshot(root: string, objects: MergeObjects): Promise<TreeSnapshot> {
  const found = new Map<ObjectHash, Uint8Array>();
  async function visit(hash: string, directory: boolean): Promise<void> {
    if (found.has(hash)) return;
    const bytes = await objects.read(hash); found.set(hash, bytes);
    if (directory) for (const entry of decodeWireDirectory(bytes).entries) {
      const child = wireEntryObject(entry);
      if (child) await visit(child.hash, child.kind === "directory");
    }
  }
  await visit(root, true);
  return { root, objects: found };
}

/** Pure rule evaluation plus immutable object IO. No accepted-state or database access. */
export function merge(raw:IntentRequest,objects:MergeObjects):Promise<IntentResponse>;
export function merge(raw:ProjectionRequest,objects:MergeObjects):Promise<ProjectionResponse>;
export function merge(raw:MergeRequest,objects:MergeObjects):Promise<MergeResponse>;
export async function merge(raw: MergeRequest, objects: MergeObjects): Promise<MergeResponse> {
  if(isIntentRequest(raw))return mergeIntent(raw,objects);
  const request = parseRequest(raw);
  if(isIntentRequest(request))throw new Error("Unexpected intent request");
  const evidence = { rule: request.rules };
  if (request.kind === "source") {
    const rule = [plainTextSourceRule, markdownProseSourceRule].find(rule => rule.id === request.rules.id);
    if (!rule) throw new Error(`Unknown source rule: ${request.rules.id}`);
    const [basis, current, candidate, proposed] = await Promise.all([
      request.base.object, request.current.object, request.incoming.object, request.proposal.object,
    ].map(hash => objects.read(hash)));
    const decision = await rule.evaluate({ tree: request.tree, path: request.path, basis: basis!, current: current!,
      candidate: candidate!, proposed: proposed!, contributions: request.incoming.contributions, changes: request.incoming.changes });
    return parseResponse({ result: request.proposal, decisions: [{ kind: "source", path: request.path, ...decision }], objects: [], evidence }, request);
  }
  let result: MergeResult;
  const { base, current, incoming } = request;
  if (request.rules.id === "tree-default") {
    result = await mergeWireTrees(base.object, incoming.object, current.object, hash => objects.read(hash));
  } else if (request.rules.id === "account-config-v1" || request.rules.id === "account-config-v2") {
    const [b, i, c] = await Promise.all([base, incoming, current].map(ref => snapshot(ref.object, objects)));
    const merged = request.rules.id === "account-config-v1"
      ? mergeAccountConfigGraphs(readAccountConfigGraph(b!), readAccountConfigGraph(i!), readAccountConfigGraph(c!))
      : mergeAccountConfigGraphsV2(readAccountConfigGraphV2(b!), readAccountConfigGraphV2(i!), readAccountConfigGraphV2(c!));
    const output = request.rules.id === "account-config-v1"
      ? snapshotAccountConfig(merged.graph as Parameters<typeof snapshotAccountConfig>[0])
      : snapshotAccountConfigV2(merged.graph as Parameters<typeof snapshotAccountConfigV2>[0]);
    result = { root: output.root, objects: output.objects, conflicts: merged.conflicts.map(path => ({ path, reason: "account-configuration" })),
      summary: { version: request.rules.id, mergedFields: merged.mergedFields } };
  } else throw new Error(`Unknown tree rule: ${request.rules.id}`);
  await objects.store([...result.objects].map(([hash, bytes]) => ({ hash, bytes })));
  return parseResponse({ result: { object: result.root }, objects: [...result.objects.keys()],
    decisions: [
      ...result.conflicts.map(conflict => ({ kind: "conflict", ...conflict, scope: "entry" })),
      ...(result.unresolvedDirectories ?? []).map(path => ({ kind: "conflict", path, reason: "node-conflict", scope: "directory" })),
    ], evidence: { ...evidence, ...(result.summary ? { summary: result.summary } : {}) },
  }, request);
}
