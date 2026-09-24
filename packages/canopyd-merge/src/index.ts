import {checkpointIntent} from "./intent-engine.ts";
import type {CheckpointRequest,CheckpointResponse} from "./checkpoint.ts";
import type { ObjectHash } from "@overstory/protocol";
import type { ObjectStore } from "@overstory/object-store";
import { isIntentRequest, parseRequest, parseResponse, type MergeRequest, type MergeResponse, type ProjectionRequest, type ProjectionResponse } from "./contract.ts";
import { mergeWireTrees, type MergeResult } from "./merge.ts";
export { isIntentRequest, parseRequest, parseResponse, type MergeRequest, type MergeResponse, type ProjectionRequest, type ProjectionResponse } from "./contract.ts";
import { mergeIntent } from "./intent-engine.ts";
import type { IntentRequestInput, IntentResponse } from "./intent-model.ts";
export type { Frame, IntentRequest, IntentRequestInput, IntentResponse } from "./intent-model.ts";
export type { MergeSummary } from "./summary.ts";
export { mergeWireTrees, type MergeResult } from "./merge.ts";
export { loadIntentState } from "./state-storage.ts";
export { type CheckpointRequest } from "./checkpoint.ts";

/** In-process results: an authored evaluation also carries the engine's own
 * decision records. `wireResponse` is what the worker sends. */
export type ToolResponse = ProjectionResponse | IntentResponse | CheckpointResponse;
export function wireResponse(response: ToolResponse): MergeResponse {
  if (!("outcome" in response) || response.outcome !== "evaluated") return response as MergeResponse;
  const { decisions: _records, reports, ...rest } = response;
  return { ...rest, decisions: reports };
}

export interface MergeObjects {
  read(hash: ObjectHash): Promise<Uint8Array>;
  store: ObjectStore["store"];
}

/** Pure rule evaluation plus immutable object IO. No accepted-state or database access. */
export function merge(raw:CheckpointRequest,objects:MergeObjects):Promise<CheckpointResponse>;
export function merge(raw:IntentRequestInput,objects:MergeObjects):Promise<IntentResponse>;
export function merge(raw:ProjectionRequest,objects:MergeObjects):Promise<ProjectionResponse>;
export function merge(raw:MergeRequest,objects:MergeObjects):Promise<ToolResponse>;
export async function merge(raw: MergeRequest, objects: MergeObjects): Promise<ToolResponse> {
  if(isIntentRequest(raw))return mergeIntent(raw,objects);
  const request = parseRequest(raw);
  if(isIntentRequest(request))throw new Error("Unexpected intent request");
  if(request.kind === "checkpoint")return checkpointIntent(request,objects);
  const evidence = { rule: request.rules };
  let result: MergeResult;
  const { base, current, incoming } = request;
  if (request.rules.id === "tree-default") {
    result = await mergeWireTrees(base.object, incoming.object, current.object, hash => objects.read(hash));
  } else throw new Error(`Unknown tree rule: ${request.rules.id}`);
  await objects.store([...result.objects].map(([hash, bytes]) => ({ hash, bytes })));
  return parseResponse({ result: { object: result.root }, objects: [...result.objects.keys()],
    decisions: [
      ...result.conflicts.map(conflict => ({ kind: "conflict", ...conflict, scope: "entry" })),
      ...(result.unresolvedDirectories ?? []).map(path => ({ kind: "conflict", path, reason: "node-conflict", scope: "directory" })),
    ], evidence: { ...evidence, ...(result.summary ? { summary: result.summary } : {}) },
  }, request);
}
