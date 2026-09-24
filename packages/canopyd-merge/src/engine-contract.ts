/** The sidecar engine's own request and result shapes: an authored tree
 * evaluation and a checkpoint of an accepted projection. These are internal
 * to the sidecar; canopyd asks the one question in `@overstory/merge-protocol`. */
import { z } from "zod";
import type { SourceOperation } from "@overstory/protocol";
import type { ObjectStore } from "@overstory/object-store";
import { OBJECT_HASH, type AlternativeBinding, type Frame, type LogDecision } from "@overstory/merge-protocol";
import { FORMATS } from "./format-rules.ts";
import type { IntentDecision } from "./intent-model.ts";
import type { RetainedStates } from "./retained-state.ts";

export type { Frame };
const hash = z.string().regex(OBJECT_HASH);
const token = z.string().min(1).max(1024);

/** Immutable object IO for the engine: no accepted-state or database access.
 * `read` reports an absent object as a `missing-context` `MergeRefusal` (as
 * the sidecar's reader does) or an `ENOENT` error (as `ObjectStore.read`
 * does); any other failure is the store's own and propagates. Bytes it
 * returns are the object's: every production reader verifies them. */
export interface MergeObjects {
  read(hash: string): Promise<Uint8Array>;
  store: ObjectStore["store"];
  /** The engine states recorded so far, kept by identity. */
  states: RetainedStates;
}

/** The reference sidecar's rules (`tree-default`, revision 1): the
 * configuration a question's `rules.config` may carry. */
export const treeDefaultConfig = z
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
            format: z.enum(FORMATS).optional(),
            recordKey: z.string().min(1).optional(),
            proseInsertions: z.enum(["review", "preserve-both"]).optional(),
          })
          .strict()
      )
      .optional(),
    maxNodes: z.number().int().positive().max(100_000).optional(),
  })
  .strict();

// ---- Authored (intent) evaluation ---------------------------------------

const stateRef = z.object({ object: hash, state: hash.optional() }).strict();
/** The shape of an authored tree request, as the sidecar builds one for its
 * engine; `parseIntentRequest` also decodes every operation. */
export const intentRequestSchema = z
  .object({
    kind: z.literal("tree"),
    tree: token,
    // A root and the engine state the sidecar recorded for it; a root alone
    // is imported as it stands.
    base: stateRef,
    current: stateRef,
    incoming: z
      .object({
        change: token,
        object: hash,
        // The authored frame chain. An empty chain carries no evidence: a
        // bare resolution, or snapshot semantics.
        trace: z.array(z.object({ before: hash, after: hash, operations: z.array(z.unknown()).max(1024) }).strict()).max(64),
        resolves: z.array(z.string().min(1)).max(1024).optional(),
      })
      .strict(),
    rules: z
      .object({ id: z.literal("tree-default"), revision: z.literal(1), config: treeDefaultConfig.optional() })
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
export type IntentRequest = Omit<z.infer<typeof intentRequestSchema>, "incoming" | "alternatives"> & {
  incoming: { change: string; object: string; trace: Frame[]; resolves?: string[] };
  alternatives?: AlternativeBinding[];
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

/** A failure to evaluate, not a refusal: the evaluation ran out of time
 * (`limit`), or the object store failed. Neither is a property of the
 * question, so the answer could differ on a retry. The sidecar reports it as
 * `{error}`, and no fallback inside the engine absorbs it. */
export class EvaluationFailure extends Error {
  constructor(message: string, readonly code?: "limit", options?: ErrorOptions) {
    super(message, options);
    this.name = "EvaluationFailure";
  }
}

/** An authored evaluation's result: the merged state, the author's own
 * state, the objects it generated, and the decisions the result retains. */
export interface IntentEvaluation {
  outcome: "evaluated";
  result: { object: string; state: string };
  authored: { object: string; state: string };
  objects: string[];
  decisions: IntentDecision[];
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

/** An accepted projection recorded onto a retained state, with the decisions
 * it keeps open as a log entry records them; never authored operations. */
export interface CheckpointRequest {
  kind: "checkpoint";
  tree: string;
  current: { object: string; state?: string };
  projection: string;
  candidate?: string;
  continueSelected?: boolean;
  conflictProjection?: "current" | "incoming";
  change: string;
  resolves?: string[];
  /** Replaying an accepted entry: `resolves` removes decisions without the
   * guard a client resolution needs. */
  align?: true;
  decisions: LogDecision[];
}
export interface CheckpointResponse {
  kind: "checkpoint";
  result: { object: string; state: string };
  objects: string[];
}
