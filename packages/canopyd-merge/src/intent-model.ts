import {
  decodeAuthoredCandidateIntent,
  decodeMaterialRef,
} from "../../protocol/src/updates/authored-contract.ts";
import type { MaterialRef } from "@overstory/protocol";
import {
  IntentError,
  intentRequestSchema,
  traceOperations,
  type Frame,
  type IntentResponse,
  type IntentRequest,
} from "./engine-contract.ts";
export { IntentError, traceOperations, type Frame, type IntentRequest, type IntentResponse };
/** Check a request's shape and decode every operation. Anything wrong with it
 * is the request's fault, so every failure here is a typed refusal. */
export function parseIntentRequest(raw: unknown): IntentRequest {
  try {
    return checkIntentRequest(raw);
  } catch (error) {
    if (error instanceof IntentError) throw error;
    throw new IntentError("invalid", error instanceof Error ? error.message : "Invalid intent request");
  }
}
function checkIntentRequest(raw: unknown): IntentRequest {
  if (
    raw &&
    typeof raw === "object" &&
    "rules" in raw &&
    (raw.rules as { revision?: number })?.revision !== 1
  )
    throw new IntentError("unsupported", "Unknown rule revision");
  const value = intentRequestSchema.parse(raw);
  const incoming = value.incoming,
    trace = incoming.trace;
  if (trace.reduce((sum, frame) => sum + frame.operations.length, 0) > 1024)
    throw new IntentError("limit", "Trace exceeds the operation limit");
  const keys = new Set<string>();
  for (const [index, frame] of trace.entries()) {
    const previous = trace[index - 1];
    if ((previous ? previous.after : value.base.object) !== frame.before)
      throw new IntentError("invalid", "Trace does not follow its basis");
    if (index === trace.length - 1 && frame.after !== incoming.object)
      throw new IntentError("invalid", "Trace does not end at the candidate");
    // A trace states its steps, so each of its frames contributes something.
    // A snapshot or a bare resolution carries no frames at all.
    if (!frame.operations.length)
      throw new IntentError("invalid", "Frame carries no operations");
    for (const op of frame.operations)
      if (
        op &&
        typeof op === "object" &&
        "kind" in op &&
        ![
          "editSource",
          "moveSource",
          "copySource",
          "moveEntry",
          "copyEntry",
          "removeEntry",
          "replaceEntry",
          "addEntry",
        ].includes(String(op.kind))
      )
        throw new IntentError("unsupported", "Unknown operation kind");
    decodeAuthoredCandidateIntent({
      change: incoming.change,
      candidate: frame.after,
      trace: [{ before: frame.before, after: frame.after, operations: frame.operations }],
      resolves: [],
    });
    // An operation key names one authored contribution of this change, so it
    // stays unique across the whole trace, not merely within a frame.
    for (const op of frame.operations as Array<{ key: string }>) {
      if (keys.has(op.key))
        throw new IntentError("invalid", "Operation identity reused");
      keys.add(op.key);
    }
  }
  for (const alternative of value.alternatives ?? []) {
    const ref = decodeMaterialRef(alternative.ref);
    if (ref.material.kind !== "alternative" || ref.within || ref.range)
      throw new Error(
        "Alternative bindings require a complete alternative reference"
      );
  }
  return value as IntentRequest;
}
/** The request's semantic identity, hashed into `changes[change]`. The frame
 * chain is the authored claim, so it is what the signature covers: the same
 * operations divided into different frames are a different change. */
export function changeIdentity(request: IntentRequest) {
  return {
    base: request.base,
    incoming: request.incoming,
    alternatives: request.alternatives,
    rules: request.rules,
  };
}
export interface Piece {
  origin: string;
  start: number;
  object: string;
  offset: number;
  length: number;
}
export interface Node {
  id: string;
  parent: string | null;
  name: string;
  kind: "file" | "directory" | "tree";
  object: string;
  deletions?: string[];
  pieces?: Piece[];
  directory?: Record<string, unknown>;
  active: boolean;
}
export interface View {
  root: string;
  nodes: Record<string, Node>;
}
export interface Material {
  node: string;
  pieces?: Piece[];
  anchor?: { observed: Piece[]; offset: number };
  /** An entry operation's result: `node` and its active descendants, rooted at
   * `node`. */
  view?: View;
}
export interface Effect {
  authored: { operation: string; basis: string };
  change: string;
  operation: string;
  kind: string;
  target?: string;
  preserves?: boolean;
  before: Record<string, Node>;
  after: Record<string, Node>;
  /** The piece edits of an `editSource` effect, per file node (empty for
   * every other kind). An edited file's `before`/`after` copies omit
   * `pieces`: the edits carry exactly what deletion enforcement and retention
   * read. */
  edits: Record<string, Array<{ range: [number, number]; removed: Piece[]; inserted: Piece[] }>>;
  undone: boolean;
}
export interface IntentState extends View {
  format: "arbor-merge-intent-state";
  tree: string;
  outputs: Record<string, Material>;
  alternatives: Record<string, string>;
  origins: Record<string, Piece[]>;
  effects: Record<string, Effect>;
  changes: Record<string, string>;
  decisions: IntentDecision[];
}
export interface IntentDecision {
  key: string;
  kind: "content" | "placement" | "existence" | "directory";
  affected: string[];
  selected: number;
  alternatives: Array<{
    state: string;
    object: string;
    node?: string;
    contributions: Array<{ change: string; operation: string | null }>;
  }>;
  dependencies: string[];
  reason: string;
  subject?: MaterialRef;
  context?: string;
  placement?: { node: string; pieces: Piece[]; anchor: number };
}
export const keyOf = (change: string, operation: string) =>
  JSON.stringify([change, operation]);
export const alternativeKey = (ref: MaterialRef) =>
  JSON.stringify(ref.material);
