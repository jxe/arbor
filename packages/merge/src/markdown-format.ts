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
