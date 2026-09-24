import { z } from "zod";
import { decodeMaterialRef, type MaterialRef, type SourceOperation } from "@overstory/protocol";

export const OBJECT_HASH = /^sha256:[a-f0-9]{64}$/;
const hash = z.string().regex(OBJECT_HASH);
const token = z.string().min(1).max(1024);
const path = z.string().refine(
  (value) =>
    value === "/" ||
    (value.startsWith("/") &&
      value.slice(1).split("/").every((part) => part && part !== "." && part !== ".." && !/[\\\0]/.test(part)))
);
const contribution = z.object({ change: z.string(), operation: z.string().nullable() }).strict();

/** Rule evidence the worker reports beside a snapshot merge. canopyd persists
 * it, so the schema accepts no arbitrary executable output. */
export const mergeSummarySchema = z.discriminatedUnion("version", [
  z.object({ version: z.literal("markdown-additive-v1"), approximatePlacements: z.number().int().nonnegative() }).strict(),
  z.object({ version: z.literal("collection-file-rows-v1"), mergedRows: z.number().int().nonnegative() }).strict(),
]);
export type MergeSummary = z.infer<typeof mergeSummarySchema>;

// ---- Snapshot tree merge -------------------------------------------------

const projectionMaterial = z.object({ object: hash }).strict();
const rule = z.object({ id: z.string().min(1), revision: z.literal(1) }).strict();
export const projectionRequestSchema = z
  .object({ base: projectionMaterial, current: projectionMaterial, rules: rule, kind: z.literal("tree"), incoming: projectionMaterial })
  .strict();
export type ProjectionRequest = z.infer<typeof projectionRequestSchema>;

const conflictReason = z.enum([
  "node-conflict",
  "binary-conflict",
  "path-kind-conflict",
  "nested-boundary-conflict",
  "page-id-move-conflict",
  "collection-file-row-conflict",
  "collection-file-schema-conflict",
  "collection-file-constraint-conflict",
  "frontmatter-conflict",
  "invalid-markdown-fence",
]);
const projectionResponseSchema = z
  .object({
    result: projectionMaterial,
    decisions: z.array(z.object({ kind: z.literal("conflict"), path, reason: conflictReason, scope: z.enum(["entry", "directory"]) }).strict()),
    objects: z.array(hash),
    evidence: z.object({ rule, summary: mergeSummarySchema.optional() }).strict(),
  })
  .strict();
export type ProjectionResponse = z.infer<typeof projectionResponseSchema>;

// ---- Decision reports ----------------------------------------------------

/** One retained decision as canopyd needs it: the worker resolves its own
 * node identities into logical paths, so its retained state stays opaque.
 * `placement` is present when the decision has a placement; its `path` names
 * the placed file when that node still exists, and `range` is its affected
 * byte range when the node is active and the decision has no context. */
export const decisionReportSchema = z
  .object({
    key: z.string().min(1),
    kind: z.enum(["content", "placement", "existence", "directory"]),
    reason: z.string(),
    selected: z.number().int().nonnegative(),
    dependencies: z.array(z.string()),
    alternatives: z
      .array(z.object({ object: hash, state: hash, present: z.boolean(), contributions: z.array(contribution) }).strict())
      .min(2),
    subject: z.unknown().optional(),
    placement: z
      .object({
        path: path.optional(),
        range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DecisionReport = Omit<z.infer<typeof decisionReportSchema>, "subject"> & { subject?: MaterialRef };
const decisionReports = z.array(decisionReportSchema).superRefine((reports, context) => {
  if (new Set(reports.map((d) => d.key)).size !== reports.length) context.addIssue({ code: "custom", message: "Duplicate decision key" });
  for (const d of reports) {
    if (d.selected >= d.alternatives.length) context.addIssue({ code: "custom", message: "Invalid selected alternative" });
    if (d.subject !== undefined)
      try { decodeMaterialRef(d.subject); } catch { context.addIssue({ code: "custom", message: "Invalid decision subject" }); }
  }
});

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

/** A frame trace, possibly empty, marks an authored request. */
export function isIntentRequest(raw: unknown): raw is IntentRequest {
  return !!raw && typeof raw === "object" && "kind" in raw && raw.kind === "tree" &&
    "incoming" in raw && !!raw.incoming && typeof raw.incoming === "object" && "trace" in raw.incoming;
}

/** A typed inability to evaluate: neither a conflict resolution nor an
 * accepted receipt. canopyd decides admission and fallback. */
export class IntentError extends Error {
  constructor(readonly code: "invalid" | "missing-context" | "unsupported" | "limit", message: string) {
    super(message);
  }
}

const formatEvidence = z
  .object({ id: token, revision: z.literal(1), outcome: z.enum(["resolved", "unresolved"]), reason: z.string(), config: z.record(z.string(), z.unknown()) })
  .strict();
const intentResponseSchema = z
  .object({
    outcome: z.literal("evaluated"),
    result: z.object({ object: hash, state: hash }).strict(),
    authored: z.object({ object: hash, state: hash }).strict(),
    objects: z.array(hash),
    decisions: decisionReports,
    evidence: z
      .object({
        rule: z.object({ id: z.literal("tree-default"), revision: z.literal(1) }).strict(),
        inputs: z.object({ base: hash, current: hash, incoming: hash }).strict(),
        change: token,
        operations: z.array(token),
        validation: z.literal("verified"),
        formats: z.array(formatEvidence),
      })
      .strict(),
  })
  .strict();
export type IntentEvaluation = Omit<z.infer<typeof intentResponseSchema>, "decisions"> & { decisions: DecisionReport[] };
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
            alternatives: z.array(z.object({ object: hash, contributions: z.array(contribution) }).strict()).min(2),
          })
          .strict()
      )
      .default([]),
  })
  .strict();
export type CheckpointRequest = z.infer<typeof checkpointSchema>;
const checkpointResponseSchema = z
  .object({
    kind: z.literal("checkpoint"),
    result: z.object({ object: hash, state: hash }).strict(),
    authored: z.object({ object: hash, state: hash }).strict().optional(),
    objects: z.array(hash),
    decisions: decisionReports,
  })
  .strict();
export type CheckpointResponse = Omit<z.infer<typeof checkpointResponseSchema>, "decisions"> & { decisions: DecisionReport[] };

// ---- Retention audit -----------------------------------------------------

/** Walk the complete retained closure of these states in the shared store.
 * The worker owns the state format, so it owns the walk; canopyd's integrity
 * audit asks for it. At most 10,000 roots per request. */
export const MAX_AUDIT_ROOTS = 10_000;
export const retentionAuditSchema = z
  .object({ kind: z.literal("retention-audit"), roots: z.array(hash).max(MAX_AUDIT_ROOTS) })
  .strict();
export type RetentionAuditRequest = z.infer<typeof retentionAuditSchema>;
const retentionAuditResponseSchema = z
  .object({ kind: z.literal("retention-audit"), checked: z.number().int().nonnegative() })
  .strict();
export type RetentionAuditResponse = z.infer<typeof retentionAuditResponseSchema>;

// ---- The serve protocol --------------------------------------------------

export type MergeRequest = ProjectionRequest | IntentRequest | CheckpointRequest | RetentionAuditRequest;
/** The transport carries references only. Generated bytes live in staging. */
export type MergeResponse = ProjectionResponse | IntentResponse | CheckpointResponse | RetentionAuditResponse;

function parseIntentResponse(raw: unknown, request: IntentRequest): IntentEvaluation {
  if (
    raw && typeof raw === "object" && "outcome" in raw &&
    ["invalid", "missing-context", "unsupported", "limit"].includes(String(raw.outcome)) &&
    "message" in raw && typeof raw.message === "string"
  )
    throw new IntentError(raw.outcome as IntentError["code"], raw.message);
  const value = intentResponseSchema.parse(raw);
  if (
    value.authored.object !== request.incoming.object ||
    value.evidence.change !== request.incoming.change ||
    JSON.stringify(value.evidence.operations) !== JSON.stringify(traceOperations(request.incoming).map((op) => op.key)) ||
    new Set(value.objects).size !== value.objects.length
  )
    throw new Error("Intent response does not match request");
  return value as IntentEvaluation;
}

/** Check a worker response's shape and its correspondence to the request.
 * It does not look inside the worker's retained state. */
export function parseResponse(raw: unknown, request: RetentionAuditRequest): RetentionAuditResponse;
export function parseResponse(raw: unknown, request: CheckpointRequest): CheckpointResponse;
export function parseResponse(raw: unknown, request: ProjectionRequest): ProjectionResponse;
export function parseResponse(raw: unknown, request: IntentRequest): IntentEvaluation;
export function parseResponse(raw: unknown, request: MergeRequest): Exclude<MergeResponse, { outcome: IntentError["code"] }>;
export function parseResponse(raw: unknown, request: MergeRequest): Exclude<MergeResponse, { outcome: IntentError["code"] }> {
  if (request.kind === "retention-audit") {
    const value = retentionAuditResponseSchema.parse(raw);
    if (value.checked !== new Set(request.roots).size) throw new Error("Retention audit does not match request");
    return value;
  }
  if (request.kind === "checkpoint") {
    const value = checkpointResponseSchema.parse(raw);
    if (value.result.object !== request.projection && !(request.conflictProjection === "current" && value.result.object === request.current.object))
      throw new Error("Checkpoint projection mismatch");
    if (request.authored
      ? value.authored?.object !== (request.candidate ?? request.projection)
      : value.authored !== undefined)
      throw new Error("Checkpoint authored state mismatch");
    return value as CheckpointResponse;
  }
  if (isIntentRequest(request)) return parseIntentResponse(raw, request);
  const value = projectionResponseSchema.parse(raw);
  if (
    value.evidence.rule.id !== request.rules.id ||
    value.evidence.rule.revision !== request.rules.revision ||
    new Set(value.objects).size !== value.objects.length
  )
    throw new Error("Merge response does not match request");
  return value;
}
