import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";
import { parseMarkdown } from "@ovst/protocol";

/** The scalar text of each of a map's keys, or null when a key is not a plain scalar. */
function scalarKeys(map: YAMLMap): Array<string | null> {
  return map.items.map((pair) => isScalar(pair.key) && typeof pair.key.value === "string" ? pair.key.value : null);
}

/**
 * A community `_index.md` with its pending invitation entry replaced by the
 * claimed member, or null unless exactly one entry is that invitation.
 *
 * The frontmatter is read as YAML, so the entry is found however it is laid
 * out: block or flow style, either key order, quoted or plain values, any
 * line ending, comments around it. The entry is the `members` item whose map
 * has exactly the keys `handle` and `inviteDigest` with these values. Only
 * that node's own source range is replaced, from its first key to the end of
 * its last value (the braces of a flow map included); every other byte of the
 * document, comments and line endings among them, is left as written.
 */
export function claimInvitationEntry(source: string, handle: string, inviteDigest: string, profileTree: string): string | null {
  // The same split the profile reader uses, so both see one frontmatter.
  const frontmatter = parseMarkdown(source).frontmatterSource;
  if (frontmatter === null) return null;
  const bodyStart = frontmatter.indexOf("\n") + 1;
  const closingLine = frontmatter.replace(/\r?\n$/, "").lastIndexOf("\n") + 1;
  if (bodyStart <= 0 || closingLine < bodyStart) return null;
  const body = frontmatter.slice(bodyStart, closingLine);

  const document = parseDocument(body);
  if (document.errors.length) return null;
  const members = document.get("members", true);
  if (!isSeq(members)) return null;
  const matches = members.items.filter((item): item is YAMLMap => {
    if (!isMap(item) || item.items.length !== 2) return false;
    const keys = scalarKeys(item);
    return keys.includes("handle") && keys.includes("inviteDigest")
      && item.get("handle") === handle && item.get("inviteDigest") === inviteDigest;
  });
  if (matches.length !== 1) return null;
  const entry = matches[0]!;

  const profile = JSON.stringify(`overstory://${profileTree}/`), name = JSON.stringify(handle);
  let start: number, end: number, replacement: string;
  if (entry.flow) {
    if (!entry.range) return null;
    [start, end] = entry.range;
    replacement = `{ profile: ${profile}, handle: ${name} }`;
  } else {
    const first = entry.items[0]!.key, last = entry.items[1]!.value;
    if (!isScalar(first) || !isScalar(last) || !first.range || !last.range) return null;
    start = first.range[0];
    end = last.range[1];
    // The second key sits in the column the first one starts in.
    const column = start - (body.lastIndexOf("\n", start - 1) + 1);
    const newline = body.includes("\r\n") ? "\r\n" : "\n";
    replacement = `profile: ${profile}${newline}${" ".repeat(column)}handle: ${name}`;
  }
  const claimed = `${source.slice(0, bodyStart + start)}${replacement}${source.slice(bodyStart + end)}`;

  // The result must read back as the same list with this one entry claimed.
  const reread = parseMarkdown(claimed).frontmatter.members;
  const index = members.items.indexOf(entry);
  const written = Array.isArray(reread) && reread.length === members.items.length ? reread[index] as Record<string, unknown> | null : null;
  if (!written || typeof written !== "object" || Object.keys(written).length !== 2
    || written.profile !== `overstory://${profileTree}/` || written.handle !== handle) return null;
  return claimed;
}
