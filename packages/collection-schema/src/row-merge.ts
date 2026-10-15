import { stableJSONString, type JSONValue } from "@ovst/protocol";
import type { CollectionSchema } from "./compile.ts";
import { canonicalRow } from "./row-replay.ts";

type Row = Record<string, JSONValue>;

/** Two sides changed one field (or, with `field: null`, one side deleted a
 * row the other changed) to different values. `current` is the value kept;
 * null is absent. */
export interface RowFieldConflict {
  row: string;
  field: string | null;
  current: JSONValue;
  candidate: JSONValue;
}

/** Merge three versions of one text; null when they cannot be merged. */
export type TextMerge = (base: string, candidate: string, current: string) => string | null;

const json = (value: unknown) => stableJSONString(value ?? null);
const same = (left: unknown, right: unknown) => json(left) === json(right);

/** Whether time `a` is after `b`, by instant and then by text. */
const later = (a: string, b: string) => {
  const [x, y] = [Date.parse(a), Date.parse(b)];
  return x !== y ? x > y : a > b;
};

function list(value: JSONValue | undefined): JSONValue[] | null {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : null;
}

/** Members in `order`, as their JSON, keeping only those in `keep`. */
const relative = (order: JSONValue[], keep: Set<string>) => order.map(json).filter((m) => keep.has(m));

/** Merge a many-valued field member by member; null on an order conflict. */
function mergeMembers(base: JSONValue[], candidate: JSONValue[], current: JSONValue[], ordered: boolean): JSONValue[] | null {
  const b = new Set(base.map(json)), c = new Set(candidate.map(json)), u = new Set(current.map(json));
  const value = new Map([...base, ...candidate, ...current].map((m) => [json(m), m]));
  const removed = new Set([...b].filter((m) => !c.has(m) || !u.has(m)));
  const kept = new Set([...u, ...c].filter((m) => !removed.has(m)));
  const common = new Set([...b].filter((m) => c.has(m) && u.has(m)));
  const baseOrder = relative(base, common).join(), candidateOrder = relative(candidate, common).join(), currentOrder = relative(current, common).join();
  const candidateMoved = ordered && candidateOrder !== baseOrder, currentMoved = ordered && currentOrder !== baseOrder;
  if (candidateMoved && currentMoved && candidateOrder !== currentOrder) return null;
  // The side whose order wins, and the other side's additions placed after
  // the member they follow there (or first).
  const [lead, other] = candidateMoved ? [candidate, current] : [current, candidate];
  const result = lead.map(json).filter((m) => kept.has(m));
  const placed = new Set(result);
  const others = other.map(json);
  for (const [index, member] of others.entries()) {
    if (placed.has(member) || !kept.has(member)) continue;
    if (!ordered) { result.push(member); placed.add(member); continue; }
    const previous = others.slice(0, index).reverse().find((m) => placed.has(m));
    result.splice(previous === undefined ? 0 : result.indexOf(previous) + 1, 0, member);
    placed.add(member);
  }
  return result.map((m) => value.get(m)!);
}

/** Merge one row both sides changed, field by field. */
function mergeRow(
  schema: CollectionSchema,
  key: string,
  base: Row,
  candidate: Row,
  current: Row,
  text: TextMerge | undefined,
  conflicts: RowFieldConflict[],
): Row {
  const row: Row = {};
  for (const field of new Set([...Object.keys(current), ...Object.keys(candidate), ...Object.keys(base)])) {
    const b = base[field], c = candidate[field], u = current[field];
    let value: JSONValue | undefined;
    // Times never conflict: `created` keeps current's, `modified` the later.
    if (field === "created") value = u ?? c;
    else if (field === "modified") value = typeof c === "string" && typeof u === "string" ? (later(c, u) ? c : u) : u ?? c;
    else if (same(c, u) || same(c, b)) value = u;
    else if (same(u, b)) value = c;
    else {
      const kind = schema.merge.get(field);
      const lists = [list(b), list(c), list(u)];
      let merged: JSONValue | undefined | null = null;
      if ((kind === "many" || kind === "ordered") && lists.every((l) => l !== null)) {
        const members = mergeMembers(lists[0]!, lists[1]!, lists[2]!, kind === "ordered");
        merged = members === null ? null : members.length ? members : undefined;
      } else if (kind === "markdown" && [b ?? "", c ?? "", u ?? ""].every((v) => typeof v === "string")) {
        merged = text?.((b ?? "") as string, (c ?? "") as string, (u ?? "") as string) ?? null;
      }
      if (merged === null) {
        conflicts.push({ row: key, field, current: u ?? null, candidate: c ?? null });
        value = u;
      } else value = merged;
    }
    if (value !== undefined) row[field] = value;
  }
  return canonicalRow(schema, row);
}

/**
 * `collection-file-fields-v1` (spec 10 §7): merge two changes to a
 * collection's rows by row identity, then member by member. A row only one
 * side changed takes that side; a row both changed merges field by field:
 * a single value conflicts only when the two set different values,
 * many-valued fields merge per member (and `@ordered` ones as a sequence),
 * and Markdown merges by lines. Deleting a row conflicts only with a
 * concurrent change to it. Each conflict keeps current's value.
 */
export function mergeCollectionRows(
  schema: CollectionSchema,
  base: ReadonlyMap<string, Row>,
  candidate: ReadonlyMap<string, Row>,
  current: ReadonlyMap<string, Row>,
  text?: TextMerge,
): { rows: Map<string, Row | null>; conflicts: RowFieldConflict[]; mergedRows: number } {
  const rows = new Map<string, Row | null>();
  const conflicts: RowFieldConflict[] = [];
  let mergedRows = 0;
  for (const key of new Set([...current.keys(), ...candidate.keys(), ...base.keys()])) {
    const b = base.get(key), c = candidate.get(key), u = current.get(key);
    if (same(c, u) || same(c, b)) { rows.set(key, u ?? null); continue; }
    if (same(u, b)) { rows.set(key, c ?? null); mergedRows++; continue; }
    if (!c || !u) {
      // Deleted on one side and changed on the other: keep current's.
      conflicts.push({ row: key, field: null, current: u ?? null, candidate: c ?? null });
      rows.set(key, u ?? null);
      continue;
    }
    rows.set(key, mergeRow(schema, key, b ?? {}, c, u, text, conflicts));
    mergedRows++;
  }
  return { rows, conflicts, mergedRows };
}
