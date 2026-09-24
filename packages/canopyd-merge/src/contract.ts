import {
  checkpointSchema,
  isIntentRequest,
  projectionRequestSchema,
  type MergeRequest,
} from "./engine-contract.ts";
import { parseIntentRequest } from "./intent-model.ts";

export {
  isIntentRequest,
  parseResponse,
  type MergeRequest,
  type MergeResponse,
  type ProjectionRequest,
  type ProjectionResponse,
} from "./engine-contract.ts";

/** The engine's own request check: the shape, plus every authored
 * operation decoded. */
export function parseRequest(raw: unknown): MergeRequest {
  if (raw && typeof raw === "object" && "kind" in raw && raw.kind === "checkpoint")
    return checkpointSchema.parse(raw);
  if (isIntentRequest(raw)) return parseIntentRequest(raw);
  return projectionRequestSchema.parse(raw);
}
