/** The sidecar engine's own request and result shapes: an authored tree
 * evaluation and a checkpoint of an accepted projection. These are internal
 * to the sidecar; overstoryd asks the one question in `@ovst/merge-protocol`. */
import { z } from "zod";
import type { SourceOperation } from "@ovst/protocol";
import type { ObjectStore } from "@ovst/object-store";
import type { AlternativeBinding, Frame, LogDecision, ObjectHash } from "@ovst/merge-protocol";
import { FORMATS } from "./format-names.ts";
import type { IntentDecision } from "./intent-model.ts";
import type { RetainedStates } from "./retained-state.ts";

export type { Frame };

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

/** The rules an evaluation runs under, as the sidecar checked them. */
export interface TreeDefaultRules {
  id: "tree-default";
  revision: 1;
  config?: z.infer<typeof treeDefaultConfig>;
}

/** An authored tree evaluation, as the sidecar builds one from a question
 * `parseQuestion` checked and its rules (`Sidecar.rules`). The engine trusts
 * this shape; it checks only what a question cannot state: the trace against
 * its basis, and every operation (`checkTrace`). */
export interface IntentRequest {
  tree: string;
  /** A root and the engine state the sidecar recorded for it; a root alone
   * is imported as it stands. */
  base: { object: ObjectHash; state?: string };
  current: { object: ObjectHash; state?: string };
  incoming: {
    change: string;
    object: ObjectHash;
    /** The authored frame chain. An empty chain carries no evidence: a bare
     * resolution, or snapshot semantics. */
    trace: Frame[];
    resolves?: string[];
  };
  rules: TreeDefaultRules;
  alternatives?: AlternativeBinding[];
}

/** Every operation of a change in authored order. */
export function traceOperations(incoming: { trace: Frame[] }): SourceOperation[] {
  return incoming.trace.flatMap((frame) => frame.operations);
}

/** A failure to evaluate, not a refusal: the evaluation ran out of time
 * (`limit`), or the object store failed. Neither is a property of the
 * question, so the answer could differ on a retry. The sidecar reports it as
 * `{error}`, and no fallback inside the engine absorbs it. */
export class EvaluationFailure extends Error {
  constructor(message: string, readonly code?: "limit" | "unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "EvaluationFailure";
  }
}

/** An authored evaluation's result: the merged state, the author's own
 * state, and the decisions the result retains. The objects and states it
 * generated are in the engine's `MergeObjects`. A typed inability to evaluate
 * is thrown as a `MergeRefusal`, which the sidecar answers as it is. */
export interface IntentEvaluation {
  result: { object: string; state: string };
  authored: { object: string; state: string };
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

// ---- Checkpoints ---------------------------------------------------------

/** An accepted projection recorded onto a retained state, with the decisions
 * it keeps open as a log entry records them; never authored operations. */
export interface CheckpointRequest {
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
