import { z } from "zod";
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const material = z.object({ object: hash, state: hash.optional() }).strict();
/** Trusted caller supplies accepted projection/legacy decisions, never authored operations. */
export const checkpointSchema = z
  .object({
    kind: z.literal("checkpoint"),
    tree: z.string().min(1),
    current: material,
    projection: hash,
    candidate: hash.optional(),
    continueSelected: z.boolean().optional(),
    conflictProjection: z.enum(["current", "incoming"]).optional(),
    change: z.string().min(1),
    resolves: z.array(z.string()).optional(),
    decisions: z
      .array(
        z
          .object({
            key: z.string().min(1),
            path: z.array(z.string()).optional(),
            dependencies: z.array(z.string()).optional(),
            selected: z.number().int().nonnegative(),
            alternatives: z
              .array(
                z
                  .object({
                    object: hash,
                    contributions: z.array(
                      z
                        .object({
                          change: z.string(),
                          operation: z.string().nullable(),
                        })
                        .strict()
                    ),
                  })
                  .strict()
              )
              .min(2),
          })
          .strict()
      )
      .default([]),
  })
  .strict();
export type CheckpointRequest = z.infer<typeof checkpointSchema>;
export const checkpointResponseSchema = z
  .object({
    kind: z.literal("checkpoint"),
    result: z.object({ object: hash, state: hash }).strict(),
    objects: z.array(hash),
  })
  .strict();
export type CheckpointResponse = z.infer<typeof checkpointResponseSchema>;

/** A bounded linear slice of already-accepted history; no authored execution. */
export const MAX_CHECKPOINT_BATCH = 64;
export const CHECKPOINT_BATCH_TOO_LARGE_EXIT = 75;
export const checkpointBatchSchema = z.object({
  kind: z.literal("checkpoint-batch"),
  tree: z.string().min(1),
  current: material,
  steps: z.array(checkpointSchema.pick({ projection: true, change: true, decisions: true }))
    .min(1).max(MAX_CHECKPOINT_BATCH),
}).strict();
export type CheckpointBatchRequest = z.infer<typeof checkpointBatchSchema>;
export const checkpointBatchResponseSchema = z.object({
  kind: z.literal("checkpoint-batch"),
  result: z.object({ object: hash, state: hash }).strict(),
  checkpoints: z.array(z.object({ object: hash, state: hash }).strict()).min(1).max(MAX_CHECKPOINT_BATCH),
  objects: z.array(hash),
}).strict();
export type CheckpointBatchResponse = z.infer<typeof checkpointBatchResponseSchema>;
