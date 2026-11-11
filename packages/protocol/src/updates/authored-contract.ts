/** Shared semantic contract used by the active request codecs.
 * Transport envelopes remain governed by the existing object/delta codecs.
 */
import { updateRequestIdentities } from "./intent.ts";
import type { JSONValue } from "../model/node-model.ts";
import { parseCanonicalStableKey } from "../model/node-key.ts";
import { pageValueFromJSON, type PageValueJSON } from "../pages.ts";
export type Material =
  | { kind: "basis"; path: string; object: string }
  | { kind: "operation"; change: string; operation: string }
  | { kind: "alternative"; state: string; conflict: string; alternative: string };
export interface MaterialRef { material: Material; within?: string[]; range?: [number, number] }
export interface EntryDestination { parent: MaterialRef; name: string }
export interface ResolutionDeclaration { state: string; conflict: string; alternatives: string[] }
export type AuthoredOperation = { key: string } & (
  | { kind: "editSource"; source: MaterialRef; text: string; lineage?: { source: MaterialRef; range: [number, number] }[] }
  | { kind: "moveSource" | "copySource"; source: MaterialRef; at: MaterialRef; side: "before" | "after" }
  | { kind: "moveEntry" | "copyEntry"; source: MaterialRef; destination: EntryDestination }
  | { kind: "removeEntry"; source: MaterialRef }
  | { kind: "replaceEntry"; source: MaterialRef; value: { file: string } | { page: string } | { directory: string } | MaterialRef }
  | { kind: "addEntry"; destination: EntryDestination; value: { file: string } | { page: string } | { directory: string } }
  | RowOperation
  | PageOperation
);
/** A scalar a many-valued field holds: a connected row's key value or a listed value. */
export type RowMember = string | number | boolean;
/** Fields every row operation carries: the collection directory (an entry
 * reference, never ranged), the model and the row's canonical stable key.
 * `at`, when the author states it, is when the edit was made (UTC ISO 8601);
 * replay writes it to the row's `created` and `modified`. */
interface RowTarget { collection: MaterialRef; model: string; row: string; at?: string }
/** A row operation's time: UTC ISO 8601 with optional fractional seconds. */
export const ROW_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
/** Row operations (spec 10 §4.1): an edit to one row of a schema'd collection,
 * named by identity, never by its bytes. */
export type RowOperation = { key: string } & RowTarget & (
  | { kind: "rowCreate"; values: Record<string, JSONValue> }
  | { kind: "rowDelete" }
  | { kind: "set"; field: string; before: JSONValue; value: JSONValue }
  | { kind: "connect" | "disconnect"; field: string; member: RowMember }
  | { kind: "move"; field: string; member: RowMember; after: RowMember | null }
);
/** Property operations on a page (spec 10 §4.1): `page` is an entry
 * reference, never ranged, to a page entry; `field` names any property but
 * `id`. Values are page values in their JSON spelling (`pageValueJSON`). */
export type PageOperation = { key: string; page: MaterialRef } & (
  | { kind: "set"; field: string; before: PageValueJSON; value: PageValueJSON }
  | { kind: "connect" | "disconnect"; field: string; member: PageValueJSON }
  | { kind: "move"; field: string; member: PageValueJSON; after: PageValueJSON | null }
);
/** A row or page property operation. */
export type PropertyOperation = RowOperation | PageOperation;
export const ROW_OPERATION_KINDS = ["rowCreate", "rowDelete", "set", "connect", "disconnect", "move"] as const;
/** Whether `operation` is a property operation, on a row or on a page. */
export function isPropertyOperation(operation: { kind: string }): operation is PropertyOperation {
  return (ROW_OPERATION_KINDS as readonly string[]).includes(operation.kind);
}
/** Whether `operation` is a property operation on a row of a collection. */
export function isRowOperation(operation: { kind: string }): operation is RowOperation {
  return isPropertyOperation(operation) && !Object.hasOwn(operation, "page");
}
/** Whether `operation` is a property operation on a page. */
export function isPageOperation(operation: { kind: string }): operation is PageOperation {
  return isPropertyOperation(operation) && Object.hasOwn(operation, "page");
}
/** One tree-root to tree-root step of a change's authored evidence. Basis
 * references inside a frame name objects in that frame's basis tree (the
 * previous frame's result, or the element's logical base), and operation
 * references name an earlier key in the same change, so two traces
 * concatenate without rebasing. Each root is optional (spec 10 §2): a stated
 * one is checked, an omitted one the authority derives. */
export interface DerivableFrame { before?: string; after?: string; operations: AuthoredOperation[] }
/** A frame with both roots stated, as an authority holds it once it has
 * derived what the author left out. */
export interface AuthoredFrame extends DerivableFrame { before: string; after: string }
/** `trace: null` is a snapshot: exact bytes with no authored evidence. A trace
 * is evidence the authority checks, never a hint it may skip: every frame must
 * reproduce each root it states, and a stated last `after` is the candidate.
 * `candidate: null` is a derived candidate (spec 10 §2.2): the last frame omits
 * `after` and the authority computes it. An empty trace carries no evidence
 * but is not a snapshot; only a resolution uses it. */
export interface DerivableUpdateIntent {
  /** When the edit was made, RFC 3339 UTC with milliseconds: it stamps the
   * entries this update creates or changes (data model §6). */
  change: string; at: string; candidate: string | null; trace: DerivableFrame[] | null;
  resolves: ResolutionDeclaration[]; ifCurrent?: string;
}
/** An update with every root stated: what a client that computes roots sends,
 * and what an authority works on once it has derived the rest. */
export interface AuthoredUpdateIntent extends DerivableUpdateIntent { candidate: string; trace: AuthoredFrame[] | null }
/** Whether `update` states every root, so it needs nothing derived. */
export function isStatedUpdate(update: DerivableUpdateIntent): update is AuthoredUpdateIntent {
  return update.candidate !== null && (update.trace ?? []).every((frame) => frame.before !== undefined && frame.after !== undefined);
}
export interface AuthoredRequestIntent { base: string | null; updates: AuthoredUpdateIntent[] }
export interface DerivableRequestIntent { base: string | null; updates: DerivableUpdateIntent[] }
type Obj = Record<string, any>;
/** An update that breaks the authored contract: retrying cannot change it. */
export class AuthoredContractError extends Error {
  constructor() { super("Invalid authored update contract"); this.name = "AuthoredContractError"; }
}
function require(ok: unknown): asserts ok { if (!ok) throw new AuthoredContractError(); }
function obj(v: unknown): Obj { require(v && typeof v === "object" && !Array.isArray(v)); return v as Obj; }
function keys(v: Obj, required: string[], optional: string[] = []) {
  require(required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => [...required, ...optional].includes(k)));
}
function text(v: unknown, max: number): asserts v is string {
  require(typeof v === "string" && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v) && new TextEncoder().encode(v).length <= max);
}
function token(v: unknown) { text(v, 1024); require(v.length); }
function id(v: unknown) { require(typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v)); }
function hash(v: unknown) { require(typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v)); }
function component(v: unknown) { text(v, 4096); require(v.length && v !== "." && v !== ".." && !/[\/\\\0]/.test(v) && v.normalize("NFC") === v); }
function path(v: unknown) { text(v, 4096); require(v.startsWith("/")); if (v !== "/") v.slice(1).split("/").forEach(component); }
function range(v: unknown): asserts v is [number, number] {
  require(Array.isArray(v) && v.length === 2 && v.every(n => Number.isSafeInteger(n) && n >= 0) && v[1] >= v[0]);
}
/** A USL model or field name. */
function name(v: unknown) { require(typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(v)); }
/** A JSON value of at most `max` UTF-8 bytes as JSON text. */
function json(v: unknown, max = 1048576) {
  const valid = (x: unknown, depth: number): boolean => depth <= 64 && (x === null || typeof x === "string" || typeof x === "boolean"
    || (typeof x === "number" && Number.isFinite(x))
    || (Array.isArray(x) && x.every((y) => valid(y, depth + 1)))
    || (!!x && typeof x === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(x)) && Object.values(x).every((y) => valid(y, depth + 1))));
  require(valid(v, 0));
  const encoded = JSON.stringify(v); text(encoded, max);
}
function member(v: unknown) { require(typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))); json(v, 4096); }
/**
 * A reference as it travels (tree operations §1.2.2): its kind is told by its
 * keys, `{ path, object }`, `{ change, operation }` or
 * `{ update, conflict, alternative }`, with `within` and `range` beside them.
 * Decoding validates that form and returns the in-memory `MaterialRef`.
 */
function reference(raw: unknown, entry = false): MaterialRef {
  const v = obj(raw); let material: Material;
  if (Object.hasOwn(v, "path")) { keys(v, ["path", "object"], ["within", "range"]); path(v.path); hash(v.object); material = { kind: "basis", path: v.path, object: v.object }; }
  else if (Object.hasOwn(v, "change")) { keys(v, ["change", "operation"], ["within", "range"]); id(v.change); id(v.operation); material = { kind: "operation", change: v.change, operation: v.operation }; }
  else if (Object.hasOwn(v, "update")) { keys(v, ["update", "conflict", "alternative"], ["within", "range"]); token(v.update); id(v.conflict); id(v.alternative); material = { kind: "alternative", state: v.update, conflict: v.conflict, alternative: v.alternative }; }
  else require(false);
  if (Object.hasOwn(v, "within")) { require(Array.isArray(v.within) && v.within.length > 0 && v.within.length <= 256); v.within.forEach(component); require(new TextEncoder().encode(v.within.join("/")).length <= 4096); }
  if (Object.hasOwn(v, "range")) { require(!entry); range(v.range); }
  return { material, ...(Object.hasOwn(v, "within") ? { within: [...v.within] } : {}), ...(Object.hasOwn(v, "range") ? { range: [v.range[0], v.range[1]] as [number, number] } : {}) };
}
/** A reference in the form it travels in. */
export type WireRef = (
  | { path: string; object: string }
  | { change: string; operation: string }
  | { update: string; conflict: string; alternative: string }
) & { within?: string[]; range?: [number, number] };
export function encodeMaterialRef(ref: MaterialRef): WireRef {
  const m = ref.material;
  const kind = m.kind === "basis" ? { path: m.path, object: m.object }
    : m.kind === "operation" ? { change: m.change, operation: m.operation }
    : { update: m.state, conflict: m.conflict, alternative: m.alternative };
  return { ...kind, ...(ref.within ? { within: ref.within } : {}), ...(ref.range ? { range: ref.range } : {}) };
}
const isEntryValue = (value: Obj) => Object.hasOwn(value, "file") || Object.hasOwn(value, "page") || Object.hasOwn(value, "directory");
/** The operation with each of its references passed through `f`. */
function mapOperationRefs(op: Obj, f: (ref: any, entry: boolean) => any): Obj {
  const out: Obj = { ...op };
  switch (op.kind) {
    case "editSource": out.source = f(op.source, false); if (op.lineage) out.lineage = op.lineage.map((l: Obj) => ({ ...l, source: f(l.source, false) })); break;
    case "moveSource": case "copySource": out.source = f(op.source, false); out.at = f(op.at, false); break;
    case "moveEntry": case "copyEntry": out.source = f(op.source, true); out.destination = { ...op.destination, parent: f(op.destination.parent, true) }; break;
    case "removeEntry": out.source = f(op.source, true); break;
    case "replaceEntry": out.source = f(op.source, true); if (!isEntryValue(op.value)) out.value = f(op.value, true); break;
    case "addEntry": out.destination = { ...op.destination, parent: f(op.destination.parent, true) }; break;
    default:
      if (Object.hasOwn(op, "page")) out.page = f(op.page, true);
      else if (Object.hasOwn(op, "collection")) out.collection = f(op.collection, true);
  }
  return out;
}
/** An operation in the form it travels in. */
export function encodeAuthoredOperation(op: AuthoredOperation): Obj {
  return mapOperationRefs(op, (ref) => encodeMaterialRef(ref));
}
/** A frame list in the form it travels in. */
export function encodeAuthoredTrace(trace: DerivableFrame[] | null): Obj[] | null {
  return trace === null ? null : trace.map((frame) => ({ ...frame, operations: frame.operations.map(encodeAuthoredOperation) }));
}
export function encodeResolutionDeclarations(resolves: ResolutionDeclaration[]): Obj[] {
  return resolves.map((r) => ({ update: r.state, conflict: r.conflict, alternatives: r.alternatives }));
}
/** A candidate's intent in the form it travels in: an absent trace or
 * `resolves` is omitted, as a sender may (tree operations §2.1). */
export function encodeAuthoredCandidateIntent(u: DerivableUpdateIntent): Obj {
  return {
    change: u.change, at: u.at, candidate: u.candidate,
    ...(u.trace !== null ? { trace: encodeAuthoredTrace(u.trace) } : {}),
    ...(u.resolves.length ? { resolves: encodeResolutionDeclarations(u.resolves) } : {}),
    ...(u.ifCurrent !== undefined ? { ifCurrent: u.ifCurrent } : {}),
  };
}
function operation(raw: unknown): AuthoredOperation {
  const v = obj(raw); id(v.key);
  switch (v.kind) {
    case "editSource": {
      keys(v, ["key", "kind", "source", "text"], ["lineage"]); reference(v.source); text(v.text, 1048576);
      if (Object.hasOwn(v, "lineage")) {
        require(Array.isArray(v.lineage) && v.lineage.length <= 1024);
        const boundaries = new Set([0]); let offset = 0, end = 0;
        for (const c of v.text) { offset += new TextEncoder().encode(c).length; boundaries.add(offset); }
        for (const raw of v.lineage) {
          const l = obj(raw); keys(l, ["source", "range"]); const source = reference(l.source); range(l.range);
          require(l.range[0] >= end && boundaries.has(l.range[0]) && boundaries.has(l.range[1]));
          if (source.range) require(source.range[1] - source.range[0] === l.range[1] - l.range[0]);
          end = l.range[1];
        }
      }
      break;
    }
    case "moveSource": case "copySource":
      keys(v, ["key", "kind", "source", "at", "side"]); reference(v.source); reference(v.at); require(["before", "after"].includes(v.side)); break;
    case "moveEntry": case "copyEntry": {
      keys(v, ["key", "kind", "source", "destination"]); reference(v.source, true);
      const d = obj(v.destination); keys(d, ["parent", "name"]); reference(d.parent, true); component(d.name); break;
    }
    case "removeEntry": keys(v, ["key", "kind", "source"]); reference(v.source, true); break;
    case "replaceEntry": {
      keys(v, ["key", "kind", "source", "value"]); reference(v.source, true); const value = obj(v.value);
      if (Object.hasOwn(value, "file")) { keys(value, ["file"]); hash(value.file); }
      else if (Object.hasOwn(value, "page")) { keys(value, ["page"]); hash(value.page); }
      else if (Object.hasOwn(value, "directory")) { keys(value, ["directory"]); hash(value.directory); }
      else { reference(value, true); }
      break;
    }
    case "addEntry": {
      keys(v, ["key", "kind", "destination", "value"]);
      const d = obj(v.destination); keys(d, ["parent", "name"]); reference(d.parent, true); component(d.name);
      const value = obj(v.value);
      if (Object.hasOwn(value, "file")) { keys(value, ["file"]); hash(value.file); }
      else if (Object.hasOwn(value, "page")) { keys(value, ["page"]); hash(value.page); }
      else { keys(value, ["directory"]); hash(value.directory); }
      break;
    }
    case "set": case "connect": case "disconnect": case "move": if (Object.hasOwn(v, "page")) {
      const fields = { set: ["field", "before", "value"], connect: ["field", "member"], disconnect: ["field", "member"], move: ["field", "member", "after"] }[v.kind as PageOperation["kind"]];
      keys(v, ["key", "kind", "page", ...fields]); reference(v.page, true);
      text(v.field, 4096); require(v.field.length && v.field !== "id" && !v.field.includes("\0"));
      for (const value of [v.before, v.value, v.member, v.after]) if (value !== undefined) { json(value); pageValueFromJSON(value); }
      if (v.kind === "move" && v.after !== null) require(JSON.stringify(v.after) !== JSON.stringify(v.member));
      break;
    } // falls through to a row target
    case "rowCreate": case "rowDelete": {
      const fields = { rowCreate: ["values"], rowDelete: [], set: ["field", "before", "value"], connect: ["field", "member"],
        disconnect: ["field", "member"], move: ["field", "member", "after"] }[v.kind as RowOperation["kind"]];
      keys(v, ["key", "kind", "collection", "model", "row", ...fields], v.kind === "rowDelete" ? [] : ["at"]); reference(v.collection, true); name(v.model);
      if (Object.hasOwn(v, "at")) require(typeof v.at === "string" && ROW_TIME.test(v.at) && Number.isFinite(Date.parse(v.at)));
      text(v.row, 4096); require(parseCanonicalStableKey(v.row) !== null);
      if (Object.hasOwn(v, "field")) name(v.field);
      if (v.kind === "rowCreate") { json(v.values); obj(v.values); Object.keys(v.values).forEach(name); }
      if (v.kind === "set") { json(v.before); json(v.value); }
      if (Object.hasOwn(v, "member")) member(v.member);
      if (v.kind === "move" && v.after !== null) { member(v.after); require(JSON.stringify(v.after) !== JSON.stringify(v.member)); }
      break;
    }
    default: require(false);
  }
  return mapOperationRefs(v, (ref, entry) => reference(ref, entry)) as AuthoredOperation;
}
export function decodeAuthoredRequestIntent(raw: unknown): DerivableRequestIntent {
  const v = obj(raw); keys(v, ["base", "updates"]); if (v.base !== null) token(v.base);
  require(Array.isArray(v.updates) && v.updates.length > 0); const changes = new Set();
  let previousAt = -Infinity;
  const updates = v.updates.map((raw: unknown) => {
    const u = decodeAuthoredCandidateIntent(raw);
    require(!changes.has(u.change)); changes.add(u.change);
    // Within one request each `at` is no earlier than the one before it.
    const at = Date.parse(u.at); require(at >= previousAt); previousAt = at;
    return u;
  });
  if (v.base === null) { const first = updates[0]!; require(first.ifCurrent === undefined && first.resolves.length === 0); }
  return { base: v.base, updates };
}
/** A validated request's per-element identities; the chain itself is `updateRequestIdentities`. */
export function authoredRequestIdentities(tree: string, request: DerivableRequestIntent) {
  token(tree); decodeAuthoredRequestIntent({ base: request.base, updates: request.updates.map(encodeAuthoredCandidateIntent) });
  return updateRequestIdentities(tree, request);
}

export { reference as decodeMaterialRef, operation as decodeAuthoredOperation };
/** A frame list as it travels, decoded to its in-memory form. */
export function decodeAuthoredTrace(frames: Obj[]): DerivableFrame[] {
  return frames.map((f) => ({ ...f, operations: obj(f).operations.map(operation) }));
}

/** Decode a candidate's intent as it travels, returning its in-memory form.
 * An omitted `trace` is null and an omitted `resolves` empty. */
export function decodeAuthoredCandidateIntent(raw: unknown): DerivableUpdateIntent {
  const given = obj(raw); keys(given, ["change", "at", "candidate"], ["trace", "resolves", "ifCurrent"]);
  const u: Obj = { trace: null, resolves: [], ...given };
  id(u.change);
  require(typeof u.at === "string" && ROW_TIME.test(u.at) && Number.isFinite(Date.parse(u.at)));
  // A derived candidate is an operation trace whose last frame omits `after`.
  if (u.candidate !== null) hash(u.candidate);
  else require(Array.isArray(u.trace) && u.trace.length > 0);
  if (Object.hasOwn(u, "ifCurrent")) token(u.ifCurrent);
  require(Array.isArray(u.resolves)); const decisions = new Set();
  for (const raw of u.resolves) {
    const r = obj(raw); keys(r, ["update", "conflict", "alternatives"]); token(r.update); id(r.conflict);
    require(!decisions.has(r.conflict)); decisions.add(r.conflict);
    require(Array.isArray(r.alternatives) && r.alternatives.length > 0 && new Set(r.alternatives).size === r.alternatives.length); r.alternatives.forEach(id);
  }
  if (u.trace !== null) {
    require(Array.isArray(u.trace) && u.trace.length <= 64 && (u.trace.length > 0 || u.resolves.length > 0));
    // The chain is checked here only where the request itself proves it: a
    // stated `before` continues a stated previous `after`, and the last frame's
    // `after` is the candidate. The authority binds the rest to the basis it holds.
    const seen = new Set<string>(); let previous: string | undefined, total = 0;
    const frames: DerivableFrame[] = [];
    for (const raw of u.trace) {
      const f = obj(raw); keys(f, ["operations"], ["before", "after"]);
      if (Object.hasOwn(f, "before")) hash(f.before);
      if (Object.hasOwn(f, "after")) hash(f.after);
      require(Array.isArray(f.operations) && f.operations.length > 0);
      total += f.operations.length; require(total <= 1024);
      require(previous === undefined || f.before === undefined || previous === f.before); previous = f.after;
      // One key names one authored contribution of this change, so it is unique
      // across the whole trace and a later frame may reference an earlier one.
      const operations = f.operations.map(operation);
      for (const op of operations) { require(!seen.has(op.key)); seen.add(op.key); }
      frames.push({ ...(Object.hasOwn(f, "before") ? { before: f.before } : {}), ...(Object.hasOwn(f, "after") ? { after: f.after } : {}), operations });
    }
    require(u.trace.length === 0 || (previous ?? null) === u.candidate);
    u.trace = frames;
  }
  return {
    change: u.change, at: u.at, candidate: u.candidate, trace: u.trace,
    resolves: u.resolves.map((r: Obj) => ({ state: r.update, conflict: r.conflict, alternatives: [...r.alternatives] })),
    ...(Object.hasOwn(u, "ifCurrent") ? { ifCurrent: u.ifCurrent } : {}),
  };
}
