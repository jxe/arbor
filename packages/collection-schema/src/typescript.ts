import type { Check, CollectionSchema } from "./compile.ts";

function render(check: Check): string {
  switch (check.kind) {
    case "text":
    case "date": return "string";
    case "bool": return "boolean";
    case "int":
    case "number": return "number";
    case "array": {
      const element = render(check.element);
      return /[ |]/.test(element) ? `Array<${element}>` : `${element}[]`;
    }
    case "choice": return [...check.values].map((value) => JSON.stringify(value)).join(" | ");
    case "map": return renderMap(check);
  }
}

function renderMap(map: Extract<Check, { kind: "map" }>): string {
  const members = map.members.map((member) => `${JSON.stringify(member.name)}${member.optional ? "?" : ""}: ${render(member.check)}${member.nullable ? " | null" : ""};`);
  if (map.open) members.push("[member: string]: unknown;");
  return members.length ? `{ ${members.join(" ")} }` : "{}";
}

/**
 * A static TypeScript declaration for one compiled schema's rows: `type
 * <name>`, an open object type whose index signature `[member: string]:
 * unknown` admits every declared member's type. Output depends only on the
 * schema source, so regeneration is byte-identical.
 */
export function collectionTypeDeclarations(schema: CollectionSchema, name: string): string {
  return `type ${name} = ${renderMap(schema.row)};`;
}
