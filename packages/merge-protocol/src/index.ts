import { z } from "zod";
import { decodeMaterialRef, stableJSONString, type MaterialRef, type SourceOperation } from "@overstory/protocol";

/** The contract between canopyd and a merge sidecar: the log entries canopyd
 * writes into the object store, the one question it asks, and the answer.
 * No merge logic lives here. */

export const OBJECT_HASH = /^sha256:[a-f0-9]{64}$/;
export type ObjectHash = string;
const hash = z.string().regex(OBJECT_HASH);
const token = z.string().min(1).max(1024);
const name = z.string().min(1).refine((part) => part !== "." && part !== ".." && !/[\\/\0]/.test(part));
const contribution = z.object({ change: z.string(), operation: z.string().nullable() }).strict();
export type Contribution = z.infer<typeof contribution>;

/** One tree-root to tree-root step of authored evidence. Basis references
 * inside a frame name objects in that frame's `before` tree; operation
 * references name an earlier key in the same change. */
export interface Frame {
  before: string;
  after: string;
  operations: SourceOperation[];
}
const frame = z.object({ before: hash, after: hash, operations: z.array(z.unknown()).max(1024) }).strict();
const trace = z.array(frame).max(64).nullable();

// ---- Log entries -----------------------------------------------------------

export const LOG_ENTRY_FORMAT = "overstory-log-entry-v1";

/** A decision open after an accepted update. Without `path` it is one choice
 * about the whole root and each alternative object is a root. With `path` and
 * no `range` it concerns that entry: each alternative object is a root whose
 * entry at `path` is that alternative's version (absent for a deletion). With
 * `range` it is a source choice about those bytes of the file at `path`
 * (`at` names that file when it is not the one in the entry's root), and each
 * alternative object is that alternative's bytes for the range. */
export interface LogDecision {
  key: string;
  path?: string[];
  range?: [number, number];
  at?: ObjectHash;
  dependencies: string[];
  selected: number;
  alternatives: Array<{ object: ObjectHash; contributions: Contribution[] }>;
}
export const logDecisionSchema = z
  .object({
    key: token,
    path: z.array(name).min(1).optional(),
    range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
    at: hash.optional(),
    dependencies: z.array(token),
    selected: z.number().int().nonnegative(),
    alternatives: z.array(z.object({ object: hash, contributions: z.array(contribution) }).strict()).min(2),
  })
  .strict()
  .superRefine((d, context) => {
    if (d.selected >= d.alternatives.length) context.addIssue({ code: "custom", message: "Invalid selected alternative" });
    if ((d.range || d.at) && !d.path) context.addIssue({ code: "custom", message: "A range choice names its file" });
    if (d.range && d.range[1] < d.range[0]) context.addIssue({ code: "custom", message: "Invalid range" });
    if (d.at && !d.range) context.addIssue({ code: "custom", message: "Only a range choice names a file object" });
    if (d.dependencies.includes(d.key)) context.addIssue({ code: "custom", message: "A decision cannot depend on itself" });
  });
const logDecisions = z.array(logDecisionSchema).superRefine((decisions, context) => {
  if (new Set(decisions.map((d) => d.key)).size !== decisions.length)
    context.addIssue({ code: "custom", message: "Duplicate decision key" });
});

/** One accepted update, stored by canopyd as a canonical JSON object. Its
 * hash is its identity; `previous` makes a tree's history a hash chain. */
export interface LogEntry {
  format: typeof LOG_ENTRY_FORMAT;
  tree: string;
  /** The entry before; null for a tree's first retained entry. */
  previous: ObjectHash | null;
  /** The accepted projection. */
  root: ObjectHash;
  change: string;
  /** The authored frames; null for a snapshot. */
  trace: Frame[] | null;
  /** Decision keys this update resolved. */
  resolves: string[];
  /** Decisions open after this update. */
  decisions: LogDecision[];
  /** How the sidecar was asked, when it was: what a replay needs, beyond the
   * fields above, to ask the same question again with `previous` as its head. */
  asked?: Asked;
  /** The sidecar's evidence, recorded and never interpreted by canopyd. */
  evidence?: unknown;
}
export interface Asked {
  /** The question's base, when it is not `previous`. */
  base?: ObjectHash;
  prefix?: Candidate[];
  /** The candidate root, when neither the trace's end nor `root`. */
  candidate?: ObjectHash;
  alternatives?: AlternativeBinding[];
  rules: MergeRules;
}
const logEntrySchema = z
  .object({
    format: z.literal(LOG_ENTRY_FORMAT),
    tree: token,
    previous: hash.nullable(),
    root: hash,
    change: token,
    trace,
    resolves: z.array(token),
    decisions: logDecisions,
    asked: z.lazy(() => askedSchema).optional(),
    evidence: z.unknown().optional(),
  })
  .strict();

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The canonical bytes of an entry (`stableJSONString`), which name it. */
export function encodeLogEntry(entry: LogEntry): Uint8Array {
  return validatedLogEntry(entry).bytes;
}

/** A checked entry and its canonical bytes, for a writer that keeps the
 * entry without decoding the bytes again. */
export function validatedLogEntry(entry: LogEntry): { entry: LogEntry; bytes: Uint8Array } {
  const valid = logEntrySchema.parse(entry) as LogEntry;
  return { entry: valid, bytes: encoder.encode(stableJSONString(valid)) };
}

/** Parse an entry's bytes. Only canonical bytes are an entry. */
export function decodeLogEntry(bytes: Uint8Array): LogEntry {
  const text = decoder.decode(bytes);
  const entry = logEntrySchema.parse(JSON.parse(text)) as LogEntry;
  if (stableJSONString(entry) !== text) throw new Error("Log entry is not canonical");
  return entry;
}

// ---- The merge question ----------------------------------------------------

/** An alternative a client's operation names as material: canopyd resolves
 * the client's public identities to the sidecar's decision key and index. */
export interface AlternativeBinding {
  ref: MaterialRef;
  decision: string;
  alternative: number;
  value: { object: ObjectHash; kind: "file" | "directory" };
}
const binding = z
  .object({
    ref: z.unknown(),
    decision: token,
    alternative: z.number().int().nonnegative(),
    value: z.object({ object: hash, kind: z.enum(["file", "directory"]) }).strict(),
  })
  .strict();

export interface Candidate {
  root: ObjectHash;
  change: string;
  trace: Frame[] | null;
  /** Decision keys whose guards canopyd checked. */
  resolves: string[];
  alternatives?: AlternativeBinding[];
}
const candidate = z
  .object({
    root: hash,
    change: token,
    trace,
    resolves: z.array(token).max(1024),
    alternatives: z.array(binding).max(1024).optional(),
  })
  .strict();

const rulesSchema = z.object({ id: token, revision: z.number().int().positive(), config: z.unknown().optional() }).strict();
const askedSchema = z
  .object({
    base: hash.optional(),
    prefix: z.array(candidate).max(64).optional(),
    candidate: hash.optional(),
    alternatives: z.array(binding).max(1024).optional(),
    rules: rulesSchema,
  })
  .strict();

export interface MergeRules { id: string; revision: number; config?: unknown }

/** The one question canopyd asks. `base` is the entry the candidate was
 * authored on, `head` the tree's current entry. `prefix` lists candidates
 * authored on `base` before this one (earlier elements of the same batch);
 * applied in order, they give the author's own basis. */
export interface MergeQuestion {
  base: ObjectHash;
  head: ObjectHash;
  prefix?: Candidate[];
  candidate: Candidate;
  rules: MergeRules;
}
export const mergeQuestionSchema = z
  .object({
    base: hash,
    head: hash,
    prefix: z.array(candidate).max(64).optional(),
    candidate,
    rules: rulesSchema,
  })
  .strict();

/** Check a question's shape and every material reference it carries. */
export function parseQuestion(raw: unknown): MergeQuestion {
  const question = mergeQuestionSchema.parse(raw) as MergeQuestion;
  for (const c of [...(question.prefix ?? []), question.candidate])
    for (const alternative of c.alternatives ?? []) {
      const ref = decodeMaterialRef(alternative.ref);
      if (ref.material.kind !== "alternative" || ref.within || ref.range)
        throw new Error("Alternative bindings require a complete alternative reference");
    }
  return question;
}

export interface MergeAnswer {
  /** The projection to accept. */
  root: ObjectHash;
  /** New objects the sidecar put into staging; everything the root and the
   * decisions name that the shared store lacks. */
  objects: ObjectHash[];
  /** Decisions open after this update. */
  decisions: LogDecision[];
  evidence: unknown;
}
const answerSchema = z
  .object({ root: hash, objects: z.array(hash), decisions: logDecisions, evidence: z.unknown() })
  .strict();

// ---- Refusals and failures -------------------------------------------------

/** A typed inability to answer: neither a conflict resolution nor an
 * accepted receipt. canopyd decides admission and fallback. */
export class MergeRefusal extends Error {
  constructor(readonly code: "invalid" | "missing-context" | "unsupported" | "limit", message: string) {
    super(message);
    this.name = "MergeRefusal";
  }
}
export const REFUSAL_CODES = ["invalid", "missing-context", "unsupported", "limit"] as const;

/** Check an answer's shape. Throws `MergeRefusal` for a refusal line. It does
 * not look inside the sidecar's reasoning. */
export function parseAnswer(raw: unknown): MergeAnswer {
  if (raw && typeof raw === "object" && "refusal" in raw) {
    const refusal = (raw as { refusal?: { code?: unknown; message?: unknown } }).refusal;
    if (refusal && REFUSAL_CODES.includes(refusal.code as never) && typeof refusal.message === "string")
      throw new MergeRefusal(refusal.code as MergeRefusal["code"], refusal.message);
    throw new Error("Invalid merge refusal");
  }
  const answer = answerSchema.parse(raw) as MergeAnswer;
  if (new Set(answer.objects).size !== answer.objects.length) throw new Error("Duplicate answer object");
  return answer;
}
