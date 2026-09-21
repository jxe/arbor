import { markdownLayout, markdownProseInsertion, markdownTransferShape, markdownListEdit } from "./markdown-format.ts";
import { xmlUnits, webUnits } from "./web-formats.ts";
import Parser from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { parseDocument } from "yaml";
import { overlap, pieceLength, type PieceEdit } from "./pieces.ts";

export interface FormatConfig {
  format?: Format;
  recordKey?: string;
  proseInsertions?: "review" | "preserve-both";
}
export type Format =
  | "text"
  | "markdown"
  | "json"
  | "jsonl"
  | "yaml"
  | "toml"
  | "csv"
  | "tsv"
  | "typescript"
  | "javascript"
  | "swift"
  | "python"
  | "html"
  | "xml"
  | "css"
  | "binary";
export interface FormatEvidence {
  id: string;
  revision: 1;
  outcome: "resolved" | "unresolved";
  reason: string;
  config: FormatConfig;
}
const formats: Record<string, Format> = {
  ".txt": "text",
  ".md": "markdown",
  ".markdown": "markdown",
  ".json": "json",
  ".jsonl": "jsonl",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".csv": "csv",
  ".tsv": "tsv",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".swift": "swift",
  ".py": "python",
  ".html": "html",
  ".xml": "xml",
  ".css": "css",
};
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
let initialized: Promise<void> | undefined;
const languages = new Map<string, Promise<Parser.Language>>();
async function parse(language: string, source: string): Promise<Parser.Tree> {
  await (initialized ??= Parser.init());
  let grammar = languages.get(language);
  if (!grammar) {
    grammar = Parser.Language.load(
      join(
        dirname(
          fileURLToPath(import.meta.resolve("tree-sitter-wasms/package.json")),
        ),
        "out",
        `tree-sitter-${language}.wasm`,
      ),
    );
    languages.set(language, grammar);
  }
  const parser = new Parser();
  try {
    parser.setLanguage(await grammar);
    parser.setTimeoutMicros(100_000);
    const tree = parser.parse(source);
    if (!tree) throw new Error("Parser budget exceeded");
    return tree;
  } finally {
    parser.delete();
  }
}
type Unit = { key: string; start: number; end: number };
const byte = (source: string, offset: number) =>
  Buffer.byteLength(source.slice(0, offset));
const range = (source: string, n: Parser.SyntaxNode) => ({
  start: byte(source, n.startIndex),
  end: byte(source, n.endIndex),
});
const descendants = (node: Parser.SyntaxNode): Parser.SyntaxNode[] => {
  const found: Parser.SyntaxNode[] = [],
    pending = [node];
  while (pending.length) {
    const next = pending.pop()!;
    found.push(next);
    if (found.length > 20_000) throw new Error("Syntax node budget exceeded");
    pending.push(...next.namedChildren);
  }
  return found;
};
function unique(units: Unit[]): boolean {
  return new Set(units.map((u) => u.key)).size === units.length;
}
function touched(units: Unit[], edits: PieceEdit[]): Set<string> | null {
  const keys = new Set<string>();
  for (const e of edits) {
    const owners = units.filter(
      (u) => e.range[0] >= u.start && e.range[1] <= u.end,
    );
    if (owners.length !== 1) return null;
    keys.add(owners[0]!.key);
  }
  return keys;
}
function independent(units: Unit[], a: PieceEdit[], b: PieceEdit[]): boolean {
  const x = touched(units, a),
    y = touched(units, b);
  return !!x && !!y && ![...x].some((k) => y.has(k));
}
function jsonUnits(
  source: string,
  root: Parser.SyntaxNode,
  prefix = "",
): Unit[] | null {
  const out: Unit[] = [];
  function visit(node: Parser.SyntaxNode, path: string): boolean {
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const pair of node.namedChildren) {
        if (pair.type !== "pair") return false;
        const key = pair.childForFieldName("key"),
          value = pair.childForFieldName("value");
        if (!key || !value) return false;
        const name = JSON.parse(key.text) as string;
        if (keys.has(name)) return false;
        keys.add(name);
        const id = path + "/" + JSON.stringify(name);
        if (value.type === "object") {
          if (!visit(value, id)) return false;
        } else out.push({ key: id, ...range(source, value) });
      }
    } else return false;
    return true;
  }
  return visit(root.namedChildren[0]!, prefix) ? out : null;
}
function mappingUnits(
  source: string,
  root: Parser.SyntaxNode,
  format: "yaml" | "toml",
): Unit[] | null {
  if (format === "yaml") {
    const doc = parseDocument(source, { uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) return null;
    if (
      descendants(root).some((n) =>
        /anchor|alias|tag|block_scalar|flow_sequence|block_sequence/.test(
          n.type,
        ),
      )
    )
      return null;
  } else if (
    descendants(root).some((n) => /array|dotted_key|multi_line/.test(n.type))
  )
    return null;
  const canonicalKey = (text: string) =>
    text.startsWith('"')
      ? JSON.parse(text)
      : text.startsWith("'")
        ? text.slice(1, -1)
        : text;
  const units: Unit[] = [];
  function visit(node: Parser.SyntaxNode, path: string) {
    if (
      format === "toml" &&
      (node.type === "table" || node.type === "table_array_element")
    )
      path +=
        "/" + JSON.stringify(canonicalKey(node.namedChildren[0]?.text ?? ""));
    if (
      node.type === "pair" ||
      node.type === "block_mapping_pair" ||
      node.type === "flow_pair"
    ) {
      const key = node.childForFieldName("key") ?? node.namedChildren[0],
        value = node.childForFieldName("value") ?? node.namedChildren[1];
      if (!key || !value) throw new Error("Missing mapping member");
      const id = path + "/" + JSON.stringify(canonicalKey(key.text));
      if (
        descendants(value).some(
          (n) => n.type === "block_mapping_pair" || n.type === "flow_pair",
        )
      )
        visit(value, id);
      else units.push({ key: id, ...range(source, value) });
      return;
    }
    node.namedChildren.forEach((child) => visit(child, path));
  }
  visit(root, "");
  return unique(units) ? units : null;
}
const codeLanguages = new Set<Format>([
  "typescript",
  "javascript",
  "swift",
  "python",
]);
function codeUnits(source: string, root: Parser.SyntaxNode): Unit[] | null {
  const all = descendants(root);
  if (
    all.some((n) =>
      /decorator|macro|attribute|preproc|directive|extension/.test(n.type),
    )
  )
    return null;
  // Retain only declaration scopes whose names are unique. Overloads, dynamic
  // declarations and unnamed initializers need more context than this rule has.
  const units: Unit[] = [];
  const declarations = new Set<string>();
  function scope(parent: Parser.SyntaxNode, prefix: string): boolean {
    for (const node of parent.namedChildren) {
      if (/comment|import/.test(node.type)) continue;
      if (node.type === "export_statement") return false;
      const container =
        /^(class_declaration|class_definition|struct_declaration|interface_declaration)$/.test(
          node.type,
        );
      if (container) {
        const name = node.childForFieldName("name"),
          body =
            node.childForFieldName("body") ??
            node.namedChildren.find((n) => /body$/.test(n.type));
        if (!name || !body || declarations.has(prefix + name.text))
          return false;
        declarations.add(prefix + name.text);
        if (!scope(body, prefix + name.text + "/")) return false;
        continue;
      }
      let name = node.childForFieldName("name");
      if (
        node.type === "lexical_declaration" ||
        node.type === "variable_declaration"
      ) {
        if (node.namedChildCount !== 1) return false;
        name = node.namedChildren[0]!.childForFieldName("name");
      }
      if (
        node.type === "expression_statement" &&
        node.namedChildren[0]?.type === "assignment"
      )
        name = node.namedChildren[0].childForFieldName("left");
      if (!name || !/identifier|pattern/.test(name.type)) return false;
      if (declarations.has(prefix + name.text)) return false;
      declarations.add(prefix + name.text);
      units.push({ key: prefix + name.text, ...range(source, node) });
    }
    return true;
  }
  if (!scope(root, "")) return null;
  return unique(units) ? units : null;
}
function codeShape(root: Parser.SyntaxNode): string {
  const literals =
    /^(number|integer|float|integer_literal|real_literal|float_literal|string|string_literal|string_content|line_string_literal|line_str_text|true|false|true_literal|false_literal|boolean_literal)$/;
  function walk(n: Parser.SyntaxNode): unknown {
    if (/comment/.test(n.type)) return null;
    if (
      literals.test(n.type) &&
      !descendants(n)
        .slice(1)
        .some((c) => /interpolation|identifier|expression/.test(c.type))
    )
      return [n.type, "value"];
    return [
      n.type,
      n.childCount ? n.children.map(walk).filter((x) => x !== null) : n.text,
    ];
  }
  return JSON.stringify(walk(root));
}
function tableUnits(
  source: string,
  delimiter: string,
  key: string | undefined,
): Unit[] | null {
  if (!key) return null;
  const rows: Array<Array<{ text: string; start: number; end: number }>> = [];
  let row: Array<{ text: string; start: number; end: number }> = [],
    start = 0,
    quoted = false,
    closedQuote = false,
    value = "";
  for (let i = 0; i <= source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else if (c === undefined) return null;
      else value += c;
      continue;
    }
    if (
      closedQuote &&
      c !== delimiter &&
      c !== "\n" &&
      c !== undefined &&
      !(c === "\r" && source[i + 1] === "\n")
    )
      return null;
    if (c === '"') {
      if (i !== start) return null;
      quoted = true;
      continue;
    }
    if (c === delimiter || c === "\n" || c === undefined) {
      row.push({
        text: value.replace(/\r$/, ""),
        start: byte(source, start),
        end: byte(source, i),
      });
      value = "";
      closedQuote = false;
      start = i + 1;
      if (c !== delimiter) {
        if (row.length > 1 || row[0]!.text !== "") rows.push(row);
        row = [];
      }
    } else value += c;
  }
  const header = rows.shift();
  if (
    !header ||
    !unique(header.map((x) => ({ key: x.text, start: 0, end: 0 })))
  )
    return null;
  const index = header.findIndex((c) => c.text === key);
  if (index < 0) return null;
  const seen = new Set<string>(),
    units: Unit[] = [];
  for (const cells of rows) {
    if (cells.length !== header.length) return null;
    const id = cells[index]!.text;
    if (!id || seen.has(id)) return null;
    seen.add(id);
    cells.forEach((c, i) => {
      if (i !== index)
        units.push({
          key: JSON.stringify([id, header[i]!.text]),
          start: c.start,
          end: c.end,
        });
    });
  }
  return units;
}
/** Normalize verified inline edits and prose insertions before checking transfers.
 * Everything else, including the exact protected host/embedded syntax, remains
 * in the signature. Source ranges come from identity correspondence, not a diff. */
function proseTransferShape(base: Uint8Array, changed: Uint8Array, edits: PieceEdit[]): string | null {
  try {
    if (edits.length > 128) return null;
    const source = decoder.decode(base), layout = markdownLayout(source);
    if (!layout) return null;
    const parts: string[] = [];
    let old = 0, next = 0;
    for (const edit of [...edits].sort((a, b) => a.range[0] - b.range[0])) {
      const [start, end] = edit.range, size = pieceLength(edit.pieces);
      if (start < old || end < start || end > base.length) return null;
      const gap = start - old;
      if (!Buffer.from(base.subarray(old, start)).equals(changed.subarray(next, next + gap))) return null;
      parts.push(decoder.decode(base.subarray(old, start)));
      next += gap;
      if (next + size > changed.length) return null;
      const text = decoder.decode(changed.subarray(next, next + size));
      const previous = decoder.decode(base.subarray(start, end));
      const inline = !/[\r\n]/.test(previous + text) &&
        touched(layout.units.filter(u => !u.key.startsWith("embedded:")), [edit]) !== null &&
        markdownProseInsertion(source, start, [text]) &&
        markdownLayout(decoder.decode(base.subarray(0, start)) + text + decoder.decode(base.subarray(end)))?.skeleton === layout.skeleton;
      // New prose/list items use the established insertion guard. Headings and
      // blockquotes can change the scope of later edits and remain protected.
      const insertion = start === end && !/^ {0,3}(?:#{1,6}(?:\s|$)|>)/m.test(text) &&
        markdownProseInsertion(source, start, [text]);
      parts.push(inline || insertion || markdownListEdit(source, start, end, text) ? previous : text);
      old = end; next += size;
    }
    if (!Buffer.from(base.subarray(old)).equals(changed.subarray(next))) return null;
    parts.push(decoder.decode(base.subarray(old)));
    return markdownTransferShape(parts.join(""), false);
  } catch {
    // A piece boundary may divide a UTF-8 scalar; it is not a prose boundary.
    return null;
  }
}

/** Policy checks follow correspondence; a and b describe current and incoming,
 * respectively. Syntax validity alone never authorizes a merge. */
export async function evaluateFormat(
  path: string,
  base: Uint8Array,
  current: Uint8Array,
  incoming: Uint8Array,
  proposed: Uint8Array,
  a: PieceEdit[],
  b: PieceEdit[],
  config: FormatConfig = {},
): Promise<FormatEvidence> {
  const format =
    config.format ?? formats[extname(path).toLowerCase()] ?? "binary";
  const result = (safe: boolean, reason: string): FormatEvidence => ({
    id: `${format}-independent`,
    revision: 1,
    outcome: safe ? "resolved" : "unresolved",
    reason,
    config,
  });
  if (format === "binary")
    return result(false, "Opaque content retains competing replacements");
  let sources: string[];
  try {
    sources = [base, current, incoming, proposed].map((bytes) =>
      decoder.decode(bytes),
    );
  } catch {
    return result(false, "Invalid UTF-8 for selected text format");
  }
  if (sources.some((s) => s.length > 256 * 1024))
    return result(false, "Source exceeds parser budget");
  if (format === "text")
    return result(true, "Disjoint verified source contributions");
  if (format === "markdown") {
    const layouts = sources.map(markdownLayout);
    if (
      !layouts.every(Boolean) ||
      !layouts.every((l) => l!.skeleton === layouts[0]!.skeleton) ||
      !touched(layouts[0]!.units, [...a, ...b])
    ) {
      // Paragraph removal/reordering changes the line skeleton without changing
      // protected Markdown structure. Permit it alongside independently verified
      // inline prose edits, and validate the combined result as well.
      // For overlaps the caller's tentative projection selects incoming edits;
      // proving its host safe permits local choices, not automatic resolution.
      const projection = [...b, ...a.filter(x => !b.some(y => overlap(x, y)))];
      const shapes = [
        markdownTransferShape(sources[0]!, false),
        proseTransferShape(base, current, a),
        proseTransferShape(base, incoming, b),
        proseTransferShape(base, proposed, projection),
      ];
      if (shapes[0] !== null && shapes.every(shape => shape === shapes[0]))
        return result(true, "Independent prose edits and transfers preserve protected Markdown structure");
      return result(
        false,
        "Markdown host structure or unsupported source scope changed",
      );
    }
    const aliases: Record<string, Format> = {
      js: "javascript",
      ts: "typescript",
      javascript: "javascript",
      typescript: "typescript",
      json: "json",
      yaml: "yaml",
      yml: "yaml",
      toml: "toml",
      python: "python",
      py: "python",
      swift: "swift",
      css: "css",
      html: "html",
      text: "text",
      "": "text",
    };
    for (const [index, embedded] of layouts[0]!.embedded.entries()) {
      const local = a.filter(
          (e) => e.range[0] >= embedded.start && e.range[1] <= embedded.end,
        ),
        remote = b.filter(
          (e) => e.range[0] >= embedded.start && e.range[1] <= embedded.end,
        );
      const format = aliases[embedded.language];
      if (local.length && remote.length) {
        if (!format)
          return result(
            false,
            "Unknown embedded language has concurrent changes",
          );
        const bytes = layouts.map((l) =>
          new TextEncoder().encode(l!.embedded[index]!.source),
        );
        const translate = (edits: PieceEdit[]) =>
          edits.map((e) => ({
            ...e,
            range: [
              e.range[0] - embedded.start,
              e.range[1] - embedded.start,
            ] as [number, number],
          }));
        const nested = await evaluateFormat(
          "embedded",
          bytes[0]!,
          bytes[1]!,
          bytes[2]!,
          bytes[3]!,
          translate(local),
          translate(remote),
          { format },
        );
        if (nested.outcome !== "resolved")
          return result(
            false,
            "Embedded language requires review: " + nested.reason,
          );
      }
    }
    return result(
      true,
      "Independent source scopes with stable Markdown host structure; concurrent embedded changes delegate to their format policy",
    );
  }
  if (format === "csv" || format === "tsv") {
    const units = sources.map((s) =>
      tableUnits(s, format === "csv" ? "," : "\t", config.recordKey),
    );
    return result(
      units.every(Boolean) &&
        units.every(
          (u) =>
            JSON.stringify(u!.map((x) => x.key)) ===
            JSON.stringify(units[0]!.map((x) => x.key)),
        ) &&
        independent(units[0]!, a, b),
      "Distinct fields with unchanged unique record keys, schema and order",
    );
  }
  if (format === "xml") {
    const units = sources.map(xmlUnits);
    return result(
      units.every(Boolean) &&
        units.every(
          (u) =>
            JSON.stringify(u!.map((x) => x.key)) ===
            JSON.stringify(units[0]!.map((x) => x.key)),
        ) &&
        independent(units[0]!, a, b),
      "Distinct XML values with unchanged unambiguous namespace-free structure",
    );
  }
  const trees: Parser.Tree[] = [];
  try {
    const language =
      format === "jsonl"
        ? "json"
        : format === "typescript" && extname(path) === ".tsx"
          ? "tsx"
          : format;
    if (format === "jsonl") {
      if (!config.recordKey)
        return result(false, "JSONL requires an explicit record key");
      const sets: Unit[][] = [];
      for (const source of sources) {
        const units: Unit[] = [];
        const keys = new Set<string>();
        let offset = 0;
        for (const line of source.split(/(?<=\n)/)) {
          if (!line.trim()) {
            offset += Buffer.byteLength(line);
            continue;
          }
          const tree = await parse("json", line);
          trees.push(tree);
          if (tree.rootNode.hasError()) return result(false, "Malformed JSONL");
          const record = JSON.parse(line),
            key = record[config.recordKey];
          if (
            (typeof key !== "string" && typeof key !== "number") ||
            keys.has(JSON.stringify(key))
          )
            return result(false, "Missing or nonunique JSONL key");
          keys.add(JSON.stringify(key));
          const fields = jsonUnits(line, tree.rootNode, JSON.stringify(key));
          if (!fields) return result(false, "Ambiguous JSONL mapping");
          units.push(
            ...fields
              .filter(
                (u) => !u.key.endsWith("/" + JSON.stringify(config.recordKey)),
              )
              .map((u) => ({
                ...u,
                start: u.start + offset,
                end: u.end + offset,
              })),
          );
          offset += Buffer.byteLength(line);
        }
        sets.push(units);
      }
      return result(
        sets.every(
          (u) =>
            JSON.stringify(u.map((x) => x.key)) ===
            JSON.stringify(sets[0]!.map((x) => x.key)),
        ) && independent(sets[0]!, a, b),
        "Independent keyed record fields with stable order",
      );
    }
    for (const source of sources) trees.push(await parse(language, source));
    if (trees.some((t) => t.rootNode.hasError()))
      return result(false, "Malformed or unsupported syntax");
    if (format === "json" || format === "yaml" || format === "toml") {
      const units = trees.map((t, i) =>
        format === "json"
          ? jsonUnits(sources[i]!, t.rootNode)
          : mappingUnits(sources[i]!, t.rootNode, format),
      );
      const safe =
        units.every(Boolean) &&
        units.every(
          (u) =>
            JSON.stringify(u!.map((x) => x.key)) ===
            JSON.stringify(units[0]!.map((x) => x.key)),
        ) &&
        independent(units[0]!, a, b);
      return result(
        safe,
        "Distinct mapping values with unchanged unambiguous key structure",
      );
    }
    if (codeLanguages.has(format)) {
      const units = trees.map((t, i) => codeUnits(sources[i]!, t.rootNode));
      const safe =
        units.every(Boolean) &&
        trees.every(
          (t) => codeShape(t.rootNode) === codeShape(trees[0]!.rootNode),
        ) &&
        independent(units[0]!, a, b);
      return result(
        safe,
        "Independent declaration literal edits with unchanged syntax and binding topology",
      );
    }
    if (format === "html" || format === "css") {
      const units = trees.map((t, i) =>
        webUnits(sources[i]!, t.rootNode, format),
      );
      return result(
        units.every(Boolean) &&
          units.every(
            (u) =>
              JSON.stringify(u!.map((x) => x.key)) ===
              JSON.stringify(units[0]!.map((x) => x.key)),
          ) &&
          independent(units[0]!, a, b),
        "Distinct values with unchanged unique structure and declaration order",
      );
    }
    return result(false, "Format requires explicit alternatives");
  } catch {
    return result(false, "Parser or semantic context unavailable");
  } finally {
    for (const tree of trees) tree.delete();
  }
}

/** Same-anchor insertion policy is separate from replacement independence. */
export function evaluateProseInsertions(
  path: string,
  base: Uint8Array,
  offset: number,
  additions: Uint8Array[],
  config: FormatConfig = {},
): FormatEvidence {
  const format =
    config.format ?? formats[extname(path).toLowerCase()] ?? "binary";
  const policy =
    config.proseInsertions ??
    (format === "markdown" ? "preserve-both" : "review");
  const result = (safe: boolean, reason: string): FormatEvidence => ({
    id: `${format}-insertions`,
    revision: 1,
    outcome: safe ? "resolved" : "unresolved",
    reason,
    config: { ...config, proseInsertions: policy },
  });
  if (policy !== "preserve-both" || !["markdown", "text"].includes(format))
    return result(false, "Competing insertions require review for this policy");
  if (base.length + additions.reduce((n, a) => n + a.length, 0) > 256 * 1024)
    return result(false, "Source exceeds insertion analysis budget");
  try {
    const source = decoder.decode(base),
      texts = additions.map((a) => decoder.decode(a));
    return format === "text" || markdownProseInsertion(source, offset, texts)
      ? result(
          true,
          "Preserve independent prose insertions in contribution order",
        )
      : result(
          false,
          "Insertion affects structured or unsupported Markdown syntax",
        );
  } catch {
    return result(false, "Invalid UTF-8 for prose insertion");
  }
}

/** A separate rule for identity-verified transfer replay. Ordinary independence
 * checks assume unchanged host structure; paragraph copies intentionally alter it. */
export function evaluateSourceTransfer(
  path: string,
  versions: Uint8Array[],
  config: FormatConfig = {}
): FormatEvidence {
  const format =
    config.format ?? formats[extname(path).toLowerCase()] ?? "binary";
  const result = (safe: boolean, reason: string): FormatEvidence => ({
    id: `${format}-source-transfer`,
    revision: 1,
    outcome: safe ? "resolved" : "unresolved",
    reason,
    config,
  });
  if (!["text", "markdown"].includes(format))
    return result(
      false,
      "Source transfer requires format-specific structural evidence"
    );
  if (versions.some((bytes) => bytes.length > 256 * 1024))
    return result(false, "Source exceeds transfer analysis budget");
  let sources: string[];
  try {
    sources = versions.map((bytes) => decoder.decode(bytes));
  } catch {
    return result(false, "Invalid UTF-8 for source transfer");
  }
  if (format === "text") return result(true, "Identity-verified text transfer");
  const shapes = sources.map(source => markdownTransferShape(source));
  const safe =
    shapes.length === 4 &&
    shapes[0] !== null &&
    shapes.every((shape) => shape === shapes[0]);
  return result(
    safe,
    safe
      ? "Identity-verified prose transfer preserves Markdown host and embedded structure"
      : "Transfer changes protected Markdown structure or embedded content"
  );
}
