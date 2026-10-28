import { z } from "zod";
import type { Hash, MutationResultReceipt } from "@ovst/protocol";

/** The contract between overstoryd and its execution sidecar: one handshake,
 * two questions and their answers, one JSON object per line each way. */

export const EXEC_PROTOCOL_VERSION = 1;

/** A named query or mutation, as the code that defines it names it. */
export interface ExecHandleRef {
  module: string;
  export: string;
  version: string;
}

/** A handle the sidecar can run, and the collection it reads in a tree. */
export interface ExecHandle extends ExecHandleRef {
  /** The collection directory's path in the tree. */
  collection: string;
  /** The `node()` path the code names that collection by, such as `./data`. */
  authored: string;
}

/** The sidecar's first line: who it is and what it can run. */
export interface ExecReady {
  ready: { version: number; queries: ExecHandle[]; mutations: ExecHandle[] };
}

/** A collection a question may read: overstoryd's materialization of it. */
export interface ExecCollection {
  authored: string;
  tree: string;
  path: string;
  /** Its materialization, relative to the sidecar's `--materialized` directory. */
  file: string;
  /** The accepted update the file must reflect. */
  update: string;
  /** The collection directory object at that update; mutations' row operations name it. */
  directory: string;
}

/** A person's profile card fields, and the profile tree's root they came from. */
export interface ExecProfile {
  id: string;
  name: string;
  handle: string;
  portrait: string | null;
  bio: string | null;
  tree: string;
  ref: string;
}

export interface ExecQueryQuestion {
  id: string;
  kind: "query";
  query: ExecHandleRef;
  input?: unknown;
  viewer: { profile: string } | null;
  collections: ExecCollection[];
  /** Profiles a previous `need` asked for; null for an ID that is no profile here. */
  profiles?: Record<string, ExecProfile | null>;
  knownOutputHash?: Hash;
}

export interface ExecMutationQuestion {
  id: string;
  kind: "mutation";
  /** The tree the mutation's handle and collection belong to. */
  tree: string;
  mutation: ExecHandleRef;
  mutationID: string;
  input?: unknown;
  viewer: { profile: string } | null;
  collections: ExecCollection[];
  /** An execution token for the standard API, good for this question only. */
  token: string;
  /** The logical time for a mutation the sidecar has not started before. */
  now: string;
}

export type ExecQuestion = ExecQueryQuestion | ExecMutationQuestion;
/** A question before overstoryd numbers it. */
export type ExecAsk = Omit<ExecQueryQuestion, "id"> | Omit<ExecMutationQuestion, "id">;

/** overstoryd to sidecar: the client went away. */
export interface ExecCancel {
  cancel: string;
}

/** An error the caller may see: a stable code and a safe message. */
export interface ExecPublicError {
  code: string;
  message: string;
  retryable: boolean;
}

/** What a query's result depended on, so overstoryd knows when to ask again. */
export interface ExecReads {
  collections: Array<{ tree: string; path: string }>;
  profiles: Array<{ profile: string; tree: string; ref: string }>;
}

export type ExecQueryAnswer =
  | { id: string; outputHash: Hash; value: unknown; reads: ExecReads }
  | { id: string; unchanged: true; reads: ExecReads }
  | { id: string; need: { profiles: string[] } }
  | { id: string; stale: true }
  | { id: string; refusal: ExecPublicError }
  | { id: string; error: { message: string; code?: "limit" | "unavailable" } };

export type ExecMutationAnswer =
  | { id: string; receipt: MutationResultReceipt }
  | { id: string; stale: true }
  | { id: string; refusal: ExecPublicError }
  | { id: string; error: { message: string; code?: "limit" | "unavailable" } };

export type ExecAnswer = ExecQueryAnswer | ExecMutationAnswer;

// ---- Checking what the sidecar sends ---------------------------------------

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const handle = z.object({
  module: z.string().min(1), export: z.string().min(1), version: z.string().min(1),
  collection: z.string().startsWith("/"), authored: z.string().min(1),
}).strict();
const ready = z.object({ ready: z.object({ version: z.number().int(), queries: z.array(handle), mutations: z.array(handle) }).strict() }).strict();
const publicError = z.object({ code: z.string().min(1), message: z.string(), retryable: z.boolean() }).strict();
const reads = z.object({
  collections: z.array(z.object({ tree: z.string(), path: z.string() }).strict()),
  profiles: z.array(z.object({ profile: z.string(), tree: z.string(), ref: z.string() }).strict()),
}).strict();
const id = z.string().min(1);
const answer = z.union([
  z.object({ id, outputHash: hash, value: z.unknown(), reads }).strict(),
  z.object({ id, unchanged: z.literal(true), reads }).strict(),
  z.object({ id, need: z.object({ profiles: z.array(z.string()).min(1).max(1000) }).strict() }).strict(),
  z.object({ id, stale: z.literal(true) }).strict(),
  z.object({ id, refusal: publicError }).strict(),
  z.object({ id, error: z.object({ message: z.string(), code: z.enum(["limit", "unavailable"]).optional() }).strict() }).strict(),
  z.object({ id, receipt: z.object({ mutationID: z.string(), requestDigest: hash, observedThrough: z.string(), result: z.unknown() }).strict() }).strict(),
]);

/** The handshake line, or null when the line is not one. */
export function parseExecReady(value: unknown): ExecReady | null {
  const parsed = ready.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** An answer line, or null when the line is not a well-formed answer. */
export function parseExecAnswer(value: unknown): ExecAnswer | null {
  const parsed = answer.safeParse(value);
  return parsed.success ? parsed.data as ExecAnswer : null;
}
