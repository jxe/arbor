import { z } from "zod";
import { OBJECT_HASH } from "./state-value.ts";
import {
  decodeAuthoredCandidateIntent,
  decodeMaterialRef,
} from "../../protocol/src/updates/authored-contract.ts";
import type { MaterialRef } from "@overstory/protocol";
import {
  IntentError,
  intentRequestSchema,
  traceOperations,
  type DecisionReport,
  type Frame,
  type IntentEvaluation,
  type IntentRequest,
} from "./engine-contract.ts";
export { IntentError, traceOperations, type Frame, type IntentRequest };

const hash = z.string().regex(OBJECT_HASH);
const token = z.string().min(1).max(1024);
const schema = intentRequestSchema;
/** What a caller hands the engine, before `parseIntentRequest` checks it. */
export type IntentRequestInput = IntentRequest;
export function parseIntentRequest(raw: unknown): IntentRequest {
  if (
    raw &&
    typeof raw === "object" &&
    "rules" in raw &&
    (raw.rules as { revision?: number })?.revision !== 1
  )
    throw new IntentError("unsupported", "Unknown rule revision");
  const value = schema.parse(raw);
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
   * `node`. Older records carry the whole state here; readers accept both. */
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
  edits: Record<string, EffectEdit[]>;
  undone: boolean;
}
export interface EffectEdit {
  range: [number, number];
  removed: Piece[];
  inserted: Piece[];
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
/** The engine's in-process result. `decisions` are its retained records;
 * `reports` are what crosses the worker boundary as the wire `decisions`. */
export type IntentResponse =
  | (Omit<IntentEvaluation, "decisions"> & { decisions: IntentDecision[]; reports: DecisionReport[] })
  | { outcome: IntentError["code"]; message: string };
export const keyOf = (change: string, operation: string) =>
  JSON.stringify([change, operation]);
export const alternativeKey = (ref: MaterialRef) =>
  JSON.stringify(ref.material);

const pieceSchema = z
  .object({
    origin: z.string().min(1),
    start: z.number().int().nonnegative(),
    object: hash,
    offset: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(),
  })
  .strict();
const nodeSchema = z
  .object({
    id: z.string().min(1),
    parent: z.string().nullable(),
    name: z.string(),
    kind: z.enum(["file", "directory", "tree"]),
    object: z.string(),
    deletions: z.array(z.string()).optional(),
    pieces: z.array(pieceSchema).max(100_000).optional(),
    directory: z.record(z.string(), z.unknown()).optional(),
    active: z.boolean(),
  })
  .strict();
const nodesSchema = z.record(z.string(), nodeSchema);
const viewSchema = z.object({ root: z.string(), nodes: nodesSchema }).strict();
const decisionSchema = z
  .object({
    key: z.string(),
    kind: z.enum(["content", "placement", "existence", "directory"]),
    affected: z.array(z.string()),
    selected: z.number().int().nonnegative(),
    alternatives: z
      .array(
        z
          .object({
            state: hash,
            object: hash,
            node: z.string().optional(),
            contributions: z.array(
              z.object({ change: token, operation: token.nullable() }).strict()
            ),
          })
          .strict()
      )
      .min(2),
    dependencies: z.array(z.string()),
    reason: z.string(),
    subject: z.unknown().optional(),
    context: hash.optional(),
    placement: z
      .object({
        node: z.string(),
        pieces: z.array(pieceSchema),
        anchor: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
const stateSchema = z
  .object({
    format: z.literal("arbor-merge-intent-state"),
    tree: token,
    root: z.string(),
    nodes: nodesSchema,
    outputs: z.record(
      z.string(),
      z
        .object({
          node: z.string(),
          pieces: z.array(pieceSchema).optional(),
          anchor: z
            .object({
              observed: z.array(pieceSchema),
              offset: z.number().int().nonnegative(),
            })
            .strict()
            .optional(),
          view: viewSchema.optional(),
        })
        .strict()
    ),
    alternatives: z.record(z.string(), z.string()),
    origins: z.record(z.string(), z.array(pieceSchema)),
    effects: z.record(
      z.string(),
      z
        .object({
          authored: z.object({ operation: hash, basis: hash }).strict(),
          change: token,
          operation: token,
          kind: token,
          target: z.string().optional(),
          preserves: z.boolean().optional(),
          before: nodesSchema,
          after: nodesSchema,
          edits: z.record(z.string(), z.array(z.object({
            range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
            removed: z.array(pieceSchema).max(100_000),
            inserted: z.array(pieceSchema).max(100_000),
          }).strict())),
          undone: z.boolean(),
        })
        .strict()
    ),
    changes: z.record(z.string(), hash),
    decisions: z.array(decisionSchema),
  })
  .strict();
export function parseIntentState(raw: unknown): IntentState {
  const state = stateSchema.parse(raw);
  for (const d of state.decisions) {
    if (d.selected >= d.alternatives.length)
      throw new Error("Invalid selected alternative");
    if (d.subject) decodeMaterialRef(d.subject);
  }
  if (
    new Set(state.decisions.map((d) => d.key)).size !== state.decisions.length
  )
    throw new Error("Duplicate decision proposal");
  const validateNodes = (nodes: Record<string, Node>) => {
    for (const [id, node] of Object.entries(nodes)) {
      if (
        id !== node.id ||
        (node.kind === "tree"
          ? !/^tr_[a-z0-9]+$/.test(node.object)
          : !OBJECT_HASH.test(node.object))
      )
        throw new Error("Invalid retained node identity");
    }
  };
  validateNodes(state.nodes);
  for (const effect of Object.values(state.effects)) {
    validateNodes(effect.before);
    validateNodes(effect.after);
  }
  for (const output of Object.values(state.outputs))
    if (output.view) validateNodes(output.view.nodes);
  return state as IntentState;
}

/** Object dependencies only: change digests and nested TreeIDs are not objects. */
export function intentDependencies(state: IntentState): Set<string> {
  const hashes = new Set<string>();
  const pieces = (p: Piece[] | undefined) =>
    p?.forEach((p) => hashes.add(p.object));
  const nodes = (ns: Record<string, Node>) =>
    Object.values(ns).forEach((n) => {
      if (n.kind !== "tree") hashes.add(n.object);
      pieces(n.pieces);
    });
  nodes(state.nodes);
  Object.values(state.changes).forEach((hash) => hashes.add(hash));
  for (const material of Object.values(state.outputs)) {
    pieces(material.pieces);
    pieces(material.anchor?.observed);
    if (material.view) nodes(material.view.nodes);
  }
  Object.values(state.origins).forEach(pieces);
  for (const effect of Object.values(state.effects)) {
    hashes.add(effect.authored.operation);
    hashes.add(effect.authored.basis);
    nodes(effect.before);
    nodes(effect.after);
    for (const edits of Object.values(effect.edits ?? {}))
      for (const edit of edits) { pieces(edit.removed); pieces(edit.inserted); }
  }
  for (const decision of state.decisions) {
    if (decision.context) hashes.add(decision.context);
    for (const alternative of decision.alternatives) {
      hashes.add(alternative.state);
      hashes.add(alternative.object);
    }
    pieces(decision.placement?.pieces);
    if (decision.subject?.material.kind === "basis")
      hashes.add(decision.subject.material.object);
  }
  return hashes;
}
