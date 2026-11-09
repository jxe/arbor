import { createHash } from "node:crypto";
import { z } from "zod";
import type { Hash, MutationResultReceipt, ReadPath, ResultShape, ViewAnswerForm } from "@ovst/protocol";

/** The contract between overstoryd and its execution sidecar: one handshake,
 * two questions and their answers, one JSON object per line each way. */

export const EXEC_PROTOCOL_VERSION = 2;

/** A named view or mutation: an export of a module in a tree, at a code version (07 §12.1's `HandleRef`). */
export interface ExecHandleRef {
  tree: string;
  /** The module's logical path in the tree. */
  path: string;
  /** The export. */
  name: string;
  /** The module's code version. */
  version: string;
}

/** A handle the sidecar can run, and the nodes its code names. */
export interface ExecHandle extends ExecHandleRef {
  /** Every `node()` path the handle's modules name, as logical paths in its tree. */
  sources: string[];
}

/** The sidecar's first line: who it is and what it can run. */
export interface ExecReady {
  ready: { version: number; views: ExecHandle[]; mutations: ExecHandle[] };
}

/** A collection a question may read: overstoryd's materialization of it. */
export interface ExecCollection {
  tree: string;
  path: string;
  /** Its materialization, relative to the sidecar's `--materialized` directory. */
  file: string;
  /** The accepted update the file must reflect. */
  update: string;
  /** The collection directory object at that update; mutations' row operations name it. */
  directory: string;
}

export interface ExecViewQuestion {
  id: string;
  kind: "view";
  view: ExecHandleRef;
  input?: unknown;
  /** What to answer (07 §4.1); by default a data view's value, or a JSX view's tree. */
  form?: ViewAnswerForm;
  /** Reads a client's run of a `rows` answer missed. */
  missed?: ReadPath[];
  viewer: { profile: string } | null;
  collections: ExecCollection[];
  /** An execution token for the standard API, for reading the profiles a view reaches; good while the stream that asked is open. */
  token: string;
  knownOutputHash?: Hash;
}

export interface ExecMutationQuestion {
  id: string;
  kind: "mutation";
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

export type ExecQuestion = ExecViewQuestion | ExecMutationQuestion;
/** A question before overstoryd numbers it. */
export type ExecAsk = Omit<ExecViewQuestion, "id"> | Omit<ExecMutationQuestion, "id">;

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

/** What a view's result depended on, so overstoryd knows when to ask again. */
export interface ExecReads {
  collections: Array<{ tree: string; path: string }>;
  profiles: Array<{ profile: string; tree: string; ref: string }>;
}

export type ExecViewAnswer =
  | { id: string; outputHash: Hash; value: unknown; shape?: ResultShape; reads: ExecReads }
  | { id: string; unchanged: true; reads: ExecReads }
  | { id: string; stale: true }
  | { id: string; refusal: ExecPublicError }
  | { id: string; error: { message: string; code?: "limit" | "unavailable" } };

export type ExecMutationAnswer =
  | { id: string; receipt: MutationResultReceipt }
  | { id: string; stale: true }
  | { id: string; refusal: ExecPublicError }
  | { id: string; error: { message: string; code?: "limit" | "unavailable" } };

export type ExecAnswer = ExecViewAnswer | ExecMutationAnswer;

// ---- Checking what the sidecar sends ---------------------------------------

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const handle = z.object({
  tree: z.string().min(1), path: z.string().startsWith("/"), name: z.string().min(1), version: z.string().min(1),
  sources: z.array(z.string().startsWith("/")),
}).strict();
const ready = z.object({ ready: z.object({ version: z.number().int(), views: z.array(handle), mutations: z.array(handle) }).strict() }).strict();
type Shape = { row?: { model: string; key: string }; type?: string; fields?: Record<string, Shape>; items?: Shape[] };
const shape: z.ZodType<Shape> = z.lazy(() => z.object({
  row: z.object({ model: z.string(), key: z.string() }).strict().optional(),
  type: z.string().optional(),
  fields: z.record(z.string(), shape).optional(),
  items: z.array(shape).optional(),
}).strict());
const publicError = z.object({ code: z.string().min(1), message: z.string(), retryable: z.boolean() }).strict();
const reads = z.object({
  collections: z.array(z.object({ tree: z.string(), path: z.string() }).strict()),
  profiles: z.array(z.object({ profile: z.string(), tree: z.string(), ref: z.string() }).strict()),
}).strict();
const id = z.string().min(1);
const answer = z.union([
  z.object({ id, outputHash: hash, value: z.unknown(), shape: shape.optional(), reads }).strict(),
  z.object({ id, unchanged: z.literal(true), reads }).strict(),
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

// ---- Code loaded from trees -------------------------------------------------

/** A module the host loaded from a tree for the sidecar: its files, as of a pinned root. */
export interface ExecActivation {
  tree: string;
  /** The module's logical path. */
  path: string;
  /** The root object the code was read at. */
  root: string;
  /** The code version: {@link codeVersion} of `files`. */
  version: string;
  /** Each module of its import graph, by logical path, as a file relative to the manifest's `code` directory. */
  files: Record<string, string>;
}

/** The sidecar's `--activations` file. */
export interface ExecActivations {
  /** The directory the files are under. */
  code: string;
  activations: ExecActivation[];
}

/** Packages tree code may import: the sidecar provides them. */
export const TREE_CODE_PACKAGES = ["overstory/data", "overstory/ui/jsx-runtime", "overstory/ui/jsx-dev-runtime", "zod"] as const;
/**
 * Packages a page module imports for drawing on a device. On the host they load
 * as inert stand-ins, so a module's views and mutations run there while its
 * page components can't.
 */
export const DEVICE_ONLY_PACKAGES = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "overstory/react"] as const;

const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

/** The logical paths a relative import may name, in the order they are tried; empty when it leaves the tree. */
export function importCandidates(from: string, specifier: string): string[] {
  const parts = from.split("/").filter(Boolean).slice(0, -1);
  for (const part of specifier.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return [];
      parts.pop();
    } else parts.push(part);
  }
  const path = `/${parts.join("/")}`;
  const explicit = MODULE_EXTENSIONS.some((extension) => path.endsWith(extension));
  return [
    ...(explicit ? [path] : []),
    ...MODULE_EXTENSIONS.map((extension) => `${path}${extension}`),
    ...MODULE_EXTENSIONS.map((extension) => `${path}/index${extension}`),
  ];
}

/**
 * A module's code version: SHA-256 of its import graph's files, each named by
 * logical path. Any copy of the tree with the same code has the same version,
 * whatever else changed.
 */
export function codeVersion(files: Record<string, Uint8Array>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    const bytes = files[path]!;
    hash.update(`${path}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}
