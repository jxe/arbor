import { SaxesParser } from "saxes";
import type Parser from "web-tree-sitter";
interface SourceUnit {
  key: string;
  start: number;
  end: number;
}
/** Prefix UTF-8 lengths of a few recent sources. A rule analyzes each of its
 * versions in turn, so a handful of slots makes every lookup constant time. */
const utf8Tables: Array<{ source: string; table: Uint32Array }> = [];
const loneSurrogateBytes = Buffer.byteLength("\ud800");
/** `Buffer.byteLength(source.slice(0, offset))` for a UTF-16 `offset`, from one
 * table per source rather than re-encoding a prefix per call. A lone or split
 * surrogate counts as the runtime counts it (Bun: 2 bytes, Node: 3). */
export function byte(source: string, offset: number): number {
  let slot = utf8Tables.find((entry) => entry.source === source);
  if (!slot) {
    const table = new Uint32Array(source.length + 1);
    let bytes = 0;
    for (let i = 0; i < source.length; i++) {
      table[i] = bytes;
      const c = source.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if ((c & 0xfc00) === 0xd800 && i + 1 < source.length &&
        (source.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
        table[++i] = bytes + loneSurrogateBytes;
        bytes += 4;
      } else bytes += (c & 0xf800) === 0xd800 ? loneSurrogateBytes : 3;
    }
    table[source.length] = bytes;
    slot = { source, table };
    utf8Tables.unshift(slot);
    utf8Tables.length = Math.min(utf8Tables.length, 4);
  }
  return slot.table[Math.min(offset, source.length)]!;
}
/** Strict, namespace-free XML subset. No DTDs or entity expansion. */
export function xmlUnits(source: string): SourceUnit[] | null {
  let valid = true;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", () => {
    valid = false;
  });
  parser.on("doctype", () => {
    valid = false;
  });
  parser.on("opentag", (tag) => {
    if (
      tag.prefix ||
      tag.uri ||
      Object.values(tag.attributes).some((a) => a.prefix)
    )
      valid = false;
  });
  try {
    parser.write(source).close();
  } catch {
    return null;
  }
  if (!valid || source.includes("&")) return null;
  const units: SourceUnit[] = [],
    stack: string[] = [],
    seen = new Set<string>();
  let cursor = 0;
  const tags = /<(?:!--[\s\S]*?--|\?[\s\S]*?\?|\/?[A-Za-z_][^<>]*?)>/g;
  for (const match of source.matchAll(tags)) {
    const start = match.index!,
      tag = match[0];
    if (start > cursor && source.slice(cursor, start).trim()) {
      const key = stack.join("/") + "/text";
      if (seen.has(key)) return null;
      seen.add(key);
      units.push({
        key,
        start: byte(source, cursor),
        end: byte(source, start),
      });
    }
    cursor = start + tag.length;
    if (tag.startsWith("<?") || tag.startsWith("<!--")) continue;
    if (tag.startsWith("</")) {
      stack.pop();
      continue;
    }
    const name = /^<([A-Za-z_][\w.-]*)/.exec(tag)?.[1];
    if (!name) return null;
    const path = [...stack, name].join("/");
    if (seen.has(path)) return null;
    seen.add(path);
    for (const attr of tag.matchAll(/\s([\w.-]+)\s*=\s*(["'])(.*?)\2/g)) {
      const relative = attr.index! + attr[0].indexOf(attr[2]!) + 1;
      units.push({
        key: path + "/@" + attr[1],
        start: byte(source, start + relative),
        end: byte(source, start + relative + attr[3]!.length),
      });
    }
    if (!tag.endsWith("/>")) stack.push(name);
  }
  return units;
}
export function webUnits(
  source: string,
  root: Parser.SyntaxNode,
  format: "html" | "css",
): SourceUnit[] | null {
  const out: SourceUnit[] = [],
    seen = new Set<string>();
  let valid = true;
  const add = (key: string, node: Parser.SyntaxNode) => {
    if (seen.has(key)) valid = false;
    seen.add(key);
    out.push({
      key,
      start: byte(source, node.startIndex),
      end: byte(source, node.endIndex),
    });
  };
  if (format === "css") {
    for (const rule of root.namedChildren) {
      if (rule.type === "comment") continue;
      if (rule.type !== "rule_set") return null;
      const selector = rule.namedChildren[0],
        block = rule.namedChildren[1];
      if (!selector || !block || selector.text.includes(":")) return null;
      const key = selector.text;
      if (seen.has(key)) return null;
      seen.add(key);
      for (const declaration of block.namedChildren) {
        if (declaration.type === "comment") continue;
        if (declaration.type !== "declaration") return null;
        const name = declaration.namedChildren[0];
        if (
          !name ||
          name.text.startsWith("--") ||
          declaration.text.includes("var(")
        )
          return null;
        const values = declaration.namedChildren.slice(1);
        if (values.length !== 1) return null;
        add(key + "/" + name.text, values[0]!);
      }
    }
  } else {
    const identifiers = new Set<string>();
    function walk(node: Parser.SyntaxNode, path: string) {
      if (
        node.type === "element" ||
        node.type === "script_element" ||
        node.type === "style_element"
      ) {
        if (node.type !== "element") {
          valid = false;
          return;
        }
        const open = node.namedChildren[0];
        const tag = open?.namedChildren.find((n) => n.type === "tag_name");
        if (!open || !tag) {
          valid = false;
          return;
        }
        const attrs = open.namedChildren.filter((n) => n.type === "attribute");
        const id = attrs.find((a) => a.namedChildren[0]?.text === "id")
          ?.namedChildren[1]?.text;
        if (id) {
          if (identifiers.has(id)) {
            valid = false;
            return;
          }
          identifiers.add(id);
        }
        const here = path + "/" + tag.text + (id ? "#" + id : "");
        if (seen.has(here)) {
          valid = false;
          return;
        }
        seen.add(here);
        for (const attr of attrs) {
          const name = attr.namedChildren[0],
            value = attr.namedChildren[1];
          if (
            !name ||
            !value ||
            name.text.startsWith("on") ||
            name.text === "style"
          ) {
            valid = false;
            return;
          }
          if (name.text !== "id") add(here + "/@" + name.text, value);
        }
        for (const child of node.namedChildren.slice(1)) {
          if (child.type === "end_tag" || child.type === "comment") continue;
          if (child.type === "text") add(here + "/text", child);
          else walk(child, here);
        }
        return;
      }
      if (node.type === "document")
        node.namedChildren.forEach((c) => walk(c, path));
      else if (!["comment", "doctype"].includes(node.type)) valid = false;
    }
    walk(root, "");
  }
  return valid ? out : null;
}
