import { z } from "zod";

/** Rule evidence persisted beside an accepted merge. Worker output is
 * validated against this schema; no other summary shape is accepted. */
export const mergeSummarySchema = z.discriminatedUnion("version", [
  z.object({ version: z.literal("markdown-additive-v1"), approximatePlacements: z.number().int().nonnegative() }).strict(),
  z.object({ version: z.literal("collection-file-rows-v1"), mergedRows: z.number().int().nonnegative() }).strict(),
  z.object({ version: z.literal("account-config-v2"), mergedFields: z.number().int().nonnegative() }).strict(),
]);
export type MergeSummary = z.infer<typeof mergeSummarySchema>;
