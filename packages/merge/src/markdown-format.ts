export interface MarkdownLayout {
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

/** Deliberately modest prose policy: retain authored insertions without inventing
 * separators or treating code/data/link syntax as ordinary paragraph text. */
export function markdownProseInsertion(
  source: string,
  offset: number,
  additions: string[],
): boolean {
  const layout = markdownLayout(source);
  if (
    !layout ||
    layout.embedded.some((e) => offset >= e.start && offset <= e.end)
  )
    return false;
  // Raw HTML can span otherwise ordinary-looking lines. This analyzer does not
  // yet establish those boundaries, so leave such documents to review.
  if (/^\s*</m.test(source)) return false;
  const bytes = Buffer.from(source),
    prefix = bytes.subarray(0, offset).toString("utf8"),
    suffix = bytes.subarray(offset).toString("utf8");
  const before = prefix.slice(prefix.lastIndexOf("\n") + 1),
    after = suffix.split("\n", 1)[0]!;
  const line = (before + after).replace(/\r$/, "");
  const safeLine = (line: string) => {
    if (/^\s{4}|^\t|^\s*(?:[-=*_]\s*){3,}$/.test(line)) return false;
    const body = line.replace(
      /^(?:#{1,6}\s+| {0,3}[-+*]\s+(?:\[[ xX]\]\s+)?| {0,3}\d+[.)]\s+)/,
      "",
    );
    return !/[`~|\[\]<>\\*_]/.test(body);
  };
  if (!safeLine(line)) return false;
  // Do not insert into a heading/list marker or task checkbox.
  const marker =
    /^(?:#{1,6}\s+| {0,3}[-+*]\s+(?:\[[ xX]\]\s+)?| {0,3}\d+[.)]\s+)/.exec(
      line,
    )?.[0] ?? "";
  if (before.length > 0 && before.length < marker.length) return false;
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
