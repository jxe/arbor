import type { LogicalPath, PageID } from "./protocol.ts";
import { canonicalNodePath, nodeDisplayName, PathEscapeError } from "./logical-path.ts";

/**
 * One resolver for every Markdown link destination form in spec/urls.md.
 *
 * Every Markdown document resolves relative destinations from its canonical
 * logical address as a directory-like base, regardless of whether the body is
 * `x.md`, `x/_index.md`, or an implicit projection. Compatibility spellings
 * (`.md`, `/_index.md`, `tree:tr_…`) are accepted on input and canonicalized;
 * they are never emitted.
 */
export type ResolvedLink =
  | { kind: "local"; path: LogicalPath; pageID?: PageID; fragment?: string }
  | {
    kind: "arbor";
    authority: { dns: string } | { treeID: string };
    path: LogicalPath;
    pageID?: PageID;
    fragment?: string;
  }
  | { kind: "system"; raw: string }
  | { kind: "overlay"; raw: string }
  | { kind: "external"; href: string }
  | { kind: "fragment"; pageID: PageID }
  | null;

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;
const PAGE_ID_PATTERN = /^[a-z0-9]{6}$/;

function splitFragment(href: string): { destination: string; fragment: string | null } {
  const index = href.indexOf("#");
  if (index === -1) return { destination: href, fragment: null };
  return { destination: href.slice(0, index), fragment: href.slice(index + 1) };
}

function fragmentPageID(fragment: string | null): PageID | undefined {
  return fragment && PAGE_ID_PATTERN.test(fragment) ? fragment : undefined;
}

/**
 * Resolve a destination path against a document base using ordinary
 * URL-reference dot semantics, failing (null) on traversal above the tree
 * root rather than clamping to it.
 */
function resolveTreePath(baseDocumentPath: LogicalPath, destination: string): LogicalPath | null {
  const withoutQuery = destination.split("?")[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return null;
  }
  decoded = decoded.replaceAll("\\", "/");
  if (decoded.includes("\0")) return null;

  let stack: string[];
  if (decoded.startsWith("/")) {
    stack = [];
  } else {
    try {
      stack = canonicalNodePath(baseDocumentPath).split("/").filter(Boolean);
    } catch {
      return null;
    }
  }
  for (const segment of decoded.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!stack.length) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  try {
    return canonicalNodePath(`/${stack.join("/")}`);
  } catch (error) {
    if (error instanceof PathEscapeError) return null;
    throw error;
  }
}

function parseArborURL(href: string): ResolvedLink {
  const withoutScheme = href.slice("arbor://".length);
  const { destination, fragment } = splitFragment(withoutScheme);
  const [authorityPart, ...pathParts] = destination.split("/");
  if (!authorityPart) return null;
  let authority: { dns: string } | { treeID: string };
  let pathSegments = pathParts;
  if (authorityPart === "tree") {
    const [treeID, ...rest] = pathParts;
    if (!treeID) return null;
    authority = { treeID };
    pathSegments = rest;
  } else {
    authority = { dns: authorityPart };
  }
  const path = resolveTreePath("/", pathSegments.join("/"));
  if (path === null) return null;
  return { kind: "arbor", authority, path, pageID: fragmentPageID(fragment), fragment: fragment || undefined };
}

export function resolveLogicalURL(baseDocumentPath: LogicalPath, href: string): ResolvedLink {
  const raw = href.trim();
  if (!raw) return null;

  if (raw.startsWith("#")) {
    const fragment = raw.slice(1);
    const pageID = fragmentPageID(fragment);
    return pageID ? { kind: "fragment", pageID } : null;
  }

  const scheme = raw.match(SCHEME_PATTERN)?.[1]?.toLowerCase();
  if (scheme === "arbor") {
    return raw.startsWith("arbor://") ? parseArborURL(raw) : null;
  }
  if (scheme === "tree") {
    // Compatibility spelling `tree:tr_…/path`, normalized to the arbor://tree authority.
    return parseArborURL(`arbor://tree/${raw.slice("tree:".length).replace(/^\/+/, "")}`);
  }
  if (scheme === "system") return { kind: "system", raw };
  if (scheme === "local") return { kind: "overlay", raw };
  if (scheme) return { kind: "external", href: raw };

  const { destination, fragment } = splitFragment(raw);
  const path = resolveTreePath(baseDocumentPath, destination);
  if (path === null) return null;
  return { kind: "local", path, pageID: fragmentPageID(fragment), fragment: fragment || undefined };
}

/**
 * The shortest relative spelling of `to` from the document base `from`,
 * suitable for authored Markdown links and structural row healing.
 */
export function relativeLogicalReference(fromInput: LogicalPath, toInput: LogicalPath): string {
  const from = canonicalNodePath(fromInput).split("/").filter(Boolean);
  const to = canonicalNodePath(toInput).split("/").filter(Boolean);
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared += 1;
  return [...Array(from.length - shared).fill(".."), ...to.slice(shared)].join("/") || nodeDisplayName(toInput);
}

/**
 * The canonical authored spelling of a link from one document to another:
 * the shortest relative path, carrying the target's durable `PageID` as a
 * fragment when known (spec/urls.md §3).
 */
export function buildCanonicalLink(
  fromInput: LogicalPath,
  target: { path: LogicalPath; pageID?: PageID },
): string {
  const reference = relativeLogicalReference(fromInput, target.path);
  return target.pageID ? `${reference}#${target.pageID}` : reference;
}
