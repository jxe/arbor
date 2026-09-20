/** Shared semantic contract used by the active request codecs.
 * Transport envelopes remain governed by the existing object/delta codecs.
 */
import { canonicalCBORHash, encodeCanonicalCBOR } from "../index.ts";
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
  | { kind: "replaceEntry"; source: MaterialRef; value: { file: string } | { directory: string } | MaterialRef }
);
/** One tree-root to tree-root step of a change's authored evidence. Basis
 * references inside a frame name objects in that frame's `before` tree, and
 * operation references name an earlier key in the same change, so two traces
 * concatenate without rebasing. */
export interface AuthoredFrame { before: string; after: string; operations: AuthoredOperation[] }
/** `trace: null` is a snapshot: exact bytes with no authored evidence. A trace
 * is evidence the authority checks, never a hint it may skip: every frame must
 * reproduce its own `after`, and the last frame ends at the candidate. An empty
 * trace carries no evidence but is not a snapshot; only a resolution uses it. */
export interface AuthoredUpdateIntent {
  change: string; candidate: string; trace: AuthoredFrame[] | null;
  resolves: ResolutionDeclaration[]; ifCurrent?: string;
}
export interface AuthoredRequestIntent { base: string | null; updates: AuthoredUpdateIntent[] }
type Obj = Record<string, any>;
function require(ok: unknown): asserts ok { if (!ok) throw new Error("Invalid authored update contract"); }
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
function reference(raw: unknown, entry = false): MaterialRef {
  const v = obj(raw); keys(v, ["material"], ["within", "range"]); const m = obj(v.material);
  switch (m.kind) {
    case "basis": keys(m, ["kind", "path", "object"]); path(m.path); hash(m.object); break;
    case "operation": keys(m, ["kind", "change", "operation"]); id(m.change); id(m.operation); break;
    case "alternative": keys(m, ["kind", "state", "conflict", "alternative"]); token(m.state); id(m.conflict); id(m.alternative); break;
    default: require(false);
  }
  if (Object.hasOwn(v, "within")) { require(Array.isArray(v.within) && v.within.length > 0 && v.within.length <= 256); v.within.forEach(component); require(new TextEncoder().encode(v.within.join("/")).length <= 4096); }
  if (Object.hasOwn(v, "range")) { require(!entry); range(v.range); }
  return v as MaterialRef;
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
      else if (Object.hasOwn(value, "directory")) { keys(value, ["directory"]); hash(value.directory); }
      else { reference(value, true); }
      break;
    }
    default: require(false);
  }
  return v as AuthoredOperation;
}
export function decodeAuthoredRequestIntent(raw: unknown): AuthoredRequestIntent {
  const v = obj(raw); keys(v, ["base", "updates"]); if (v.base !== null) token(v.base);
  require(Array.isArray(v.updates) && v.updates.length > 0); const changes = new Set();
  for (const raw of v.updates) {
    const u = decodeAuthoredCandidateIntent(raw);
    require(!changes.has(u.change)); changes.add(u.change);
  }
  if (v.base === null) { const first = v.updates[0]; require(!Object.hasOwn(first, "ifCurrent") && first.resolves.length === 0); }
  return v as AuthoredRequestIntent;
}
export function authoredRequestIdentities(tree: string, request: AuthoredRequestIntent) {
  token(tree); decodeAuthoredRequestIntent(request);
  let base: unknown = request.base;
  return request.updates.map(u => {
    const intent = { domain: "arbor-update/2", tree, base, change: u.change, candidate: u.candidate,
      trace: u.trace, resolves: u.resolves, ifCurrent: u.ifCurrent ?? null };
    const bytes = encodeCanonicalCBOR(intent), digest = canonicalCBORHash(intent);
    base = { requestDigest: digest, candidate: u.candidate };
    return { bytes, digest };
  });
}

export { reference as decodeMaterialRef };

export function decodeAuthoredCandidateIntent(raw: unknown): AuthoredUpdateIntent {
  const u = obj(raw); keys(u, ["change", "candidate", "trace", "resolves"], ["ifCurrent"]);
  id(u.change); hash(u.candidate);
  if (Object.hasOwn(u, "ifCurrent")) token(u.ifCurrent);
  require(Array.isArray(u.resolves)); const decisions = new Set();
  for (const raw of u.resolves) {
    const r = obj(raw); keys(r, ["state", "conflict", "alternatives"]); token(r.state); id(r.conflict);
    require(!decisions.has(r.conflict)); decisions.add(r.conflict);
    require(Array.isArray(r.alternatives) && r.alternatives.length > 0 && new Set(r.alternatives).size === r.alternatives.length); r.alternatives.forEach(id);
  }
  if (u.trace !== null) {
    require(Array.isArray(u.trace) && u.trace.length <= 64 && (u.trace.length > 0 || u.resolves.length > 0));
    // The chain is checked here only where the request itself proves it: each
    // frame continues the previous one and the last reaches the candidate. The
    // authority binds `trace[0].before` to the basis it holds.
    const seen = new Set<string>(); let previous: string | null = null, total = 0;
    for (const raw of u.trace) {
      const f = obj(raw); keys(f, ["before", "after", "operations"]); hash(f.before); hash(f.after);
      require(Array.isArray(f.operations) && f.operations.length > 0);
      total += f.operations.length; require(total <= 1024);
      require(previous === null || previous === f.before); previous = f.after;
      // One key names one authored contribution of this change, so it is unique
      // across the whole trace and a later frame may reference an earlier one.
      for (const op of f.operations.map(operation)) { require(!seen.has(op.key)); seen.add(op.key); }
    }
    require(previous === null || previous === u.candidate);
  }
  return u as AuthoredUpdateIntent;
}
