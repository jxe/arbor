import {
  checkpointBatchSchema,
  checkpointSchema,
  isIntentRequest,
  projectionRequestSchema,
  retentionAuditSchema,
  type MergeRequest,
} from "@overstory/merge-protocol";
import { parseIntentRequest } from "./intent-model.ts";

export {
  isIntentRequest,
  parseResponse,
  type MergeRequest,
  type MergeResponse,
  type ProjectionRequest,
  type ProjectionResponse,
} from "@overstory/merge-protocol";

/** The worker's own request check: the shared shape, plus every authored
 * operation decoded. */
export function parseRequest(raw: unknown): MergeRequest {
  if (raw && typeof raw === "object" && "kind" in raw && raw.kind === "checkpoint-batch")
    return checkpointBatchSchema.parse(raw);
  if (raw && typeof raw === "object" && "kind" in raw && raw.kind === "checkpoint")
    return checkpointSchema.parse(raw);
  if (raw && typeof raw === "object" && "kind" in raw && raw.kind === "retention-audit")
    return retentionAuditSchema.parse(raw);
  if (isIntentRequest(raw)) return parseIntentRequest(raw);
  return projectionRequestSchema.parse(raw);
}
