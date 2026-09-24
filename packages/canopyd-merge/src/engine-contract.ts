/** The sidecar engine's own request and result shapes: an authored tree
 * evaluation and a checkpoint of an accepted projection. These are internal
 * to the sidecar; canopyd asks the one question in `@overstory/merge-protocol`. */
import { z } from "zod";
import type { MaterialRef, SourceOperation } from "@overstory/protocol";

export const OBJECT_HASH = /^sha256:[a-f0-9]{64}$/;
const hash = z.string().regex(OBJECT_HASH);
const token = z.string().min(1).max(1024);
const contribution = z.object({ change: z.string(), operation: z.string().nullable() }).strict();

/** Rule evidence a snapshot tree merge reports beside its result. */
export type MergeSummary =
  | { version: "markdown-additive-v1"; approximatePlacements: number }
  | { version: "collection-file-rows-v1"; mergedRows: number };

// ---- Decision reports ----------------------------------------------------

/** One retained decision as canopyd needs it: the worker resolves its own
 * node identities into logical paths, so its retained state stays opaque.
 * `placement` is present when the decision has a placement; its `path` names
 * the placed file when that node still exists, and `range` is its affected
 * byte range when the node is active and the decision has no context. */
export interface DecisionReport {
  key: string;
  kind: "content" | "placement" | "existence" | "directory";
  reason: string;
  selected: number;
  dependencies: string[];
  alternatives: Array<{ object: string; state: string; present: boolean; contributions: Array<{ change: string; operation: string | null }> }>;
  subject?: MaterialRef;
  placement?: { path?: string; range?: [number, number] };
}

// ---- Authored (intent) evaluation ---------------------------------------

const stateRef = z.object({ object: hash, state: hash.optional() }).strict();
const formatName = z.enum([
  "text", "markdown", "json", "jsonl", "yaml", "toml", "csv", "tsv",
  "typescript", "javascript", "swift", "python", "html", "xml", "css", "binary",
]);
/** The shape of an authored tree request. The worker additionally decodes
 * every operation; canopyd only builds these. */
export const intentRequestSchema = z
  .object({
    kind: z.literal("tree"),
    tree: token,
    // Host-supplied state/root pairs come from canopyd's accepted records,
    // never from client assertions.
    base: stateRef,
    current: stateRef,
    incoming: z
      .object({
        change: token,
        object: hash,
        // The authored frame chain. A snapshot carries no evidence and
        // arrives as an empty chain.
        trace: z.array(z.object({ before: hash, after: hash, operations: z.array(z.unknown()).max(1024) }).strict()).max(64),
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
            maxBytes: z.number().int().positive().max(128 * 1024 * 1024).optional(),
            formats: z
              .record(
                z.string(),
                z
                  .object({
                    format: formatName.optional(),
                    recordKey: z.string().min(1).optional(),
                    proseInsertions: z.enum(["review", "preserve-both"]).optional(),
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
            value: z.object({ object: hash, kind: z.enum(["file", "directory"]) }).strict(),
          })
          .strict()
      )
      .max(1024)
      .optional(),
  })
  .strict();
/** One tree-root to tree-root step of authored evidence. Basis references
 * inside a frame name objects in that frame's `before` tree; operation
 * references name an earlier key in the same change. */
export interface Frame {
  before: string;
  after: string;
  operations: SourceOperation[];
}
export type IntentRequest = Omit<z.infer<typeof intentRequestSchema>, "incoming" | "alternatives"> & {
  incoming: { change: string; object: string; trace: Frame[]; resolves?: string[] };
  alternatives?: Array<{
    ref: MaterialRef;
    decision: string;
    alternative: number;
    value: { object: string; kind: "file" | "directory" };
  }>;
};

/** Every operation of a change in authored order. */
export function traceOperations(incoming: { trace: Frame[] }): SourceOperation[] {
  return incoming.trace.flatMap((frame) => frame.operations);
}

/** A typed inability to evaluate: neither a conflict resolution nor an
 * accepted receipt. canopyd decides admission and fallback. */
export class IntentError extends Error {
  constructor(readonly code: "invalid" | "missing-context" | "unsupported" | "limit", message: string) {
    super(message);
  }
}

/** An authored evaluation's result: the merged state, the author's own
 * state, the objects it generated and its decisions as reports. */
export interface IntentEvaluation {
  outcome: "evaluated";
  result: { object: string; state: string };
  authored: { object: string; state: string };
  objects: string[];
  decisions: DecisionReport[];
  evidence: {
    rule: { id: "tree-default"; revision: 1 };
    inputs: { base: string; current: string; incoming: string };
    change: string;
    operations: string[];
    validation: "verified";
    formats: Array<{ id: string; revision: 1; outcome: "resolved" | "unresolved"; reason: string; config: Record<string, unknown> }>;
  };
}
export type IntentResponse = IntentEvaluation | { outcome: IntentError["code"]; message: string };

// ---- Checkpoints ---------------------------------------------------------

/** Trusted caller supplies an accepted projection and its decisions, never
 * authored operations. */
export const checkpointSchema = z
  .object({
    kind: z.literal("checkpoint"),
    tree: z.string().min(1),
    current: stateRef,
    projection: hash,
    candidate: hash.optional(),
    continueSelected: z.boolean().optional(),
    conflictProjection: z.enum(["current", "incoming"]).optional(),
    change: z.string().min(1),
    resolves: z.array(z.string()).optional(),
    /** Replaying an accepted entry: `resolves` removes decisions without the
     * guard a client resolution needs. */
    align: z.literal(true).optional(),
    decisions: z
      .array(
        z
          .object({
            key: z.string().min(1),
            path: z.array(z.string()).optional(),
            /** With `path`: a source choice about this byte range of that file
             * (of `at`, when the choice is enclosed), whose alternatives are
             * each version's bytes for the range. */
            range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
            at: hash.optional(),
            dependencies: z.array(z.string()).optional(),
            selected: z.number().int().nonnegative(),
            alternatives: z.array(z.object({ object: hash, contributions: z.array(contribution) }).strict()).min(2),
          })
          .strict()
      )
      .default([]),
  })
  .strict();
export type CheckpointRequest = z.infer<typeof checkpointSchema>;
export interface CheckpointResponse {
  kind: "checkpoint";
  result: { object: string; state: string };
  objects: string[];
  decisions: DecisionReport[];
}
