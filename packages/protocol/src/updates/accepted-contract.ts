/**
 * Structural checks for accepted reads beyond the codecs in `json.ts`: the
 * accepted-state grammar, accepted chains, watch batches and conflict
 * inspection pages. Each payload is decoded and hash-verified once, by the
 * transition decoder; nothing here decodes it again.
 */
import { decodeAcceptedTransitionJSON } from "./json.ts";
import { decodeMaterialRef, type MaterialRef, type EntryDestination } from "./authored-contract.ts";
import type { AcceptedTransition, AcceptedUpdate } from "./types.ts";
export interface StateLink { id: string; root: string }
export interface Contribution { change: string; operation: string | null }
export interface InspectedAlternative {
  id: string; revision: string;
  value: { text: string } | { file: string } | { directory: string } | { tree: string } | { absent: true };
  placement?: EntryDestination; contributions: Contribution[];
}
export interface InspectedDecision {
  id: string; kind: string; affected: MaterialRef[]; selected: string;
  alternatives: InspectedAlternative[]; dependencies: string[]; actions: string[];
}
export interface DecisionPage {
  tree: string; state: string; root: string; conflicted: boolean;
  decisions: InspectedDecision[]; next: string | null;
}
type Obj = Record<string, any>;
function check(ok: unknown): asserts ok { if (!ok) throw new Error("Invalid accepted-state contract"); }
function obj(v: unknown): Obj { check(v && typeof v === "object" && !Array.isArray(v)); return v as Obj; }
function required(v: Obj, fields: string[]) { check(fields.every(k => Object.hasOwn(v,k))); }
function str(v: unknown): asserts v is string { check(typeof v === "string" && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)); }
function token(v: unknown) { str(v); check(v.length > 0 && new TextEncoder().encode(v).length <= 1024); }
function id(v: unknown) { check(typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v)); }
function hash(v: unknown) { check(typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v)); }
function ids(v: unknown, nonempty = false) { check(Array.isArray(v) && (!nonempty || v.length > 0) && new Set(v).size === v.length); v.forEach(id); }
function contributionList(raw: unknown) {
  check(Array.isArray(raw)); const seen = new Set();
  for (const x of raw) { const v=obj(x); required(v,["change","operation"]); id(v.change); if(v.operation !== null) id(v.operation);
    const key=JSON.stringify([v.change,v.operation]); check(!seen.has(key)); seen.add(key); }
}
function page(raw: unknown, field: string): Obj {
  const v=obj(raw); required(v,["tree","state",field,"next"]); token(v.tree); token(v.state);
  check(Array.isArray(v[field])); if(v.next !== null) { token(v.next); check(v[field].length>0); }
  return v;
}
export function decodeAcceptedUpdate(raw: unknown): AcceptedUpdate {
  const v=obj(raw); required(v,["id","tree","root","previous","acceptedAt","subject","conflicted"]);
  token(v.id); token(v.tree); hash(v.root); check(Number.isSafeInteger(v.acceptedAt) && v.acceptedAt >= 0);
  if(v.subject !== null) token(v.subject); check(typeof v.conflicted === "boolean");
  if(v.previous !== null) { const p=obj(v.previous); required(p,["id","root"]); token(p.id); hash(p.root); check(p.id!==v.id); }
  return v as AcceptedUpdate;
}
export function validateAcceptedChain(tree: string, previous: StateLink | null, updates: AcceptedUpdate[], head: StateLink) {
  token(tree); check(updates.length>0); const seen=new Set(previous ? [previous.id] : []);
  for(const raw of updates) {
    const u=decodeAcceptedUpdate(raw); check(u.tree===tree && !seen.has(u.id)); seen.add(u.id);
    check(previous===null ? u.previous===null : u.previous!==null && u.previous.id===previous.id && u.previous.root===previous.root);
    previous={id:u.id,root:u.root};
  }
  check(previous!.id===head.id && previous!.root===head.root);
}
export function decodeDecisionPage(raw: unknown, context?: {tree:string;state:string;root:string}): DecisionPage {
  const v=page(raw,"decisions"); required(v,["root","conflicted"]); hash(v.root); check(typeof v.conflicted==="boolean");
  if(context) check(v.tree===context.tree && v.state===context.state && v.root===context.root);
  if(!v.conflicted) check(v.decisions.length===0 && v.next===null);
  const seen=new Set();
  for(const raw of v.decisions) {
    const d=obj(raw); required(d,["id","kind","affected","selected","alternatives","dependencies","actions"]);
    id(d.id); check(!seen.has(d.id)); seen.add(d.id); token(d.kind); id(d.selected);
    check(Array.isArray(d.affected) && d.affected.length>0); d.affected.forEach((r:unknown)=>decodeMaterialRef(r));
    ids(d.dependencies); check(!d.dependencies.includes(d.id)); ids(d.actions);
    check(Array.isArray(d.alternatives) && d.alternatives.length>=2); const alternatives=new Set();
    for(const raw of d.alternatives) {
      const a=obj(raw); required(a,["id","revision","value","contributions"]); id(a.id); id(a.revision);
      check(!alternatives.has(a.id)); alternatives.add(a.id); contributionList(a.contributions);
      const value=obj(a.value), ks=Object.keys(value); check(ks.length===1);
      switch(ks[0]) {
        case "text": str(value.text); break;
        case "file": hash(value.file); break;
        case "directory": hash(value.directory); break;
        case "tree": token(value.tree); break;
        case "absent": check(value.absent===true); break;
        default: check(false);
      }
      if(Object.hasOwn(a,"placement")) {
        check(["file","directory","tree"].includes(ks[0]!)); const p=obj(a.placement); required(p,["parent","name"]);
        decodeMaterialRef(p.parent,true);
        // Reuse the path-component grammar of material selectors.
        decodeMaterialRef({material:{kind:"basis",path:"/",object:v.root},within:[p.name]});
      }
    }
    check(alternatives.has(d.selected));
  }
  return v as DecisionPage;
}
/** A tree watch's `tree.update` change: its descriptor and a contiguous, verified transition batch. */
/** A `tree.update` frame's data: one transition, and the access and canonical placement the client's new descriptor takes. */
export interface AcceptedWatchChange<Canonical = unknown> {
  transition: AcceptedTransition;
  access: "read" | "write";
  canonical: Canonical | null;
}
/** The caller must deduplicate observation replay before checking its confirmed basis.
 * A cursor is never compared to an accepted ID. Descriptor policy fields are
 * validated by the tree descriptor decoder; this checks the accepted-state binding.
 */
export function decodeTransitionBasis(raw: unknown, update: AcceptedUpdate): StateLink {
  const p=obj(raw); required(p,["id","root"]); token(p.id); hash(p.root); check(p.id!==update.id);
  return p as StateLink;
}
/** Decode one `tree.update` frame's data for the watched `tree`: exactly one
 * transition, whose transport basis (`from`, else `update.previous`) is
 * `basis` when the caller knows its confirmed state. */
export function decodeAcceptedWatchChange<Canonical = unknown>(
  raw: unknown, tree: string, basis?: StateLink,
): AcceptedWatchChange<Canonical> {
  const v=obj(raw); required(v,["transition","access","canonical"]);
  check(v.access==="read" || v.access==="write"); check(v.canonical===null || (typeof v.canonical==="object" && !Array.isArray(v.canonical)));
  token(tree); required(obj(v.transition),["update","objects","deltas"]);
  const transition=decodeAcceptedTransitionJSON(v.transition);
  const update=transition.from ? {...transition.update, previous: transition.from} : transition.update;
  validateAcceptedChain(tree,basis ?? update.previous,[update],{id:update.id,root:update.root});
  return { transition, access: v.access, canonical: v.canonical as Canonical | null };
}
