import type { CollectionSchema } from "./compile.ts";
import { parseProfile, type ChoiceNode, type TypeNode } from "./parser.ts";

const PRELUDE_TYPES: Record<string, string> = {
  bool: "boolean", true: "true", false: "false", null: "null", nil: "null",
  tstr: "string", text: "string", int: "number", uint: "number", nint: "number", number: "number",
};

/**
 * Static TypeScript declarations for one compiled schema: `type <name>` for
 * `row` plus one alias per referenced named rule. Output depends only on the
 * schema source, so regeneration is byte-identical. An open map (`row`
 * always, and any map declaring `* tstr => any`) carries the index signature
 * `[member: string]: unknown`, which admits every declared member's type.
 */
export function collectionTypeDeclarations(schema: CollectionSchema, name: string): string {
  // Compiled schemas keep no syntax tree; the accepted source re-parses cheaply.
  const rules = new Map(parseProfile(schema.source).filter((rule) => rule.type).map((rule) => [rule.name, rule.type!]));
  const aliases = new Map<string, string>();
  const used = new Set([name]);
  const ordered: string[] = [];
  const aliasFor = (rule: string): string => {
    const existing = aliases.get(rule);
    if (existing) return existing;
    const base = `${name}_${rule.replace(/[^A-Za-z0-9_$]/g, "_")}`;
    let candidate = base;
    for (let suffix = 2; used.has(candidate); suffix += 1) candidate = `${base}_${suffix}`;
    used.add(candidate);
    aliases.set(rule, candidate);
    return candidate;
  };
  const visit = (choice: ChoiceNode): void => {
    for (const node of choice.alternatives) {
      if (node.kind === "map") for (const member of node.members) visit(member.type);
      else if (node.kind === "array") visit(node.element);
      else if (node.kind === "name" && !Object.hasOwn(PRELUDE_TYPES, node.name) && !aliases.has(node.name)) {
        aliasFor(node.name);
        visit(rules.get(node.name)!);
        ordered.push(node.name);
      }
    }
  };
  const row = rules.get("row")!;
  visit(row);

  const render = (choice: ChoiceNode): string => choice.alternatives.map(renderNode).join(" | ");
  const renderMap = (node: Extract<TypeNode, { kind: "map" }>, open: boolean): string => {
    const members = node.members.map((member) => `${JSON.stringify(member.name)}${member.optional ? "?" : ""}: ${render(member.type)};`);
    if (open) members.push("[member: string]: unknown;");
    return members.length ? `{ ${members.join(" ")} }` : "{}";
  };
  const renderNode = (node: TypeNode): string => {
    switch (node.kind) {
      case "name": return Object.hasOwn(PRELUDE_TYPES, node.name) ? PRELUDE_TYPES[node.name]! : aliases.get(node.name)!;
      case "text": return JSON.stringify(node.value);
      case "number": return String(node.value);
      case "range": return "number";
      case "array": return node.nonEmpty
        ? `[${render(node.element)}, ...Array<${render(node.element)}>]`
        : `Array<${render(node.element)}>`;
      case "map": return renderMap(node, node.open);
    }
  };
  return [
    ...ordered.map((rule) => `type ${aliases.get(rule)!} = ${render(rules.get(rule)!)};`),
    `type ${name} = ${renderMap(row.alternatives[0] as Extract<TypeNode, { kind: "map" }>, true)};`,
  ].join("\n");
}
