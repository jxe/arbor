/** Current semantic operation grammar. No backend graph or editor-local IDs cross Wire. */
export interface OperationRef { change: string; operation: string }
export type SourceRef =
  | { kind: "source"; path: string; object: string; start: number; end: number }
  | { kind: "entry"; path: string }
  | { kind: "output"; change: string; operation: string; output: string; start: number; end: number }
  | { kind: "alternative"; state: string; conflict: string; alternative: string; start: number; end: number };
export interface Lineage { source: SourceRef; start: number; end: number }
export type SourceOperation = { key: string } & (
  | { kind: "editSource"; source: SourceRef; text: string; output: string; lineage?: Lineage[] }
  | { kind: "moveSource"; source: SourceRef; at: SourceRef; side: "before" | "after" }
  | { kind: "copySource"; source: SourceRef; at: SourceRef; side: "before" | "after"; output: string }
  | { kind: "moveEntry"; source: SourceRef; destination: string }
  | { kind: "copyEntry"; source: SourceRef; destination: string; output: string }
  | { kind: "removeEntry"; source: SourceRef }
  | { kind: "editAlternative"; source: SourceRef; text: string; output: string; lineage?: Lineage[] }
  | { kind: "resolveConflict"; state: string; conflict: string; alternatives: string[]; text: string; output: string }
  | { kind: "undoOperation"; target: OperationRef }
);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
export function validOperationID(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function wellFormed(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Semantic value must be an object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new Error("Invalid semantic fields");
}
function id(value: unknown): void { if (!validOperationID(value)) throw new Error("Invalid semantic identity"); }
function state(value: unknown): void {
  if (typeof value !== "string" || !value || !wellFormed(value)) throw new Error("Invalid accepted state");
}
function path(value: unknown): void {
  if (typeof value !== "string" || !wellFormed(value) || value === "/" || !value.startsWith("/") || /[\\\0]/.test(value) || value.split("/").slice(1).some((part) => !part || part === "." || part === "..") || value !== value.normalize("NFC")) throw new Error("Invalid semantic path");
}
function range(value: Record<string, unknown>): void {
  if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || (value.start as number) < 0 || (value.end as number) < (value.start as number)) throw new Error("Invalid UTF-8 range");
}
export function decodeSourceRef(value: unknown): SourceRef {
  const v = record(value);
  switch (v.kind) {
    case "source": keys(v, ["kind", "path", "object", "start", "end"]); path(v.path); if (typeof v.object !== "string" || !/^sha256:[a-f0-9]{64}$/.test(v.object)) throw new Error("Invalid source hash"); range(v); break;
    case "entry": keys(v, ["kind", "path"]); path(v.path); break;
    case "output": keys(v, ["kind", "change", "operation", "output", "start", "end"]); id(v.change); id(v.operation); id(v.output); range(v); break;
    case "alternative": keys(v, ["kind", "state", "conflict", "alternative", "start", "end"]); state(v.state); id(v.conflict); id(v.alternative); range(v); break;
    default: throw new Error("Unknown source reference kind");
  }
  return v as unknown as SourceRef;
}
export function decodeOperations(value: unknown): SourceOperation[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || !value.length || value.length > 1024) throw new Error("operations must be null or a nonempty bounded array");
  const seen = new Set<string>();
  return value.map((raw): SourceOperation => {
    const v = record(raw);
    id(v.key);
    if (seen.has(v.key as string)) throw new Error("Duplicate operation key");
    seen.add(v.key as string);
    const fields: Record<string, string[]> = {
      editSource: ["source", "text", "output"], moveSource: ["source", "at", "side"], copySource: ["source", "at", "side", "output"],
      moveEntry: ["source", "destination"], copyEntry: ["source", "destination", "output"], removeEntry: ["source"],
      editAlternative: ["source", "text", "output"], resolveConflict: ["state", "conflict", "alternatives", "text", "output"], undoOperation: ["target"],
    };
    if (typeof v.kind !== "string" || !Object.hasOwn(fields, v.kind)) throw new Error("Unknown operation kind");
    keys(v, ["key", "kind", ...fields[v.kind]!], ["editSource", "editAlternative"].includes(v.kind) ? ["lineage"] : []);
    if (v.source !== undefined) {
      const source = decodeSourceRef(v.source);
      if (v.kind.endsWith("Entry") && source.kind !== "entry") throw new Error("Entry operation requires entry source");
      if (v.kind === "editAlternative" && source.kind !== "alternative") throw new Error("Alternative edit requires alternative source");
      if (["editSource", "moveSource", "copySource"].includes(v.kind) && !["source", "output"].includes(source.kind)) throw new Error("Source operation requires ordinary source");
    }
    if (v.at !== undefined) { if (!["source", "output"].includes(decodeSourceRef(v.at).kind)) throw new Error("Invalid insertion anchor"); }
    if (v.side !== undefined && v.side !== "before" && v.side !== "after") throw new Error("Invalid anchor side");
    if (v.destination !== undefined) path(v.destination);
    for (const field of ["output", "conflict"]) if (v[field] !== undefined) id(v[field]);
    if (v.state !== undefined) state(v.state);
    if (v.text !== undefined && (typeof v.text !== "string" || !wellFormed(v.text) || new TextEncoder().encode(v.text).length > 1024 * 1024)) throw new Error("Invalid operation text");
    if (v.target !== undefined) { const target = record(v.target); keys(target, ["change", "operation"]); id(target.change); id(target.operation); }
    if (v.alternatives !== undefined) { if (!Array.isArray(v.alternatives) || !v.alternatives.length || v.alternatives.length > 1024 || new Set(v.alternatives).size !== v.alternatives.length) throw new Error("Invalid alternatives"); v.alternatives.forEach(id); }
    if (v.lineage !== undefined) {
      if (!Array.isArray(v.lineage) || v.lineage.length > 1024) throw new Error("Invalid lineage");
      const boundaries = new Set([0]);
      let offset = 0;
      for (const scalar of v.text as string) {
        offset += new TextEncoder().encode(scalar).length;
        boundaries.add(offset);
      }
      let end = 0;
      for (const raw of v.lineage) {
        const segment = record(raw);
        keys(segment, ["source", "start", "end"]);
        const source = decodeSourceRef(segment.source);
        range(segment);
        const start = segment.start as number;
        const nextEnd = segment.end as number;
        if (source.kind === "entry" || start < end || !boundaries.has(start) || !boundaries.has(nextEnd)
          || source.end - source.start !== nextEnd - start) throw new Error("Invalid output lineage range");
        end = nextEnd;
      }
    }
    return v as unknown as SourceOperation;
  });
}
