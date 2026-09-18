import { z } from "zod";
import {
  decodeAuthoredCandidateIntent,
  decodeMaterialRef,
} from "../../wire/src/updates/authored-contract.ts";
import type { MaterialRef, SourceOperation } from "@arbor/wire";

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const token = z.string().min(1).max(1024);
const ref = z.object({ object: hash, state: hash.optional() }).strict();
const schema = z
  .object({
    kind: z.literal("tree"),
    tree: token,
    // Host-supplied state/root pairs have already passed semantic validation.
    // This internal contract never accepts client assertions of that fact.
    base: ref,
    current: ref,
    incoming: z
      .object({
        change: token,
        object: hash,
        operations: z.array(z.unknown()).max(1024),
        resolves: z.array(z.string().min(1)).max(1024).optional(),
      })
      .strict(),
    rules: z
      .object({
        id: z.literal("tree-default"),
        revision: z.literal(1),
        config: z
          .object({
            contentChoices: z.enum(["source", "file"]).optional(),
            conflictProjection: z.enum(["current", "incoming"]).optional(),
            maxMillis: z.number().int().positive().max(30_000).optional(),
            maxBytes: z
              .number()
              .int()
              .positive()
              .max(128 * 1024 * 1024)
              .optional(),
            formats: z
              .record(
                z.string(),
                z
                  .object({
                    format: z
                      .enum([
                        "text",
                        "markdown",
                        "json",
                        "jsonl",
                        "yaml",
                        "toml",
                        "csv",
                        "tsv",
                        "typescript",
                        "javascript",
                        "swift",
                        "python",
                        "html",
                        "xml",
                        "css",
                        "binary",
                      ])
                      .optional(),
                    recordKey: z.string().min(1).optional(),
                    proseInsertions: z
                      .enum(["review", "preserve-both"])
                      .optional(),
                  })
                  .strict()
              )
              .optional(),
            maxNodes: z.number().int().positive().max(100_000).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    alternatives: z
      .array(
        z
          .object({
            ref: z.unknown(),
            decision: z.string().min(1),
            alternative: z.number().int().nonnegative(),
            value: z
              .object({ object: hash, kind: z.enum(["file", "directory"]) })
              .strict(),
          })
          .strict()
      )
      .max(1024)
      .optional(),
  })
  .strict();
export type IntentRequest = Omit<
  z.infer<typeof schema>,
  "incoming" | "alternatives"
> & {
  incoming: {
    change: string;
    object: string;
    operations: SourceOperation[];
    resolves?: string[];
  };
  alternatives?: Array<{
    ref: MaterialRef;
    decision: string;
    alternative: number;
    value: { object: string; kind: "file" | "directory" };
  }>;
};
export function parseIntentRequest(raw: unknown): IntentRequest {
  if (
    raw &&
    typeof raw === "object" &&
    "rules" in raw &&
    (raw.rules as { revision?: number })?.revision !== 1
  )
    throw new IntentError("unsupported", "Unknown rule revision");
  const value = schema.parse(raw);
  for (const op of value.incoming.operations)
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
        "undoOperation",
      ].includes(String(op.kind))
    )
      throw new IntentError("unsupported", "Unknown operation kind");
  if (value.incoming.operations.length || !value.incoming.resolves?.length)
    decodeAuthoredCandidateIntent({
      change: value.incoming.change,
      candidate: value.incoming.object,
      operations: value.incoming.operations,
      resolves: [],
    });
  for (const alternative of value.alternatives ?? []) {
    const ref = decodeMaterialRef(alternative.ref);
    if (ref.material.kind !== "alternative" || ref.within || ref.range)
      throw new Error(
        "Alternative bindings require a complete alternative reference"
      );
  }
  return value as IntentRequest;
}
export class IntentError extends Error {
  constructor(
    readonly code: "invalid" | "missing-context" | "unsupported" | "limit",
    message: string
  ) {
    super(message);
  }
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
export type IntentResponse =
  | {
      outcome: "evaluated";
      result: { object: string; state: string };
      authored: { object: string; state: string };
      objects: string[];
      decisions: IntentDecision[];
      evidence: {
        rule: { id: "tree-default"; revision: 1 };
        inputs: string[];
        change: string;
        operations: string[];
        validation: "verified";
        formats: import("./format-rules.ts").FormatEvidence[];
      };
    }
  | {
      outcome: "invalid" | "missing-context" | "unsupported" | "limit";
      message: string;
    };
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
          : !/^sha256:[a-f0-9]{64}$/.test(node.object))
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

/** History records have no cross-record schema constraints. Use the same full
 * schema and retained-node checks for a new record as for a complete state. */
export function parseIntentHistoryRecord(
  field: "outputs" | "effects" | "origins" | "alternatives" | "changes",
  raw: unknown,
): unknown {
  const state = parseIntentState({
    format: "arbor-merge-intent-state", tree: "validation", root: "root",
    nodes: {}, outputs: {}, effects: {}, origins: {}, alternatives: {}, changes: {}, decisions: [],
    [field]: {record: raw},
  });
  return state[field].record;
}

const intentResponseSchema = z
  .object({
    outcome: z.literal("evaluated"),
    result: z.object({ object: hash, state: hash }).strict(),
    authored: z.object({ object: hash, state: hash }).strict(),
    objects: z.array(hash),
    decisions: z.array(decisionSchema),
    evidence: z
      .object({
        rule: z
          .object({ id: z.literal("tree-default"), revision: z.literal(1) })
          .strict(),
        inputs: z.array(hash),
        change: token,
        operations: z.array(token),
        validation: z.literal("verified"),
        formats: z.array(
          z
            .object({
              id: token,
              revision: z.literal(1),
              outcome: z.enum(["resolved", "unresolved"]),
              reason: z.string(),
              config: z.record(z.string(), z.unknown()),
            })
            .strict()
        ),
      })
      .strict(),
  })
  .strict();
export function parseIntentResponse(
  raw: unknown,
  request: IntentRequest
): Extract<IntentResponse, { outcome: "evaluated" }> {
  if (
    raw &&
    typeof raw === "object" &&
    "outcome" in raw &&
    ["invalid", "missing-context", "unsupported", "limit"].includes(
      String(raw.outcome)
    ) &&
    "message" in raw &&
    typeof raw.message === "string"
  )
    throw new IntentError(
      raw.outcome as "invalid" | "missing-context" | "unsupported" | "limit",
      raw.message
    );
  const value = intentResponseSchema.parse(raw);
  if (
    value.authored.object !== request.incoming.object ||
    value.evidence.change !== request.incoming.change ||
    JSON.stringify(value.evidence.operations) !==
      JSON.stringify(request.incoming.operations.map((op) => op.key)) ||
    new Set(value.objects).size !== value.objects.length
  )
    throw new Error("Intent response does not match request");
  for (const decision of value.decisions) {
    if (decision.selected >= decision.alternatives.length)
      throw new Error("Invalid selected alternative");
    if (decision.subject) decodeMaterialRef(decision.subject);
  }
  return value as Extract<IntentResponse, { outcome: "evaluated" }>;
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

/** Typed retained edges, deduplicated independently of repeated historical
 * piece occurrences. Hashes of change requests are metadata, not file objects. */
export function intentReferences(state: IntentState): Set<string> {
  const refs = new Set([...intentDependencies(state)].map(hash => "object:" + hash));
  const add = (kind: string, hash: string) => refs.add(kind + ":" + hash);
  const nodes = (values: Record<string, Node>) => {
    for (const node of Object.values(values))
      if (node.kind === "directory") add("directory", node.object);
  };
  nodes(state.nodes);
  for (const material of Object.values(state.outputs)) if (material.view) nodes(material.view.nodes);
  for (const effect of Object.values(state.effects)) {
    nodes(effect.before); nodes(effect.after); add("directory", effect.authored.basis);
  }
  for (const hash of Object.values(state.changes)) add("change", hash);
  for (const decision of state.decisions) {
    if (decision.context) add("state", decision.context);
    for (const alternative of decision.alternatives) add("state", alternative.state);
  }
  return refs;
}
export function intentHistoryReferences(field: "outputs" | "effects" | "origins" | "alternatives" | "changes", record: unknown): Set<string> {
  return intentReferences({format: "arbor-merge-intent-state", tree: "", root: "", nodes: {}, decisions: [],
    outputs: {}, effects: {}, origins: {}, alternatives: {}, changes: {}, [field]: {record}} as IntentState);
}

export function isIntentRequest(raw: unknown): raw is IntentRequest {
  return (
    !!raw &&
    typeof raw === "object" &&
    "kind" in raw &&
    raw.kind === "tree" &&
    "incoming" in raw &&
    !!raw.incoming &&
    typeof raw.incoming === "object" &&
    "operations" in raw.incoming
  );
}
