import { z } from "zod";
import { OBJECT_HASH } from "./state-value.ts";
const hash = z.string().regex(OBJECT_HASH);
const material = z.object({ object: hash, state: hash.optional() }).strict();
/** Trusted caller supplies an accepted projection and its decisions, never authored operations. */
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
    /** Also checkpoint the author's own candidate (`candidate`, else
     * `projection`) without decisions, returned as `authored`: the basis a
     * later batch suffix continues from. One request instead of two. */
    authored: z.literal(true).optional(),
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
    authored: z.object({ object: hash, state: hash }).strict().optional(),
    objects: z.array(hash),
  })
  .strict();
export type CheckpointResponse = z.infer<typeof checkpointResponseSchema>;
