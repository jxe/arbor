import { decodeAuthoredCandidateIntent, type MaterialRef } from "@ovst/protocol";
import { MergeRefusal } from "@ovst/merge-protocol";
import { traceOperations, type Frame, type IntentRequest } from "./engine-contract.ts";
export { traceOperations, type Frame, type IntentRequest };
/** Check what a question's shape cannot state: that the trace follows its
 * basis and ends at the candidate, and every operation. The request's shape
 * was checked where the sidecar parsed the question (`parseQuestion` and its
 * rules), so it is trusted here. Anything wrong with the trace is the
 * request's fault, so every failure here is a typed refusal. */
export function checkTrace(request: IntentRequest): void {
  try {
    checkFrames(request);
  } catch (error) {
    if (error instanceof MergeRefusal) throw error;
    throw new MergeRefusal("invalid", error instanceof Error ? error.message : "Invalid intent request");
  }
}
function checkFrames(request: IntentRequest): void {
  const incoming = request.incoming,
    trace = incoming.trace;
  if (trace.reduce((sum, frame) => sum + frame.operations.length, 0) > 1024)
    throw new MergeRefusal("limit", "Trace exceeds the operation limit");
  const keys = new Set<string>();
  for (const [index, frame] of trace.entries()) {
    const previous = trace[index - 1];
    if ((previous ? previous.after : request.base.object) !== frame.before)
      throw new MergeRefusal("invalid", "Trace does not follow its basis");
    if (index === trace.length - 1 && frame.after !== incoming.object)
      throw new MergeRefusal("invalid", "Trace does not end at the candidate");
    // A trace states its steps, so each of its frames contributes something.
    // A snapshot or a bare resolution carries no frames at all.
    if (!frame.operations.length)
      throw new MergeRefusal("invalid", "Frame carries no operations");
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
        throw new MergeRefusal("unsupported", "Unknown operation kind");
    decodeAuthoredCandidateIntent({
      change: incoming.change,
      candidate: frame.after,
      trace: [{ before: frame.before, after: frame.after, operations: frame.operations }],
      resolves: [],
    });
    // An operation key names one authored contribution of this change, so it
    // stays unique across the whole trace, not merely within a frame.
    for (const op of frame.operations) {
      if (keys.has(op.key))
        throw new MergeRefusal("invalid", "Operation identity reused");
      keys.add(op.key);
    }
  }
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
  readonly nodes: Readonly<Record<string, Readonly<Node>>>;
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
