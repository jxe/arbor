import { markdownLayout, markdownProseInsertion, markdownTransferShape, markdownTransferStructure, markdownListEdit, MarkdownSource, type LinkPolicy } from "./markdown-format.ts";
import { byte, xmlUnits, webUnits } from "./web-formats.ts";
import Parser from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { parseDocument } from "yaml";
import { overlap, pieceLength, type PieceEdit } from "./pieces.ts";
import type { Format } from "./format-names.ts";
export type { Format };

export interface FormatConfig {
  format?: Format;
  recordKey?: string;
  proseInsertions?: "review" | "preserve-both";
}
/** What the engine knows about a transfer merge beyond one file's four
 * versions (base, current, authored, replayed). */
export interface TransferContext {
  /** This file's directory in each of the four versions. */
  directories: string[];
  /** Whether any transfer in the merge carries text between documents:
   * "same-directory" when every one that does joins two documents in one
   * directory, "other" otherwise or when an endpoint is unknown. */
  crossDocument: "none" | "same-directory" | "other";
  /** This file's transfers, on the current (1) or authored (2) side: a move's
   * `source` is the byte range it left in base and its `destination` the
   * range of its material in its side's version. A move out of or into
   * another file has only one of them. Null when some transfer's material
   * could not be located. */
  transfers: Array<{
    side: 1 | 2;
    kind: "move" | "copy";
    source?: [number, number];
    destination?: [number, number];
  }> | null;
}
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
/** A parser for `language`, which the caller deletes. One evaluation reuses
 * it for every document it parses. */
async function createParser(language: string): Promise<Parser> {
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
    return parser;
  } catch (error) {
    parser.delete();
    throw error;
  }
}
/** A complete parse. A parse that runs out of time throws, so a parser is
 * never reused to resume one. */
function parse(parser: Parser, source: string): Parser.Tree {
  const tree = parser.parse(source);
  if (!tree) throw new Error("Parser budget exceeded");
  return tree;
}
type Unit = { key: string; start: number; end: number };
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
/** What one evaluation's transfer checks share: they all read the same base
 * document, so it is scanned and laid out once, and each distinct edit of it
 * is judged once. */
interface ProseBase {
  bytes: Uint8Array;
  document: MarkdownSource;
  layout: ReturnType<typeof markdownLayout>;
  /** Whether an edit (by range and text) keeps the base's prose shape. */
  kept: Map<string, boolean>;
}

/** Normalize verified inline edits and prose insertions before checking transfers.
 * Everything else, including the exact protected host/embedded syntax, remains
 * in the signature. Source ranges come from identity correspondence, not a diff. */
function proseTransferShape(scan: ProseBase, changed: Uint8Array, edits: PieceEdit[]): string | null {
  try {
    if (edits.length > 128) return null;
    const { bytes: base, document, layout } = scan;
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
      const key = JSON.stringify([start, end, text]);
      let kept = scan.kept.get(key);
      if (kept === undefined) {
        const inline = !/[\r\n]/.test(previous + text) &&
          touched(layout.units.filter(u => !u.key.startsWith("embedded:")), [edit]) !== null &&
          markdownProseInsertion(document, start, [text]) &&
          markdownLayout(decoder.decode(base.subarray(0, start)) + text + decoder.decode(base.subarray(end)))?.skeleton === layout.skeleton;
        // New prose/list items use the established insertion guard. Headings and
        // blockquotes can change the scope of later edits and remain protected.
        const insertion = start === end && !/^ {0,3}(?:#{1,6}(?:\s|$)|>)/m.test(text) &&
          markdownProseInsertion(document, start, [text]);
        kept = inline || insertion || markdownListEdit(document, start, end, text);
        scan.kept.set(key, kept);
      }
      parts.push(kept ? previous : text);
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
      const scan: ProseBase = { bytes: base, document: new MarkdownSource(sources[0]!), layout: layouts[0] ?? null, kept: new Map() };
      const shapes = [
        markdownTransferShape(scan.document, false),
        proseTransferShape(scan, current, a),
        proseTransferShape(scan, incoming, b),
        proseTransferShape(scan, proposed, projection),
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
  let parser: Parser | undefined;
  try {
    const language =
      format === "jsonl"
        ? "json"
        : format === "typescript" && extname(path) === ".tsx"
          ? "tsx"
          : format;
    // One parser for every document this evaluation parses.
    const parsed = async (source: string) => parse((parser ??= await createParser(language)), source);
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
          const tree = await parsed(line);
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
    for (const source of sources) trees.push(await parsed(source));
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
    parser?.delete();
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
  config: FormatConfig = {},
  context?: TransferContext
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
  if (safe)
    return result(true, "Identity-verified prose transfer preserves Markdown host and embedded structure");
  if (sources.length !== 4)
    return result(false, "Transfer changes protected Markdown structure or embedded content");
  // List items, table rows and contextual links (`markdownTransferStructure`).
  //
  // Commutation proof. The engine has already replayed the other side's
  // operations by piece identity, so `replayed` holds each side's bytes where
  // identity put them and no byte either side did not write. What remains is
  // that each change means the same in the combined document as where it was
  // authored. Every version having one structure shape means both sides, and
  // the result, keep every protected block byte-for-byte and every list and
  // table host with its bullet or its header and alignment, and differ only in
  // paragraphs, items and body rows. Those render from their own source and
  // their host alone, and no side changed a host, so a change renders the same
  // in either side's document and in the result, in either arrival order.
  //
  // A contextual link also depends on its document: a relative destination on
  // its directory, a fragment on its headings, a reference on its
  // definitions. Headings and definitions are protected blocks, so one shape
  // keeps them identical; the directory is compared below. A link is admitted
  // only where no transfer brings text from another document, except a
  // relative one between documents in one directory. Anywhere else it stays
  // protected, and moving it requires review.
  const links: LinkPolicy =
    context?.crossDocument === "none"
      ? { relative: true, fragment: true, reference: true }
      : context?.crossDocument === "same-directory"
        ? { relative: true }
        : {};
  const structures = sources.map((source) => markdownTransferStructure(source, links));
  const structured = structures.every((s) => s.shape === structures[0]!.shape);
  const bound =
    !structures.some((s) => s.links.size) ||
    (!!context && context.directories.length === 4 &&
      context.directories.every((d) => d === context.directories[0]));
  return result(
    structured && bound,
    structured && bound
      ? "Identity-verified transfer preserves Markdown list and table hosts, protected structure and link bindings"
      : structured
        ? "Transfer changes a contextual link's document"
        : "Transfer changes protected Markdown structure or embedded content"
  );
}

/** A keyed reading of a structured document for transfer proofs: `units` maps
 * each member's key path (a JSON array) to its exact value source, or `{}` for
 * a mapping, and `members` gives each member's key path and byte range. */
interface KeyedModel {
  units: Map<string, string>;
  members: Array<{ path: string[]; start: number; end: number }>;
  /** Source outside the members that every version must keep exactly. */
  fixed: string;
  /** Per member, a shape that literal edits keep; compared across versions. */
  shapes?: Map<string, string>;
}
const pathKey = (path: string[]) => JSON.stringify(path);
/** Whether `a` is `b` or one of its ancestors. */
const within = (a: string[], b: string[]) =>
  a.length <= b.length && a.every((key, i) => key === b[i]);

function jsonModel(source: string, root: Parser.SyntaxNode): KeyedModel | null {
  const units = new Map<string, string>(), members: KeyedModel["members"] = [];
  const visit = (node: Parser.SyntaxNode, path: string[]): boolean => {
    if (node.type !== "object") {
      units.set(pathKey(path), node.text);
      return true;
    }
    units.set(pathKey(path), "{}");
    const keys = new Set<string>();
    for (const pair of node.namedChildren) {
      if (pair.type !== "pair") return false;
      const key = pair.childForFieldName("key"), value = pair.childForFieldName("value");
      if (!key || !value || key.type !== "string") return false;
      const name = JSON.parse(key.text) as string;
      if (keys.has(name)) return false;
      keys.add(name);
      members.push({ path: [...path, name], ...range(source, pair) });
      if (!visit(value, [...path, name])) return false;
    }
    return true;
  };
  const top = root.namedChildren;
  return top.length === 1 && top[0]!.type === "object" && visit(top[0]!, [])
    ? { units, members, fixed: "" }
    : null;
}

function yamlModel(source: string, root: Parser.SyntaxNode): KeyedModel | null {
  // The same restrictions as ordinary YAML merges: one strict document of
  // mappings and scalars, without anchors, aliases, tags or block scalars.
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) return null;
  if (descendants(root).some((n) => /anchor|alias|tag|block_scalar|flow_sequence|block_sequence/.test(n.type)))
    return null;
  const units = new Map<string, string>(), members: KeyedModel["members"] = [];
  const canonicalKey = (text: string): string =>
    text.startsWith('"') ? JSON.parse(text) : text.startsWith("'") ? text.slice(1, -1).replaceAll("''", "'") : text;
  const content = (node: Parser.SyntaxNode) => node.namedChildren.filter((n) => n.type !== "comment");
  const visit = (node: Parser.SyntaxNode, path: string[]): boolean => {
    if (["stream", "document", "block_node", "flow_node"].includes(node.type)) {
      const inner = content(node);
      return inner.length === 1 && visit(inner[0]!, path);
    }
    if (node.type === "block_mapping" || node.type === "flow_mapping") {
      units.set(pathKey(path), "{}");
      const keys = new Set<string>();
      for (const pair of content(node)) {
        if (pair.type !== "block_mapping_pair" && pair.type !== "flow_pair") return false;
        const key = pair.childForFieldName("key"), value = pair.childForFieldName("value");
        if (!key || !value) return false;
        const name = canonicalKey(key.text);
        if (keys.has(name)) return false;
        keys.add(name);
        members.push({ path: [...path, name], ...range(source, pair) });
        if (!visit(value, [...path, name])) return false;
      }
      return true;
    }
    if (/^(plain_scalar|single_quote_scalar|double_quote_scalar)$/.test(node.type)) {
      units.set(pathKey(path), node.text);
      return true;
    }
    return false;
  };
  return visit(root, []) && units.get(pathKey([])) === "{}" ? { units, members, fixed: "" } : null;
}

/** Top-level function declarations of a script or module. They are hoisted
 * whole: each binding holds its function before any statement runs, wherever
 * it is written, so their order among the other statements has no effect.
 * Everything else (imports, classes, variables, expression statements) runs
 * or binds in order and is kept exactly. Comments that direct tools about the
 * next line would change meaning if a declaration moved under them. */
function declarationModel(source: string, root: Parser.SyntaxNode): KeyedModel | null {
  if (!codeUnits(source, root)) return null;
  const units = new Map<string, string>(), members: KeyedModel["members"] = [],
    shapes = new Map<string, string>(), fixed: string[] = [];
  for (const node of root.namedChildren) {
    if (node.type === "comment") {
      if (/@ts-|eslint|istanbul|c8\b|prettier|jshint|jscs|global|@flow|@jsx|biome|deno-|sourceMappingURL|sourceURL/i.test(node.text))
        return null;
      continue;
    }
    if (node.type === "function_declaration" || node.type === "generator_function_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (!name || units.has(pathKey([name]))) return null;
      units.set(pathKey([name]), node.text);
      shapes.set(pathKey([name]), codeShape(node));
      members.push({ path: [name], ...range(source, node) });
      continue;
    }
    if (node.type === "expression_statement" && node.namedChildren[0]?.type === "string") return null;
    if (!/^(import_statement|lexical_declaration|variable_declaration|class_declaration|expression_statement|type_alias_declaration|interface_declaration)$/.test(node.type))
      return null;
    // Other statements keep their order and syntax (`fixed`); each is a unit
    // by position, so a literal edit to one is an ordinary value edit.
    const shape = codeShape(node), key = pathKey([`\0${fixed.length}`]);
    fixed.push(shape);
    units.set(key, node.text);
    shapes.set(key, shape);
  }
  return { units, members, fixed: JSON.stringify(fixed), shapes };
}

/** The key path of the one complete member a byte range holds, with only
 * whitespace (and, for data, separating commas) beside it. */
function memberAt(model: KeyedModel, bytes: Uint8Array, [start, end]: [number, number], separators: RegExp): string[] | null {
  const inside = model.members.filter((m) => m.start >= start && m.end <= end);
  const top = inside.filter((m) => !inside.some((o) => o !== m && o.start <= m.start && o.end >= m.end));
  if (top.length !== 1) return null;
  const rest = Buffer.concat([bytes.subarray(start, top[0]!.start), bytes.subarray(top[0]!.end, end)]).toString();
  return separators.test(rest) ? top[0]!.path : null;
}

/** The commutation proof for keyed transfers. Returns why it fails, or null.
 *
 * Each side (current, authored) is read as: its moves, each relocating one
 * member's subtree from key path p to q (a declaration keeps its path), its
 * copies, each adding one member at q, and its edits, which change leaf
 * values and nothing else. Moves and copies are identified by the engine's
 * piece identity, never by equal values. The proof requires
 *
 * 1. no transfer endpoint of one side is, contains or lies in an endpoint of
 *    the other (so the two sides' relocations commute, and neither moves what
 *    the other moved or moves into what the other copied);
 * 2. every other difference on a side is a leaf value edit, or lies in one of
 *    its own copies;
 * 3. after relocating each side's edits through the other side's moves (an
 *    edit to a moved member follows it), the two sides' changed paths are
 *    disjoint and none contains another;
 * 4. the replayed version reads as base with both sides' relocations, then
 *    both sides' relocated changes, applied: exactly, key for key.
 *
 * The expected value in (4) is built from sets that are symmetric in the two
 * sides, so the other arrival order, which swaps current and authored, expects
 * the same value, and (4) accepts a replay only when it equals it. */
function keyedTransferProof(
  models: KeyedModel[],
  bytes: Uint8Array[],
  transfers: TransferContext["transfers"],
  separators: RegExp,
): string | null {
  if (!transfers) return "A transfer's material could not be located";
  if (models.some((m) => m.fixed !== models[0]!.fixed))
    return "A change outside keyed members";
  for (const model of models)
    for (const [key, shape] of model.shapes ?? [])
      if (models.some((m) => m.shapes?.has(key) && m.shapes.get(key) !== shape))
        return "A declaration changes more than literals";
  const moves: Array<Array<[string[], string[]]>> = [[], [], []],
    copies: string[][][] = [[], [], []];
  for (const t of transfers) {
    const q = t.destination && memberAt(models[t.side]!, bytes[t.side]!, t.destination, separators);
    if (t.kind === "move") {
      const p = t.source && memberAt(models[0]!, bytes[0]!, t.source, separators);
      if (!p || !q || p.at(-1) !== q.at(-1))
        return "A move must carry one complete keyed member within one file";
      moves[t.side]!.push([p, q]);
    } else {
      if (!q) return "A copy must carry one complete keyed member";
      copies[t.side]!.push(q);
    }
  }
  const ends = (side: number) => [...moves[side]!.flat(), ...copies[side]!];
  for (const side of [1, 2]) {
    const own = ends(side);
    // A reorder's source and destination are one path; that is not an overlap.
    for (const [i, x] of own.entries())
      for (const y of own.slice(i + 1))
        if ((within(x, y) || within(y, x)) &&
          !moves[side]!.some(([p, q]) => (p === x && q === y) || (p === y && q === x)))
          return "Transfers on one side overlap";
  }
  for (const x of ends(1))
    for (const y of ends(2))
      if (within(x, y) || within(y, x)) return "Both sides transfer one member";
  const relocate = (side: number, path: string[]) => {
    for (const [p, q] of moves[side]!)
      if (within(p, path)) return [...q, ...path.slice(p.length)];
    return path;
  };
  const relocated = (side: number, units: Map<string, string>) =>
    new Map([...units].map(([k, v]) => [pathKey(relocate(side, JSON.parse(k))), v] as const));
  const changes: Array<Map<string, string | undefined>> = [new Map(), new Map(), new Map()];
  for (const side of [1, 2]) {
    const before = relocated(side, models[0]!.units), after = models[side]!.units;
    if (before.size !== models[0]!.units.size)
      return "A move lands on an existing member";
    const other = 3 - side;
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(key), b = after.get(key);
      if (a === b) continue;
      const path = JSON.parse(key) as string[];
      const copied = a === undefined && copies[side]!.some((q) => within(q, path));
      const edit = a !== undefined && b !== undefined && a !== "{}" && b !== "{}";
      if (!copied && !edit) return "A side creates, removes or retypes a member outside its transfers";
      if (ends(other).some((e) => within(path, e) && path.length < e.length))
        return "A change contains the other side's transfer";
      changes[side]!.set(pathKey(relocate(other, path)), b);
    }
  }
  for (const x of changes[1]!.keys())
    for (const y of changes[2]!.keys())
      if (within(JSON.parse(x), JSON.parse(y)) || within(JSON.parse(y), JSON.parse(x)))
        return "Both sides change one member";
  const expected = relocated(2, relocated(1, models[0]!.units));
  for (const side of [1, 2])
    for (const [key, value] of changes[side]!)
      if (value === undefined) expected.delete(key);
      else expected.set(key, value);
  const actual = models[3]!.units;
  if (actual.size !== expected.size || [...expected].some(([k, v]) => actual.get(k) !== v))
    return "The replayed result is not both sides' relocated changes";
  return null;
}

/** Transfer evidence for every format: keyed JSON and YAML members and
 * top-level TS/JS function declarations here, text and Markdown in
 * `evaluateSourceTransfer`. */
export async function evaluateTransfer(
  path: string,
  versions: Uint8Array[],
  config: FormatConfig = {},
  context?: TransferContext,
): Promise<FormatEvidence> {
  const format = config.format ?? formats[extname(path).toLowerCase()] ?? "binary";
  if (!["json", "yaml", "typescript", "javascript"].includes(format) || versions.length !== 4)
    return evaluateSourceTransfer(path, versions, config, context);
  const result = (safe: boolean, reason: string): FormatEvidence => ({
    id: `${format}-source-transfer`,
    revision: 1,
    outcome: safe ? "resolved" : "unresolved",
    reason,
    config,
  });
  if (versions.some((bytes) => bytes.length > 256 * 1024))
    return result(false, "Source exceeds transfer analysis budget");
  let sources: string[];
  try {
    sources = versions.map((bytes) => decoder.decode(bytes));
  } catch {
    return result(false, "Invalid UTF-8 for source transfer");
  }
  const trees: Parser.Tree[] = [];
  let parser: Parser | undefined;
  try {
    const language = format === "typescript" && extname(path) === ".tsx" ? "tsx" : format;
    parser = await createParser(language);
    const models: KeyedModel[] = [];
    for (const source of sources) {
      const tree = parse(parser, source);
      trees.push(tree);
      if (tree.rootNode.hasError()) return result(false, "Malformed or unsupported syntax");
      const model =
        format === "json" ? jsonModel(source, tree.rootNode)
          : format === "yaml" ? yamlModel(source, tree.rootNode)
            : declarationModel(source, tree.rootNode);
      if (!model) return result(false, "Ambiguous or unsupported keyed structure");
      models.push(model);
    }
    const data = format === "json" || format === "yaml";
    const failure = keyedTransferProof(models, versions, context?.transfers ?? null,
      data ? /^[\s,]*$/ : /^\s*$/);
    return failure
      ? result(false, failure)
      : result(true, data
        ? "Identity-verified keyed member transfer commutes with independent value edits"
        : "Identity-verified hoisted declaration move commutes with independent literal edits");
  } catch {
    return result(false, "Parser or semantic context unavailable");
  } finally {
    for (const tree of trees) tree.delete();
    parser?.delete();
  }
}
