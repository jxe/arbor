import {checkpointIntent} from "./intent-engine.ts";
import type {CheckpointRequest,CheckpointResponse} from "./checkpoint.ts";
import { decodeWireDirectory, wireEntryObject, type ObjectHash, type TreeSnapshot } from "@overstory/protocol";
import type { ObjectStore } from "@overstory/object-store";
import { isIntentRequest, parseRequest, parseResponse, type MergeRequest, type MergeResponse, type ProjectionRequest, type ProjectionResponse } from "./contract.ts";
import { mergeWireTrees, type MergeResult } from "./merge.ts";
import { readAccountConfigGraphV2, mergeAccountConfigGraphsV2, snapshotAccountConfigV2 } from "./account-v2.ts";
export { isIntentRequest, parseRequest, parseResponse, type MergeRequest, type MergeResponse, type ProjectionRequest, type ProjectionResponse } from "./contract.ts";
import { mergeIntent } from "./intent-engine.ts";
import type { IntentRequestInput, IntentResponse } from "./intent-model.ts";
export type { Frame, IntentRequest, IntentRequestInput, IntentResponse } from "./intent-model.ts";
export type { MergeSummary } from "./summary.ts";
export { mergeWireTrees, type MergeResult } from "./merge.ts";
export { loadIntentState } from "./state-storage.ts";
export { type CheckpointRequest } from "./checkpoint.ts";

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
export function merge(raw:CheckpointRequest,objects:MergeObjects):Promise<CheckpointResponse>;
export function merge(raw:IntentRequestInput,objects:MergeObjects):Promise<IntentResponse>;
export function merge(raw:ProjectionRequest,objects:MergeObjects):Promise<ProjectionResponse>;
export function merge(raw:MergeRequest,objects:MergeObjects):Promise<MergeResponse>;
export async function merge(raw: MergeRequest, objects: MergeObjects): Promise<MergeResponse> {
  if(isIntentRequest(raw))return mergeIntent(raw,objects);
  const request = parseRequest(raw);
  if(isIntentRequest(request))throw new Error("Unexpected intent request");
  if(request.kind === "checkpoint")return checkpointIntent(request,objects);
  const evidence = { rule: request.rules };
  let result: MergeResult;
  const { base, current, incoming } = request;
  if (request.rules.id === "tree-default") {
    result = await mergeWireTrees(base.object, incoming.object, current.object, hash => objects.read(hash));
  } else if (request.rules.id === "account-config-v2") {
    const [b, i, c] = await Promise.all([base, incoming, current].map(ref => snapshot(ref.object, objects)));
    const resourceInputs = [b!, i!, c!].map(value => readAccountConfigGraphV2(value));
    const merged = mergeAccountConfigGraphsV2(resourceInputs[0]!, resourceInputs[1]!, resourceInputs[2]!);
    const policyOnlyRemoval = (field: string) => {
      const match = /^resources\.([^.]+)$/.exec(field);
      return !!match && resourceInputs.every(graph => !graph.resources?.[match[1]!]?.canonical);
    };
    const output = snapshotAccountConfigV2(merged.graph);
    result = { root: output.root, objects: output.objects, conflicts: merged.conflicts.map(field => ({
      path: /^resources\.[^.]+\.access(?:\.|$)/.test(field) || policyOnlyRemoval(field) ? "/trees.yaml/access"
        : /^(resources|trees)\./.test(field) ? "/trees.yaml"
        : field.startsWith("devices.") ? "/devices.yaml" : "/account.yaml",
      reason: "account-configuration",
    })),
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
