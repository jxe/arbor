#!/usr/bin/env bun
// One-off: rewrites a collection's schema.usl as schema.beetle (spec 1.5 §5).
//
//   bun tools/convert-usl-to-beetle.ts <schema.usl>... [--write] [--check]
//
// Prints each converted file, or with --write puts a schema.beetle beside each
// schema.usl (the .usl file is left for you to delete). --check only verifies.
// Every conversion is verified: the Beetle must compile to the same model layer,
// table layout and fingerprint as the USL did, or nothing is written.
//
// Comments are kept: one on its own line goes before the item after it, one at
// the end of a line stays on that line. `~views` stays a table attribute, which
// Beetle still accepts. USL `view "Label" of …` declarations have no Beetle form and
// stop the conversion.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compileUsl, layoutOf, modelLayer, type ResolvedModel } from "@ovst/usl";
import { parseUslForFormat, type Comment } from "../packages/usl/src/parse.ts";
import type * as Usl from "@ovst/usl";
import { compileSchema, formatView } from "@ovst/beetle";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Out {
  text: string;
  /** The source line it came from, for placing comments. */
  line: number | null;
  indent: string;
}

function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

const name = (text: string) => (IDENT.test(text) ? text : quote(text));
const arity = (a: Usl.Arity) => (a === "many" ? "[]" : a === "optional" ? "?" : "");

function expr(e: Usl.Expr): string {
  switch (e.kind) {
    case "string": return quote(e.value);
    case "number": return String(e.value);
    case "ident": return [e.name, ...e.attrs.map(attribute)].join(" ");
    case "list": return `[${e.items.map(expr).join(", ")}]`;
    case "object": return record(e.entries);
  }
}

function record(entries: Usl.ObjectEntry[]): string {
  return entries.length === 0 ? "{}" : `{ ${entries.map((x) => `${name(x.key)}: ${expr(x.value)}`).join(", ")} }`;
}

function attribute(a: Pick<Usl.Attribute, "sigil" | "name" | "args">): string {
  return `${a.sigil}${a.name}${a.args.length > 0 ? `(${a.args.map(expr).join(", ")})` : ""}`;
}

const attrs = (list: Usl.Attribute[]) => list.map((a) => " " + attribute(a)).join("");

function end(e: Usl.EndDecl): string {
  return `${e.ordered ? "ordered " : ""}${e.model}.${e.field}${arity(e.arity)}${e.as ? ` as ${e.as.name}` : ""}${attrs(e.attrs)}`;
}

function row(r: Usl.Row): string {
  return `${name(r.name)}${r.values.length > 0 ? " " + record(r.values) : ""}${attrs(r.attrs)}`;
}

function members(list: Usl.Member[], indent: string, out: Out[]): void {
  for (const m of list) {
    const line = m.at.line;
    switch (m.kind) {
      case "field":
        out.push({ text: `${m.name} ${m.modifiers.map((x) => x.name + " ").join("")}${m.type}${arity(m.arity)}${attrs(m.attrs)}`, line, indent });
        break;
      case "end":
        out.push({ text: end(m), line, indent });
        break;
      case "modelAttribute":
        out.push({ text: attribute(m), line, indent });
        break;
      case "mention":
        out.push({ text: `${name(m.name)}${attrs(m.attrs)}`, line, indent });
        break;
      case "rows":
        if (m.mode === "seed") out.push({ text: "seed:", line, indent });
        for (const r of m.rows) out.push({ text: row(r), line: r.at.line, indent: m.mode === "seed" ? indent + "  " : indent });
        break;
    }
  }
}

/**
 * Colors are data in Beetle (spec 1.5 §2): an enum value's `~color("#…")` becomes its record's
 * `color`, under a `color Text` field the enum gains, and a table's `color Text ~color` field
 * loses the attribute. Changes the file in place; true when it moved any.
 */
function moveColors(file: Usl.SchemaFile): boolean {
  let moved = false;
  const isColor = (a: Usl.Attribute) => a.sigil === "~" && a.name === "color";
  const models = new Map(file.declarations.flatMap((d) => (d.kind === "model" ? [[d.name, d] as const] : [])));
  const colorOf = (attrs: Usl.Attribute[]) => {
    const a = attrs.find(isColor)?.args[0];
    return a?.kind === "string" ? a.value : undefined;
  };
  // Value colors, wherever they were written: in the enum, or in a `re` block naming the value.
  const valueColors = new Map<string, Map<string, string>>();
  for (const d of file.declarations) {
    if (d.kind !== "model" && d.kind !== "re") continue;
    const model = models.get(d.name);
    for (const m of d.members) {
      if (m.kind === "rows" && m.mode === "fixed") {
        for (const r of m.rows) {
          const color = colorOf(r.attrs);
          if (color !== undefined) valueColors.set(d.name, (valueColors.get(d.name) ?? new Map()).set(r.name, color));
        }
      }
      if (m.kind === "mention" && model?.form === "enum") {
        const color = colorOf(m.attrs);
        if (color !== undefined) valueColors.set(d.name, (valueColors.get(d.name) ?? new Map()).set(m.name, color));
      }
    }
  }
  // Fields colored with `~color`, wherever written; they must already be `color Text`.
  const fieldColored = new Set<string>();
  for (const d of file.declarations) {
    if (d.kind !== "model" && d.kind !== "re") continue;
    for (const m of d.members) {
      if ((m.kind === "field" || m.kind === "mention") && models.get(d.name)?.form !== "enum" && m.attrs.some(isColor)) fieldColored.add(`${d.name}.${m.name}`);
    }
  }
  for (const key of fieldColored) {
    const [model, field] = key.split(".") as [string, string];
    const decl = models.get(model)?.members.find((m): m is Usl.FieldDecl => m.kind === "field" && m.name === field);
    if (field !== "color" || decl?.type !== "Text" || decl.arity === "many") {
      throw new Error(`${model}.${field} is colored with ~color; Beetle reads a row's color from a \`color Text\` field, so rename it first`);
    }
  }
  // Strip every `~color`, dropping `re` mentions left with no attributes.
  for (const d of file.declarations) {
    if (d.kind !== "model" && d.kind !== "re") continue;
    for (const m of d.members) {
      if (m.kind === "field" || m.kind === "mention" || m.kind === "end") {
        if (m.attrs.some(isColor)) moved = true;
        m.attrs = m.attrs.filter((a) => !isColor(a));
      }
      if (m.kind === "rows") for (const r of m.rows) {
        if (r.attrs.some(isColor)) moved = true;
        r.attrs = r.attrs.filter((a) => !isColor(a));
      }
    }
    d.members = d.members.filter((m) => m.kind !== "mention" || m.attrs.length > 0);
  }
  file.declarations = file.declarations.filter((d) => d.kind !== "re" || d.members.length > 0);
  for (const [name, colors] of valueColors) {
    const decl = models.get(name)!;
    if (decl.members.some((m) => m.kind === "field" && m.name === "color")) throw new Error(`enum ${name} already has a color field`);
    const rows = decl.members.flatMap((m) => (m.kind === "rows" ? m.rows : []));
    const at = decl.at;
    const every = rows.every((r) => colors.has(r.name));
    decl.members.unshift({ kind: "field", name: "color", modifiers: [], type: "Text", arity: every ? "one" : "optional", attrs: [], at });
    for (const r of rows) {
      const color = colors.get(r.name);
      if (color !== undefined) r.values = [...r.values.filter((v) => v.key !== "color"), { key: "color", value: { kind: "string", value: color, at: r.at }, at: r.at }];
    }
  }
  return moved;
}

/** True when converting `source` moves colors into data, which changes its model fingerprint. */
export function movesColors(source: string): boolean {
  const parsed = parseUslForFormat(source);
  return parsed.file ? moveColors(parsed.file) : false;
}

/** The Beetle text of a USL schema, before formatting. Throws for what Beetle can't say. */
export function convert(source: string): string {
  const parsed = parseUslForFormat(source);
  if (!parsed.file) throw new Error(parsed.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`).join("\n"));
  moveColors(parsed.file);
  const out: Out[] = [];
  for (const d of parsed.file.declarations) {
    const line = d.at.line;
    switch (d.kind) {
      case "model": {
        const key = d.key ? ` (${d.key.fields.map((f) => f.name).join(", ")})` : "";
        const header = d.form === "enum" ? `enum ${d.name}:` : `${d.main ? "main " : ""}table ${d.name}${key}:`;
        out.push({ text: header, line: d.main?.line ?? line, indent: "" });
        members(d.members, "  ", out);
        break;
      }
      case "re":
        out.push({ text: `re ${d.name}:`, line, indent: "" });
        members(d.members, "  ", out);
        break;
      case "connection": {
        const ends = d.members.filter((m): m is Usl.EndDecl => m.kind === "end");
        if (ends.length !== 2 || d.members.length !== 2) throw new Error(`${line}: a connection with other than two ends has no Beetle form`);
        out.push({ text: `${end(ends[0]!)} <-> ${end(ends[1]!)}`, line, indent: "" });
        break;
      }
      case "view":
        throw new Error(`${line}: \`view ${quote(d.label)} of ${d.of}\` has no Beetle form; write a view over <Rows> instead`);
    }
  }
  return place(out, parsed.comments, source.split("\n"));
}

/** Puts comments back, and a blank line wherever the source had one between items. */
function place(out: Out[], comments: Comment[], lines: string[]): string {
  const trailing = new Map<number, string>();
  const own = comments.filter((c) => c.own);
  for (const c of comments) if (!c.own) trailing.set(c.line, c.text);
  const result: string[] = [];
  const used = new Set<number>();
  let last = 0;
  const blankBetween = (a: number, b: number) => {
    for (let l = a + 1; l < b; l++) if ((lines[l - 1] ?? "").trim() === "") return true;
    return false;
  };
  const emit = (text: string, line: number, indent: string) => {
    if (result.length > 0 && blankBetween(last, line)) result.push("");
    result.push(indent + text);
    last = Math.max(last, line);
  };
  for (const item of out) {
    if (item.line !== null) {
      for (const c of own) if (c.line < item.line && c.line > last) emit(c.text, c.line, item.indent);
      // A top-level item always starts after a blank line or comment.
      if (item.indent === "" && result.length > 0 && result.at(-1) !== "" && !result.at(-1)!.startsWith("//")) result.push("");
    }
    const line = item.line ?? last;
    const comment = item.line !== null && !used.has(item.line) ? trailing.get(item.line) : undefined;
    if (comment) used.add(item.line!);
    emit(comment ? `${item.text}  ${comment}` : item.text, line, item.indent);
  }
  for (const c of own) if (c.line > last) emit(c.text, c.line, "");
  return result.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

/**
 * A converted schema as its USL was: an enum's `color` field and its values' `color`
 * records were `~color` (the translation shows them as that again).
 */
function withoutColorData<T extends { models: ResolvedModel[] }>(result: T, before: { models: ResolvedModel[] }): T {
  const colored = new Set(before.models.filter((m) => m.rows === "fixed" && !m.fields.some((f) => f.name === "color")).map((m) => m.name));
  return {
    ...result,
    models: result.models.map((m) => !colored.has(m.name) ? m : {
      ...m,
      fields: m.fields.filter((f) => f.name !== "color"),
      schemaRows: m.schemaRows.map((r) => ({ ...r, values: Object.fromEntries(Object.entries(r.values).filter(([key]) => key !== "color")) })),
    }),
  };
}

/** Everything the schema says, without where it said it: tables, layout, presentation. */
function fingerprintOf(result: { models: unknown; connections: unknown }): string {
  const positionless = (_key: string, value: unknown) =>
    value && typeof value === "object" && "line" in value && "column" in value && Object.keys(value).length === 2 ? undefined : value;
  return JSON.stringify([modelLayer(result as never), layoutOf(result as never), result.models, result.connections], (key, value) =>
    key === "at" || key === "span" ? undefined : positionless(key, value));
}

/** Converts and verifies one file; returns the formatted Beetle. */
export function convertVerified(source: string): string {
  const raw = convert(source);
  const formatted = (() => {
    try {
      return formatView(raw);
    } catch {
      return raw;
    }
  })();
  const before = compileUsl(source);
  const after = compileSchema(formatted);
  const errors = after.diagnostics.filter((d) => !("severity" in d) || (d as { severity?: string }).severity !== "warning");
  if (errors.length > 0) throw new Error(`the Beetle doesn't compile:\n${errors.map((d) => `  ${d.line}:${d.column} ${d.message}`).join("\n")}\n\n${formatted}`);
  if (fingerprintOf(before) !== fingerprintOf(withoutColorData(after, before))) throw new Error(`the Beetle's tables differ from the USL's\n\n${formatted}`);
  return formatted;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const check = args.includes("--check");
  const files = args.filter((a) => !a.startsWith("--"));
  if (files.length === 0) {
    console.error("usage: bun tools/convert-usl-to-beetle.ts <schema.usl>... [--write] [--check]");
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    try {
      const beetle = convertVerified(readFileSync(file, "utf8"));
      if (write) {
        const target = join(dirname(file), file.endsWith("schema.usl") ? "schema.beetle" : file.replace(/^.*\//, "").replace(/\.usl$/, ".beetle"));
        writeFileSync(target, beetle);
        console.error(`${file} → ${target}`);
      } else if (check) console.error(`${file}: ok`);
      else process.stdout.write(beetle);
    } catch (error) {
      failed = true;
      console.error(`${file}: ${(error as Error).message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
