interface MarkdownLayout {
  units: Array<{ key: string; start: number; end: number }>;
  embedded: Array<{
    key: string;
    language: string;
    start: number;
    end: number;
    source: string;
  }>;
  skeleton: string;
}
/** Source spans describe syntax scopes, never guessed persistent identities. */
export function markdownLayout(source: string): MarkdownLayout | null {
  const units: MarkdownLayout["units"] = [],
    embedded: MarkdownLayout["embedded"] = [],
    skeleton: string[] = [];
  let offset = 0,
    index = 0,
    block:
      | { marker: string; language: string; start: number; source: string }
      | undefined;
  for (const line of source.split(/(?<=\n)/)) {
    const ending = /\r?\n$/.exec(line)?.[0] ?? "",
      body = line.slice(0, line.length - ending.length),
      marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(body);
    if (block) {
      const closes =
        block.marker === "---"
          ? body === "---"
          : !!marker &&
            marker[1]![0] === block.marker[0] &&
            marker[1]!.length >= block.marker.length &&
            !marker[2]!.trim();
      if (closes) {
        const key = `embedded:${embedded.length}`;
        units.push({ key, start: block.start, end: offset });
        embedded.push({
          key,
          language: block.language,
          start: block.start,
          end: offset,
          source: block.source,
        });
        skeleton.push("<embedded>" + line);
        block = undefined;
      } else block.source += line;
      offset += Buffer.byteLength(line);
      index++;
      continue;
    }
    if ((index === 0 && body === "---") || marker) {
      block = {
        marker: marker?.[1] ?? "---",
        language: marker?.[2]?.trim() ?? "yaml",
        start: offset + Buffer.byteLength(line),
        source: "",
      };
      skeleton.push(line);
      offset += Buffer.byteLength(line);
      index++;
      continue;
    }
    if (
      !body.trim() ||
      body === "---" ||
      /\[[^\]]*\]\(|^\s{4}|^\s*</.test(body)
    ) {
      skeleton.push(line);
      offset += Buffer.byteLength(line);
      index++;
      continue;
    }
    if (body.includes("|")) {
      if (body.includes("\\")) {
        skeleton.push(line);
      } else {
        let character = 0;
        const cells = body.split("|");
        cells.forEach((cell, i) => {
          if (cell.trim() && !/^\s*:?-+:?\s*$/.test(cell))
            units.push({
              key: `${index}:cell:${i}`,
              start: offset + Buffer.byteLength(body.slice(0, character)),
              end:
                offset +
                Buffer.byteLength(body.slice(0, character + cell.length)),
            });
          character += cell.length + 1;
        });
        skeleton.push(
          cells
            .map((c) =>
              /^\s*:?-+:?\s*$/.test(c) ? c : c.trim() ? "<cell>" : c,
            )
            .join("|") + ending,
        );
      }
      offset += Buffer.byteLength(line);
      index++;
      continue;
    }
    const prefix =
      /^(?:#{1,6}\s+|\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|>\s*)/.exec(
        body,
      )?.[0] ?? "";
    const checkbox = /\[[ xX]\]/.exec(prefix);
    if (checkbox)
      units.push({
        key: `${index}:task`,
        start: offset + Buffer.byteLength(prefix.slice(0, checkbox.index + 1)),
        end: offset + Buffer.byteLength(prefix.slice(0, checkbox.index + 2)),
      });
    const start = offset + Buffer.byteLength(prefix),
      end = offset + Buffer.byteLength(body);
    skeleton.push(
      prefix.replace(/\[[ xX]\]/, "[ ]") +
        body.slice(prefix.length).replace(/[^`*_\[\]<>\\]/g, "") +
        ending,
    );
    units.push({ key: String(index), start, end });
    offset += Buffer.byteLength(line);
    index++;
  }
  return block ? null : { units, embedded, skeleton: skeleton.join("") };
}

/** Recognize complete, self-contained inline spans without rewriting source.
 * Reference links and relative destinations need document context and stay opaque. */
function inlineProse(source: string, links?: LinkPolicy, found?: Set<LinkKind>): boolean {
  let rest = source
    .replace(/(`+)([^`\r\n]+)\1/g, "span")
    .replace(/!?\[[^\[\]\r\n]*\]\((?:https?:\/\/|mailto:)[^\s()]+\)/g, "span");
  if (links) rest = contextualLinks(rest, links, found);
  rest = rest
    .replace(/(\*\*|__)(?=\S)([^*_\r\n]*?\S)\1/g, "span")
    .replace(/(\*|_)(?=\S)([^*_\r\n]*?\S)\1/g, "span");
  return !/[`*_~<>|\[\]\\]/.test(rest);
}

/** Links whose target depends on the document that holds them: a relative
 * destination on its directory, a fragment on its headings, a reference on its
 * link definitions. */
export type LinkKind = "relative" | "fragment" | "reference";
export type LinkPolicy = Partial<Record<LinkKind, boolean>>;

/** Replace the contextual links `links` admits with an opaque span, recording
 * each kind in `found`. A destination with an escape, an entity or a scheme,
 * and a label that is not printable ASCII (whose case folding this rule does
 * not model), is left in place, so its brackets keep the text protected. */
function contextualLinks(source: string, links: LinkPolicy, found?: Set<LinkKind>): string {
  const rest = source.replace(/!?\[[^\[\]\r\n]*\]\(([^\s()<>]+)\)/g, (link, destination: string) => {
    if (/[\\&]/.test(destination) || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(destination)) return link;
    const kind: LinkKind = destination.startsWith("#") ? "fragment" : "relative";
    if (!links[kind]) return link;
    found?.add(kind);
    return "span";
  });
  if (!links.reference) return rest;
  // Full, collapsed and shortcut references. `[label]:` begins a definition and
  // `[text](` an inline link this rule did not admit; both stay in place.
  return rest.replace(/!?\[([^\[\]\r\n]*)\](?:\[([^\[\]\r\n]*)\])?(?![\[(:])/g, (link, text: string, label?: string) => {
    const name = label ? label : text;
    if (!name.trim() || !/^[\x20-\x7e]+$/.test(name) || name.includes("\\")) return link;
    found?.add("reference");
    return "span";
  });
}

/** One document's scans, each computed on first use: its UTF-8 bytes and
 * opaque regions. Checks that ask about many offsets in the same document
 * share one, so the document is encoded and scanned once. */
export class MarkdownSource {
  private encoded?: Buffer;
  private regions?: Array<[number, number]>;
  constructor(readonly text: string) {}
  get bytes(): Buffer {
    return (this.encoded ??= Buffer.from(this.text));
  }
  get opaque(): Array<[number, number]> {
    return (this.regions ??= opaqueRegions(this.text));
  }
}
const scanned = (source: string | MarkdownSource) =>
  typeof source === "string" ? new MarkdownSource(source) : source;

/** Opaque source regions have local boundaries. Unknown/unclosed HTML protects
 * the remaining suffix, never unrelated prose before it. Offsets are characters. */
function opaqueRegions(source: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!,
      start = offset;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    const frontmatter = i === 0 && line.trim() === "---";
    const html = /^ {0,3}<([A-Za-z][\w-]*)\b/.exec(line);
    const comment = /^ {0,3}<!--/.test(line);
    if (fence || frontmatter || /^\s*</.test(line)) {
      let end = i;
      let htmlDepth = 0;
      const closes = (value: string) =>
        fence
          ? new RegExp(
              "^ {0,3}" + fence[1]![0] + "{" + fence[1]!.length + ",}\\s*$"
            ).test(value)
          : frontmatter
          ? value.trim() === "---"
          : comment
          ? value.includes("-->")
          : html
          ? (() => {
              for (const tag of value.matchAll(
                new RegExp("</?" + html[1] + "\\b[^>]*>", "gi")
              )) {
                if (tag[0].startsWith("</")) htmlDepth--;
                else if (!tag[0].endsWith("/>")) htmlDepth++;
              }
              return htmlDepth === 0;
            })()
          : false;
      if (fence || frontmatter || !closes(line)) {
        end = i + 1;
        while (end < lines.length && !closes(lines[end]!)) end++;
        end = Math.min(end, lines.length - 1);
      }
      // HTML block syntax can continue through the closing tag until a blank line.
      if (!fence && !frontmatter)
        while (end + 1 < lines.length && lines[end + 1]!.trim()) end++;
      // Include the following blank separator: changing it can change scope.
      if (end + 1 < lines.length && !lines[end + 1]!.trim()) end++;
      for (; i <= end; i++) offset += lines[i]!.length;
      i--;
      regions.push([start, offset]);
    } else offset += line.length;
  }
  return regions;
}

/** Deliberately modest prose policy: retain authored insertions without inventing
 * separators or treating code/data/link syntax as ordinary paragraph text. */
export function markdownProseInsertion(
  document: string | MarkdownSource,
  offset: number,
  additions: string[]
): boolean {
  const scan = scanned(document), source = scan.text, bytes = scan.bytes;
  const characterOffset = bytes
    .subarray(0, offset)
    .toString("utf8").length;
  if (
    scan.opaque.some(
      ([start, end]) =>
        characterOffset >= start &&
        (characterOffset < end ||
          (end === source.length && characterOffset === end))
    )
  )
    return false;
  const prefix = bytes.subarray(0, offset).toString("utf8"),
    suffix = bytes.subarray(offset).toString("utf8");
  const before = prefix.slice(prefix.lastIndexOf("\n") + 1),
    after = suffix.split("\n", 1)[0]!;
  const line = (before + after).replace(/\r$/, "");
  const safeLine = (line: string) => {
    if (/^\s{4}|^\t|^\s*(?:[-=*_]\s*){3,}$/.test(line)) return false;
    const body = line.replace(
      /^(?:#{1,6}\s+| {0,3}[-+*]\s+(?:\[[ xX]\]\s+)?| {0,3}\d+[.)]\s+)/,
      ""
    );
    return inlineProse(body);
  };
  if (!safeLine(line)) return false;
  // Do not insert into a heading/list marker or task checkbox.
  const marker =
    /^(?:#{1,6}\s+| {0,3}[-+*]\s+(?:\[[ xX]\]\s+)?| {0,3}\d+[.)]\s+)/.exec(
      line
    )?.[0] ?? "";
  if (before.length > 0 && before.length < marker.length) return false;
  if (
    before.length &&
    (!inlineProse(before.slice(marker.length)) || !inlineProse(after))
  )
    return false;
  if (before.endsWith("\r") && suffix.startsWith("\n")) return false;
  const following = suffix.slice(suffix.indexOf("\n") + 1).split("\n", 1)[0]!;
  if (suffix.includes("\n") && /^\s*(?:=+|-+)\s*$/.test(following))
    return false;
  if (!additions.every((text) => text.split(/\r?\n/).every(safeLine)))
    return false;
  if (additions.some((text) => /[\r\n]/.test(text))) {
    // Complete lines at a line boundary, or new paragraphs after the document.
    return (
      (before === "" && additions.every((text) => text.endsWith("\n"))) ||
      (offset === bytes.length &&
        additions.every((text) => /^(?:\r?\n){2}/.test(text)))
    );
  }
  // Inline prose must not create new structural markers at the start of a line.
  return (
    additions.every((text) => !/^(?:#{1,6}\s|[-+*]\s|\d+[.)]\s)/.test(text)) &&
    safeLine(before + additions.join("") + after)
  );
}

/** Transfer replay already proves source identity and destination. This signature
 * permits plain paragraph insertion/removal without treating changed host syntax
 * or embedded programs as prose. editSource independence keeps inline formatting
 * protected; explicit transfer replay may carry complete formatted prose spans.
 * This is a policy guard, never an identity map. */
export function markdownTransferShape(document: string | MarkdownSource, formattedProse = true): string | null {
  const scan = scanned(document), source = scan.text;
  const protectedBlocks: string[] = [];
  let cursor = 0;
  const protectProse = (text: string) => {
    for (const block of text.split(/(?:\r?\n){2,}/)) {
      if (!block.trim()) continue;
      if (
        block
          .split(/\r?\n/)
          .some(
            (line) =>
              !inlineProse(line) || (!formattedProse && /[`*_~<>|\[\]\\]/.test(line)) ||
              /^(?:[ \t]| {0,3}(?:#{1,6}(?:\s|$)|>|[-+]\s|\d+[.)]\s|[-=]+\s*$))/.test(
                line
              )
          )
      )
        protectedBlocks.push(block);
    }
  };
  for (const [start, end] of scan.opaque) {
    protectProse(source.slice(cursor, start));
    protectedBlocks.push(source.slice(start, end));
    cursor = end;
  }
  protectProse(source.slice(cursor));
  return JSON.stringify(protectedBlocks);
}

const proseLine = /^(?:[ \t]| {0,3}(?:#{1,6}(?:\s|$)|>|[-+]\s|\d+[.)]\s|[-=]+\s*$))/;
const blockStart = /^(?:#{1,6}(?:\s|$)|>|[-+*]\s|\d+[.)]\s|[-=]+\s*$)/;
const itemLine = /^([-+*]) (\[[ xX]\] )?(\S(?:.*\S)?)\s*$/;
const delimiterCell = /^\s*:?-+:?\s*$/;

/** The structure an identity-verified transfer may move list items and table
 * rows within, and the contextual links it may carry.
 *
 * Every block keeps its exact source in the shape, as `markdownTransferShape`
 * does, except three kinds that render independently of their neighbours:
 *
 * - a plain paragraph (every line self-contained inline prose), omitted;
 * - a list host: a block of one or more single-line, top-level items with one
 *   bullet character, one space after the marker, and self-contained inline
 *   content that begins no other block. It is recorded as `list <bullet>`,
 *   without its items. Ordered, nested, indented, multi-line, loose-in-block
 *   and continuation items keep the whole block exact;
 * - a table host: a pipe table whose every line starts and ends with `|`, with
 *   no escapes, a delimiter row, and every row's cell count equal to the
 *   header's. It is recorded by its exact header and delimiter rows, without
 *   its body rows, whose cells are self-contained inline prose.
 *
 * So two versions have the same shape exactly when they have the same
 * sequence of exact protected blocks, list hosts by bullet and table hosts by
 * header; they may differ only in paragraphs, in list items within a host of
 * the same bullet, and in body rows within a table of the same columns and
 * alignment. Each of those renders from its own source and its host alone,
 * which is why reordering, moving or editing one cannot change another.
 *
 * `links` admits contextual links into that prose and records each kind used;
 * the caller proves each kind's binding (see `evaluateSourceTransfer`). */
export function markdownTransferStructure(
  document: string | MarkdownSource,
  links: LinkPolicy = {},
): { shape: string; links: Set<LinkKind> } {
  const scan = scanned(document), source = scan.text;
  const found = new Set<LinkKind>();
  const shape: string[] = [];
  // A host directly followed by an opaque region, with no blank line between,
  // may continue into it (a lazy continuation or table row), so it stays exact.
  const hosts = (text: string, followed: boolean) => {
    const blocks = text.split(/(?:\r?\n){2,}/);
    const open = followed && !/(?:\r?\n)[ \t]*\r?\n$/.test(text);
    const last = blocks.findLastIndex((block) => !!block.trim());
    for (const [index, block] of blocks.entries()) {
      if (!block.trim()) continue;
      if (open && index === last) {
        shape.push(block);
        continue;
      }
      const lines = block.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, "").split(/\r?\n/);
      // Record links only from a block this rule admits as prose.
      const uses = new Set<LinkKind>();
      const admitted = (text: string) => inlineProse(text, links, uses);
      if (lines.every((line) => admitted(line) && !proseLine.test(line))) {
        uses.forEach((kind) => found.add(kind));
        continue;
      }
      uses.clear();
      const items = lines.map((line) => itemLine.exec(line));
      if (
        items.every((item) => item && item[1] === items[0]![1] &&
          !blockStart.test(item[3]!) && admitted(item[3]!))
      ) {
        uses.forEach((kind) => found.add(kind));
        shape.push(`list ${items[0]![1]}`);
        continue;
      }
      uses.clear();
      const cells = (line: string) =>
        /^\|.*\|\s*$/.test(line) ? line.trimEnd().slice(1, -1).split("|") : null;
      const rows = lines.map(cells);
      const width = rows[0]?.length ?? 0;
      if (
        lines.length >= 2 &&
        !block.includes("\\") &&
        rows.every((row) => row?.length === width) &&
        rows[1]!.every((cell) => delimiterCell.test(cell)) &&
        rows.slice(2).every((row) => row!.every((cell) => !cell.trim() || admitted(cell.trim())))
      ) {
        uses.forEach((kind) => found.add(kind));
        shape.push(`table ${lines[0]}\n${lines[1]}`);
        continue;
      }
      shape.push(block);
    }
  };
  let cursor = 0;
  for (const [start, end] of scan.opaque) {
    hosts(source.slice(cursor, start), true);
    shape.push(source.slice(start, end));
    cursor = end;
  }
  hosts(source.slice(cursor), false);
  return { shape: JSON.stringify(shape), links: found };
}

/** Ordinary list editing is local source work, not an opaque host rewrite.
 * Only normalize complete affected lines of plain prose/list items; fences,
 * headings, links, HTML, indented code and reference syntax stay protected. */
export function markdownListEdit(document: string | MarkdownSource, start: number, end: number, text: string): boolean {
  const scan = scanned(document), source = scan.text, bytes = scan.bytes;
  const prefix = bytes.subarray(0, start).toString("utf8");
  const suffix = bytes.subarray(end).toString("utf8");
  const first = prefix.lastIndexOf("\n") + 1;
  const last = suffix.indexOf("\n");
  const tail = end > 0 && bytes[end - 1] === 10 && (!text || text.endsWith("\n"))
    ? "" : last < 0 ? suffix : suffix.slice(0, last);
  const head = prefix.slice(first);
  if (scan.opaque.some(([a,b]) => first < b && source.length - suffix.length + tail.length >= a)) return false;
  const before = head + bytes.subarray(start, end).toString("utf8") + tail;
  const after = head + text + tail;
  const marker = /^ *(?:[-+*]|\d+[.)])(?:[ \t]+|$)/;
  const safe = (line: string) => {
    if (!line.trim()) return true;
    if (/^\s*(?:[-=*_]\s*){3,}$/.test(line)) return false;
    const match = marker.exec(line);
    if (!match && /^(?:\s|#{1,6}(?:\s|$)|>|[-=]+\s*$)/.test(line)) return false;
    const prose = match ? line.slice(match[0].length) : line;
    return !/[`*_~<>|\[\]\\]/.test(prose) && inlineProse(prose);
  };
  return (before.split(/\r?\n/).some(line => marker.test(line)) || after.split(/\r?\n/).some(line => marker.test(line))) &&
    [before, after].every(value => value.split(/\r?\n/).every(safe));
}
