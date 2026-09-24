import { revisionOf, type Hash } from "@overstory/protocol";
import { COLLECTION_SCHEMA_LIMITS, COLLECTION_SCHEMA_PROFILE, schemaFailure } from "./diagnostics.ts";
import { METADATA_RULES, parseProfileWithSize, type ChoiceNode, type MetadataValue, type RuleNode, type TypeNode } from "./parser.ts";

/** Runtime check graph. Rule references are shared nodes; the graph is acyclic. */
export type Check =
  | { kind: "text" }
  | { kind: "text-literal"; value: string }
  | { kind: "bool" }
  | { kind: "bool-literal"; value: boolean }
  | { kind: "null" }
  | { kind: "int"; min: number; max: number }
  | { kind: "number"; min: number; max: number; exclusiveMax: boolean }
  | { kind: "number-literal"; value: number }
  | { kind: "map"; members: CheckMember[]; byName: ReadonlyMap<string, CheckMember> }
  | { kind: "array"; element: Check; nonEmpty: boolean }
  | { kind: "choice"; alternatives: Check[]; literals: ReadonlySet<string> | null };

export interface CheckMember {
  name: string;
  optional: boolean;
  check: Check;
}

export type ValueClass = "text" | "number" | "boolean" | "null" | "map" | "array";

export type ChildNameRule =
  | { from: "primaryKey" }
  | { from: "property"; property: string };

export interface CsvColumn {
  name: string;
  optional: boolean;
  nullable: boolean;
  /** The single scalar class a cell converts to; null when the member cannot live in CSV. */
  scalar: "text" | "number" | "boolean" | null;
}

/** A compiled, immutable collection schema. Everything here derives from the exact source bytes. */
export interface CollectionSchema {
  readonly profile: typeof COLLECTION_SCHEMA_PROFILE;
  /** SHA-256 of the exact source bytes: the descriptor's `schemaFingerprint`. */
  readonly revision: Hash;
  readonly source: string;
  /** `row` members in source order. */
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[] | null;
  readonly childName: ChildNameRule;
  readonly row: Extract<Check, { kind: "map" }>;
  readonly csvColumns: readonly CsvColumn[];
  /** Syntax nodes: the compiled check graph is proportional to this, so caches weigh entries by it. */
  readonly weight: number;
}

/** Profile-supported prelude types. */
const PRELUDE: Record<string, Check> = {
  bool: { kind: "bool" },
  true: { kind: "bool-literal", value: true },
  false: { kind: "bool-literal", value: false },
  null: { kind: "null" },
  nil: { kind: "null" },
  tstr: { kind: "text" },
  text: { kind: "text" },
  int: { kind: "int", min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
  uint: { kind: "int", min: 0, max: Number.MAX_SAFE_INTEGER },
  nint: { kind: "int", min: -Number.MAX_SAFE_INTEGER, max: -1 },
  number: { kind: "number", min: -Number.MAX_VALUE, max: Number.MAX_VALUE, exclusiveMax: false },
};

/** Every RFC 8610 Appendix D prelude name; the unsupported ones reject rather than resolve. */
const RFC_PRELUDE = new Set([
  "any", "uint", "nint", "int", "bstr", "bytes", "tstr", "text", "tdate", "time", "number", "biguint",
  "bignint", "bigint", "integer", "unsigned", "decfrac", "bigfloat", "eb64url", "eb64legacy", "eb16",
  "encoded-cbor", "uri", "b64url", "b64legacy", "regexp", "mime-message", "cbor-any", "float16",
  "float32", "float64", "float16-32", "float32-64", "float", "false", "true", "bool", "nil", "null",
  "undefined",
]);

function preludeOf(name: string): Check | undefined {
  return Object.hasOwn(PRELUDE, name) ? PRELUDE[name] : undefined;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decode exact schema bytes. The fingerprint is always of these bytes, never of a parsed form. */
export function decodeSchemaSource(bytes: Uint8Array): string {
  if (bytes.byteLength > COLLECTION_SCHEMA_LIMITS["source-bytes"]) {
    throw schemaFailure("schema-too-large", `schema.cddl exceeds ${COLLECTION_SCHEMA_LIMITS["source-bytes"]} bytes`, undefined, "source-bytes");
  }
  try {
    return UTF8.decode(bytes);
  } catch {
    throw schemaFailure("invalid-utf8", "schema.cddl is not well-formed UTF-8");
  }
}

/** Parse and check one schema under profile version 1. Throws {@link CollectionSchemaError}. */
export function compileCollectionSchema(input: Uint8Array | string): CollectionSchema {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const source = decodeSchemaSource(bytes);
  const { rules: parsed, nodes } = parseProfileWithSize(source);

  const version = parsed.find((rule) => rule.name === "overstory-schema-version");
  if (!version) throw schemaFailure("missing-profile-version", "overstory-schema-version is required");
  if (version.metadata!.kind !== "int") {
    throw schemaFailure("invalid-metadata", "overstory-schema-version must be an integer literal", version.metadata!.location);
  }
  if (version.metadata!.value !== COLLECTION_SCHEMA_PROFILE) {
    throw schemaFailure("unsupported-profile-version", `Collection schema profile ${version.metadata!.value} is not supported`, version.metadata!.location);
  }

  const rules = new Map<string, ChoiceNode>();
  const metadata = new Map<string, MetadataValue>();
  const order: RuleNode[] = [];
  for (const rule of parsed) {
    if (rules.has(rule.name) || metadata.has(rule.name)) {
      throw schemaFailure("duplicate-rule", `Rule ${rule.name} is defined more than once`, rule.location);
    }
    if (RFC_PRELUDE.has(rule.name)) throw schemaFailure("reserved-rule", `${rule.name} is a prelude type`, rule.location);
    if (rule.metadata) metadata.set(rule.name, rule.metadata);
    else {
      rules.set(rule.name, rule.type!);
      order.push(rule);
    }
  }

  // References, in source order.
  for (const rule of order) walk(rule.type!, (node) => {
    if (node.kind !== "name") return;
    if (preludeOf(node.name)) return;
    if (RFC_PRELUDE.has(node.name)) throw schemaFailure("unsupported-type", `Prelude type ${node.name} is outside the collection schema profile`, node.location);
    if (METADATA_RULES.has(node.name)) throw schemaFailure("reserved-rule", `${node.name} is metadata and cannot be used as a type`, node.location);
    if (!rules.has(node.name)) throw schemaFailure("unknown-rule", `Rule ${node.name} is not defined`, node.location);
  });

  rejectCycles(order);

  const rowRule = order.find((rule) => rule.name === "row");
  if (!rowRule) throw schemaFailure("missing-row", "The rule row is required");
  const rowType = rowRule.type!;
  const rowMap = rowType.alternatives.length === 1 ? rowType.alternatives[0]! : null;
  if (!rowMap || rowMap.kind !== "map") throw schemaFailure("invalid-row", "row must be defined directly as a map", rowType.location);

  const depths = new Map<string, number>();
  const sizes = new Map<string, number>();
  const depthOf = (choice: ChoiceNode): number => {
    const alternative = (node: TypeNode): number => {
      if (node.kind === "map") return 1 + Math.max(0, ...node.members.map((member) => depthOf(member.type)));
      if (node.kind === "array") return 1 + depthOf(node.element);
      if (node.kind === "name" && rules.has(node.name)) {
        if (!depths.has(node.name)) depths.set(node.name, depthOf(rules.get(node.name)!));
        return depths.get(node.name)!;
      }
      return 0;
    };
    const deepest = Math.max(...choice.alternatives.map(alternative));
    return choice.alternatives.length > 1 ? 1 + deepest : deepest;
  };
  const cap = COLLECTION_SCHEMA_LIMITS["expanded-nodes"] + 1;
  const sizeOf = (choice: ChoiceNode): number => {
    let total = 1;
    for (const node of choice.alternatives) {
      if (node.kind === "map") {
        total += 1;
        for (const member of node.members) total += 1 + sizeOf(member.type);
      } else if (node.kind === "array") {
        total += 1 + sizeOf(node.element);
      } else if (node.kind === "name" && rules.has(node.name)) {
        if (!sizes.has(node.name)) sizes.set(node.name, sizeOf(rules.get(node.name)!));
        total += sizes.get(node.name)!;
      } else {
        total += 1;
      }
      if (total >= cap) return cap;
    }
    return Math.min(total, cap);
  };
  if (depthOf(rowType) > COLLECTION_SCHEMA_LIMITS["nesting-depth"]) {
    throw schemaFailure("budget-exceeded", `row nests deeper than ${COLLECTION_SCHEMA_LIMITS["nesting-depth"]} levels through its references`, rowRule.location, "nesting-depth");
  }
  if (sizeOf(rowType) > COLLECTION_SCHEMA_LIMITS["expanded-nodes"]) {
    throw schemaFailure("budget-exceeded", `row expands to more than ${COLLECTION_SCHEMA_LIMITS["expanded-nodes"]} type nodes`, rowRule.location, "expanded-nodes");
  }

  const members = new Map(rowMap.members.map((member) => [member.name, member]));
  const ruleClasses = new Map<string, Set<ValueClass>>();
  const classes = (choice: ChoiceNode): Set<ValueClass> => {
    const into = new Set<ValueClass>();
    for (const node of choice.alternatives) {
      if (node.kind === "map") into.add("map");
      else if (node.kind === "array") into.add("array");
      else if (node.kind === "text") into.add("text");
      else if (node.kind === "number" || node.kind === "range") into.add("number");
      else {
        const prelude = preludeOf(node.name);
        if (prelude) {
          into.add(prelude.kind === "text" ? "text" : prelude.kind === "null" ? "null"
            : prelude.kind === "bool" || prelude.kind === "bool-literal" ? "boolean" : "number");
        } else {
          if (!ruleClasses.has(node.name)) ruleClasses.set(node.name, classes(rules.get(node.name)!));
          for (const kind of ruleClasses.get(node.name)!) into.add(kind);
        }
      }
    }
    return into;
  };

  let primaryKey: string[] | null = null;
  const keyValue = metadata.get("overstory-primary-key");
  if (keyValue) {
    if (keyValue.kind !== "text-array") {
      throw schemaFailure("invalid-metadata", "overstory-primary-key must be an array of text literals", keyValue.location);
    }
    if (!keyValue.values.length || new Set(keyValue.values).size !== keyValue.values.length) {
      throw schemaFailure("invalid-primary-key", "overstory-primary-key must name one or more distinct row members", keyValue.location);
    }
    for (const field of keyValue.values) {
      const member = members.get(field);
      const kinds = member ? classes(member.type) : null;
      if (!member || member.optional || !kinds || [...kinds].some((kind) => kind !== "text" && kind !== "number" && kind !== "boolean")) {
        throw schemaFailure("invalid-primary-key", `Primary-key field ${JSON.stringify(field)} must be a required text, number, or boolean row member`, keyValue.location);
      }
    }
    primaryKey = [...keyValue.values];
  }

  let childName: ChildNameRule = { from: "primaryKey" };
  const nameValue = metadata.get("overstory-child-name");
  if (nameValue) {
    if (nameValue.kind !== "text") throw schemaFailure("invalid-metadata", "overstory-child-name must be a text literal", nameValue.location);
    const member = members.get(nameValue.value);
    const kinds = member ? classes(member.type) : null;
    if (!member || member.optional || !kinds || kinds.size !== 1 || !kinds.has("text")) {
      throw schemaFailure("invalid-child-name", `Child-name member ${JSON.stringify(nameValue.value)} must be a required text-only row member`, nameValue.location);
    }
    childName = { from: "property", property: nameValue.value };
  }

  const compiled = new Map<string, Check>();
  // Literal checks and choice keys are interned: wide literal unions repeat them.
  const literals = new Map<string, { key: string; check: Check }>();
  const literal = (value: string | number): { key: string; check: Check } => {
    const key = literalKey(value);
    let entry = literals.get(key);
    if (!entry) {
      entry = { key, check: typeof value === "string" ? { kind: "text-literal", value } : { kind: "number-literal", value } };
      literals.set(key, entry);
    }
    return entry;
  };
  const build = (choice: ChoiceNode): Check => {
    if (choice.alternatives.length > 1 && choice.alternatives.every((node) => node.kind === "text" || node.kind === "number")) {
      return {
        kind: "choice",
        alternatives: [],
        literals: new Set(choice.alternatives.map((node) => literal((node as { value: string | number }).value).key)),
      };
    }
    const alternatives = choice.alternatives.map((node): Check => {
      switch (node.kind) {
        case "text": return literal(node.value).check;
        case "number": return literal(node.value).check;
        case "range": return node.integer
          ? { kind: "int", min: node.low, max: node.inclusive ? node.high : node.high - 1 }
          : { kind: "number", min: node.low, max: node.high, exclusiveMax: !node.inclusive };
        case "map": {
          const built = node.members.map((member) => ({ name: member.name, optional: member.optional, check: build(member.type) }));
          return { kind: "map", members: built, byName: new Map(built.map((member) => [member.name, member])) };
        }
        case "array": return { kind: "array", element: build(node.element), nonEmpty: node.nonEmpty };
        case "name": {
          const prelude = preludeOf(node.name);
          if (prelude) return prelude;
          if (!compiled.has(node.name)) compiled.set(node.name, build(rules.get(node.name)!));
          return compiled.get(node.name)!;
        }
      }
    });
    if (alternatives.length === 1) return alternatives[0]!;
    return { kind: "choice", alternatives, literals: null };
  };
  const row = build(rowType) as Extract<Check, { kind: "map" }>;

  const csvColumns = rowMap.members.map((member): CsvColumn => {
    const kinds = classes(member.type);
    const nullable = kinds.delete("null");
    const scalar = kinds.size === 1 && !kinds.has("map") && !kinds.has("array")
      ? [...kinds][0] as CsvColumn["scalar"]
      : null;
    return { name: member.name, optional: member.optional, nullable, scalar };
  });

  return {
    profile: COLLECTION_SCHEMA_PROFILE,
    revision: revisionOf(bytes) as Hash,
    source,
    columns: rowMap.members.map((member) => member.name),
    primaryKey,
    childName,
    row,
    csvColumns,
    weight: nodes,
  };
}

export function literalKey(value: string | number): string {
  return typeof value === "string" ? `t:${value}` : `n:${value === 0 ? 0 : value}`;
}

function walk(choice: ChoiceNode, visit: (node: TypeNode) => void): void {
  for (const node of choice.alternatives) {
    visit(node);
    if (node.kind === "map") for (const member of node.members) walk(member.type, visit);
    else if (node.kind === "array") walk(node.element, visit);
  }
}

/** Tarjan's algorithm; reports the first rule, in source order, that lies on a cycle. */
function rejectCycles(order: RuleNode[]): void {
  const edges = new Map<string, string[]>();
  const defined = new Set(order.map((rule) => rule.name));
  for (const rule of order) {
    const targets: string[] = [];
    walk(rule.type!, (node) => { if (node.kind === "name" && defined.has(node.name)) targets.push(node.name); });
    edges.set(rule.name, targets);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cyclic = new Set<string>();
  let counter = 0;
  const connect = (name: string) => {
    index.set(name, counter);
    low.set(name, counter);
    counter += 1;
    stack.push(name);
    onStack.add(name);
    for (const target of edges.get(name)!) {
      if (target === name) cyclic.add(name);
      if (!index.has(target)) {
        connect(target);
        low.set(name, Math.min(low.get(name)!, low.get(target)!));
      } else if (onStack.has(target)) {
        low.set(name, Math.min(low.get(name)!, index.get(target)!));
      }
    }
    if (low.get(name) === index.get(name)) {
      const component: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === name) break;
      }
      if (component.length > 1) for (const member of component) cyclic.add(member);
    }
  };
  for (const rule of order) if (!index.has(rule.name)) connect(rule.name);
  const first = order.find((rule) => cyclic.has(rule.name));
  if (first) throw schemaFailure("rule-cycle", `Rule ${first.name} refers to itself`, first.location);
}

