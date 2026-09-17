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
