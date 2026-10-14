// TypeScript declarations for a schema's rows, as its tables store them:
// what Story Sync writes to tree.gen.d.ts for a collection.

import type { Column, Table } from "./layout.ts";

const TS: Record<Column["type"], string> = {
  text: "string",
  int: "number",
  number: "number",
  bool: "boolean",
  date: "string",
  timestamp: "string",
  position: "number",
};

function tsType(column: Column): string {
  const base = column.allowed ? column.allowed.map((a) => JSON.stringify(a)).join(" | ") : TS[column.type];
  const type = column.array ? (column.allowed ? `(${base})[]` : `${base}[]`) : base;
  return column.nullable ? `${type} | null` : type;
}

const identifier = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));

export function typeDeclarations(tables: Table[]): string {
  return tables
    .map((table) => {
      const members = table.columns.map((c) => {
        const note = c.profile ? " // a Story profile id" : "";
        return `  ${identifier(c.name)}: ${tsType(c)};${note}`;
      });
      return `/** ${table.stores} */\nexport type ${table.name} = {\n${members.join("\n")}\n};\n`;
    })
    .join("\n");
}
