import type { LogicalPath } from "./identifiers.ts";
import { canonicalNodePath } from "./logical-path.ts";
import { decodeStableKey, encodeStableKey } from "./node-key.ts";

export interface ResolvedLocatorState {
  /** `;overstory-config`: the locator names the configuration of the tree whose root it names. */
  configuration?: true;
  /**
   * `;overstory-invite=<code>`: the invitation code a join link carries on an
   * account locator. A secret for the claim, never part of what the locator
   * names: builders of canonical and identity forms leave it out.
   */
  invite?: string;
  stableKey: string | null;
  revision: string | null;
  applicationQuery: string | null;
  contentFragment: string | null;
}

export type ResolvedLink =
  | ({ kind: "local"; path: LogicalPath } & ResolvedLocatorState)
  | ({
    kind: "overstory";
    authority: { dns: string } | { treeID: string };
    path: LogicalPath;
  } & ResolvedLocatorState)
  | { kind: "system"; raw: string }
  | { kind: "overlay"; raw: string }
  | { kind: "external"; href: string }
  | { kind: "fragment"; contentFragment: string }
  | null;

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;
const PARAMETER_MARKER = ";overstory-";
const REVISION_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TREE_ID_AUTHORITY = /^tr_[a-z2-7]+$/;
const MARKDOWN_KEY_PREFIX = "overstory-key=";
const CONFIGURATION_PARAMETER = "overstory-config";
const INVITE_PARAMETER = /^overstory-invite=([A-Za-z0-9._~-]+)$/;
const SCHEME = "overstory://";

// Rename 002: the spellings from before the Overstory rename, read wherever a
// locator is parsed and never written. Remove with `normalizeLegacyLocator`.
const LEGACY_SCHEME = "arbor://";
const LEGACY_PARAMETER = /;arbor-(?=key=|rev=|config$)/g;
const LEGACY_KEY_FRAGMENT = "#arbor-key=";

/**
 * Rename 002: respell a locator written before the Overstory rename. `arbor://`
 * becomes `overstory://`; on the final path segment `;arbor-key=`, `;arbor-rev=`
 * and a trailing `;arbor-config` become their `;overstory-` forms; a fragment
 * beginning `arbor-key=` becomes `overstory-key=`. It accepts an absolute
 * locator, a relative or tree-rooted href, or a bare `tr_x;arbor-config` tree
 * reference, and returns anything else (a URL in another scheme included)
 * unchanged. Queries and other fragments are never touched. Every parser in
 * this package applies it first, so parsed results and whatever is built from
 * them carry only the new spelling; partial parsers elsewhere do the same.
 */
export function normalizeLegacyLocator(text: string): string {
  let scheme = "";
  let rest = text;
  if (text.startsWith(LEGACY_SCHEME)) {
    scheme = SCHEME;
    rest = text.slice(LEGACY_SCHEME.length);
  } else if (text.startsWith(SCHEME)) {
    scheme = SCHEME;
    rest = text.slice(SCHEME.length);
  } else if (SCHEME_PATTERN.test(text)) {
    return text;
  }
  const fragmentStart = rest.indexOf("#");
  const beforeFragment = fragmentStart === -1 ? rest : rest.slice(0, fragmentStart);
  const fragment = fragmentStart === -1 ? "" : rest.slice(fragmentStart);
  const queryStart = beforeFragment.indexOf("?");
  const path = queryStart === -1 ? beforeFragment : beforeFragment.slice(0, queryStart);
  const query = queryStart === -1 ? "" : beforeFragment.slice(queryStart);
  const segmentStart = path.lastIndexOf("/") + 1;
  const segment = path.slice(segmentStart).replace(LEGACY_PARAMETER, PARAMETER_MARKER);
  const respelledFragment = fragment.startsWith(LEGACY_KEY_FRAGMENT)
    ? `#${MARKDOWN_KEY_PREFIX}${fragment.slice(LEGACY_KEY_FRAGMENT.length)}`
    : fragment;
  return `${scheme}${path.slice(0, segmentStart)}${segment}${query}${respelledFragment}`;
}

function splitOnce(value: string, separator: string): [string, string | null] {
  const index = value.indexOf(separator);
  return index === -1
    ? [value, null]
    : [value.slice(0, index), value.slice(index + separator.length)];
}

/**
 * Split the final raw segment's `;overstory-key=…;overstory-rev=…` parameter block from the path.
 * Parameters appear in that order at most once each; anything else after the first
 * `;overstory-` marker is invalid rather than path data. `;overstory-config` takes no value
 * and stands alone; so does `;overstory-invite=<code>`.
 */
function segmentParameters(rawPathWithParameters: string): {
  rawPath: string;
  configuration?: true;
  invite?: string;
  stableKey: string | null;
  revision: string | null;
} | null {
  const segmentStart = rawPathWithParameters.lastIndexOf("/") + 1;
  const marker = rawPathWithParameters.indexOf(PARAMETER_MARKER, segmentStart);
  if (marker === -1) return { rawPath: rawPathWithParameters, stableKey: null, revision: null };
  if (rawPathWithParameters.slice(marker + 1) === CONFIGURATION_PARAMETER) {
    return { rawPath: rawPathWithParameters.slice(0, marker), configuration: true, stableKey: null, revision: null };
  }
  const invite = rawPathWithParameters.slice(marker + 1).match(INVITE_PARAMETER)?.[1];
  if (invite) return { rawPath: rawPathWithParameters.slice(0, marker), invite, stableKey: null, revision: null };
  let stableKey: string | null = null;
  let revision: string | null = null;
  let stage = 0;
  for (const parameter of rawPathWithParameters.slice(marker + 1).split(";")) {
    const [name, value] = splitOnce(parameter, "=");
    if (!value) return null;
    if (name === "overstory-key" && stage === 0) {
      stableKey = decodeStableKey(value);
      if (!stableKey) return null;
      stage = 1;
    } else if (name === "overstory-rev" && stage <= 1 && REVISION_PATTERN.test(value)) {
      revision = value;
      stage = 2;
    } else {
      return null;
    }
  }
  return { rawPath: rawPathWithParameters.slice(0, marker), stableKey, revision };
}

function locatorState(destination: string, fragment: string | null): {
  rawPath: string;
  state: ResolvedLocatorState;
} | null {
  const [rawPathWithParameters, applicationQuery] = splitOnce(destination, "?");
  const parameters = segmentParameters(rawPathWithParameters);
  if (!parameters) return null;
  const { rawPath, stableKey: pathStableKey, revision, configuration, invite } = parameters;
  // A configuration is addressed as a whole: no key, fragment or query goes with it.
  // Nor with an invitation, which names an account and nothing inside it.
  if ((configuration || invite) && (fragment !== null || applicationQuery !== null)) return null;

  const markdownKeyToken = fragment?.startsWith(MARKDOWN_KEY_PREFIX)
    ? fragment.slice(MARKDOWN_KEY_PREFIX.length)
    : null;
  const markdownStableKey = markdownKeyToken !== null ? decodeStableKey(markdownKeyToken) : null;
  if (markdownKeyToken !== null && !markdownStableKey) return null;
  if (pathStableKey && markdownStableKey) return null;

  return {
    rawPath,
    state: {
      ...(configuration ? { configuration } : {}),
      ...(invite ? { invite } : {}),
      stableKey: pathStableKey ?? markdownStableKey,
      revision,
      applicationQuery,
      contentFragment: fragment && markdownStableKey === null ? fragment : null,
    },
  };
}

/** Canonicalize a path that is already decoded, without interpreting `%` again. */
function canonicalDecodedNodePath(input: string): LogicalPath | null {
  if (input.includes("\\") || input.includes("\0")) return null;
  const parts = input.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) return null;
  let path = `/${parts.join("/")}`;
  if (path === "/_index.md") return "/";
  if (path.endsWith("/_index.md")) path = path.slice(0, -"/_index.md".length) || "/";
  else if (path.endsWith(".md")) path = path.slice(0, -3) || "/";
  return path;
}

/** Decode each raw path component exactly once and resolve dot segments. */
function resolveTreePath(sourceDirectory: LogicalPath, rawDestination: string): LogicalPath | null {
  let stack: string[];
  if (rawDestination.startsWith("/")) {
    stack = [];
  } else {
    try {
      const base = canonicalDecodedNodePath(sourceDirectory);
      if (!base) return null;
      stack = base.split("/").filter(Boolean);
    } catch {
      return null;
    }
  }

  const rawSegments = rawDestination.split("/");
  for (const rawSegment of rawSegments) {
    if (!rawSegment) continue;
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) return null;
    if (segment === ".") continue;
    if (segment === "..") {
      if (!stack.length) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return canonicalDecodedNodePath(`/${stack.join("/")}`);
}

function parseOverstoryURL(href: string): ResolvedLink {
  const withoutScheme = href.slice(SCHEME.length);
  const [destination, fragment] = splitOnce(withoutScheme, "#");
  const parsed = locatorState(destination, fragment);
  if (!parsed) return null;
  const [authorityPart, ...pathParts] = parsed.rawPath.split("/");
  if (!authorityPart) return null;

  // `_` cannot occur in a DNS label, so a `tr_` authority is a TreeID and nothing else.
  if (authorityPart.startsWith("tr_") && !TREE_ID_AUTHORITY.test(authorityPart)) return null;
  const authority = TREE_ID_AUTHORITY.test(authorityPart)
    ? { treeID: authorityPart }
    : { dns: authorityPart };
  const path = resolveTreePath("/", pathParts.join("/"));
  if (path === null) return null;
  // `overstory://<TreeID>;overstory-config` names the tree's root; any other path is invalid.
  if (parsed.state.configuration && "treeID" in authority && path !== "/") return null;
  // An invitation is claimed at a host, so only a locator with a DNS authority carries one.
  if (parsed.state.invite && "treeID" in authority) return null;
  return { kind: "overstory", authority, path, ...parsed.state };
}

/**
 * Resolve an href found in a Markdown source. A relative href resolves against
 * `sourceDirectory`, the tree directory holding the source file (see
 * `markdownSourceDirectory`), exactly as an ordinary Markdown reader resolves
 * it. `x.md`, `x/_index.md`, `x/` and `x` all name the node `x`.
 */
export function resolveLogicalURL(sourceDirectory: LogicalPath, href: string): ResolvedLink {
  // Rename 002: old spellings are read as the new ones.
  const raw = normalizeLegacyLocator(href.trim());
  if (!raw) return null;

  if (raw.startsWith("#")) {
    const contentFragment = raw.slice(1);
    if (!contentFragment || contentFragment.startsWith(MARKDOWN_KEY_PREFIX)) return null;
    return { kind: "fragment", contentFragment };
  }

  const scheme = raw.match(SCHEME_PATTERN)?.[1]?.toLowerCase();
  if (scheme === "overstory") return raw.startsWith(SCHEME) ? parseOverstoryURL(raw) : null;
  if (scheme === "system") return { kind: "system", raw };
  if (scheme === "local") return { kind: "overlay", raw };
  if (scheme) return { kind: "external", href: raw };

  const [destination, fragment] = splitOnce(raw, "#");
  const parsed = locatorState(destination, fragment);
  if (!parsed) return null;
  // An invitation goes only on an `overstory://` account locator.
  if (parsed.state.invite) return null;
  const path = resolveTreePath(sourceDirectory, parsed.rawPath);
  if (path === null) return null;
  return { kind: "local", path, ...parsed.state };
}

/**
 * Where a node's Markdown body lives. A `sibling` body is `x.md` beside the
 * (possibly absent) directory `x/`, which includes every leaf document; an
 * `index` body is `x/_index.md`. `null` is a node with no stored body.
 */
export type MarkdownBodyOrigin = "sibling" | "index";

/** The tree directory holding a node's body file, against which its relative links resolve. */
export function markdownSourceDirectory(nodePath: LogicalPath, body: MarkdownBodyOrigin | null): LogicalPath {
  const path = decodedPath(nodePath);
  if (body !== "sibling" || path === "/") return path;
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

/** The file a Markdown link names for a node: its body file, or its logical path when it has none. */
export function markdownLinkFile(nodePath: LogicalPath, body: MarkdownBodyOrigin | null): string {
  const path = decodedPath(nodePath);
  if (!body) return path;
  if (body === "sibling" && path !== "/") return `${path}.md`;
  return path === "/" ? "/_index.md" : `${path}/_index.md`;
}

/** Logical paths are already decoded: `%` is data here. */
function decodedPath(input: string): LogicalPath {
  const path = canonicalDecodedNodePath(input);
  if (path === null) throw new TypeError(`Invalid logical path: ${input}`);
  return path;
}

function encodeLinkSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A relative reference from a source directory to a tree file or node, one encoded segment at a time. */
export function relativeFileReference(sourceDirectory: LogicalPath, targetFile: string): string {
  const from = decodedPath(sourceDirectory).split("/").filter(Boolean);
  const to = targetFile.split("/").filter(Boolean);
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared += 1;
  // A node that is the source directory itself is named from its parent.
  if (shared === to.length && shared > 0) shared -= 1;
  const segments = [...Array(from.length - shared).fill(".."), ...to.slice(shared).map(encodeLinkSegment)];
  return segments.join("/") || ".";
}

function querySuffix(applicationQuery: string | null | undefined): string {
  return applicationQuery === null || applicationQuery === undefined ? "" : `?${applicationQuery}`;
}

export interface MarkdownLinkTarget {
  path: LogicalPath;
  body: MarkdownBodyOrigin | null;
  stableKey?: string | null;
  revision?: string | null;
  applicationQuery?: string | null;
  contentFragment?: string | null;
}

/**
 * The href a Markdown writer emits for a node in the same tree: the target's
 * file relative to the source directory, so any Markdown reader follows it,
 * with the stable key as the `#overstory-key=` fragment. A key together with a
 * content fragment, or a revision, needs the `;overstory-key=`/`;overstory-rev=`
 * segment form.
 */
export function buildMarkdownLink(sourceDirectory: LogicalPath, target: MarkdownLinkTarget): string {
  const reference = relativeFileReference(sourceDirectory, markdownLinkFile(target.path, target.body));
  if (target.revision || (target.stableKey && target.contentFragment)) return buildNetworkLocator(reference, target);
  const query = querySuffix(target.applicationQuery);
  if (target.stableKey) return `${reference}${query}#${MARKDOWN_KEY_PREFIX}${encodeStableKey(target.stableKey)}`;
  return target.contentFragment ? `${reference}${query}#${target.contentFragment}` : `${reference}${query}`;
}

/** Attach identity and revision to the final raw path segment for wire and hosted hrefs. */
export function buildNetworkLocator(
  rawPath: string,
  options: {
    stableKey?: string | null;
    revision?: string | null;
    applicationQuery?: string | null;
    contentFragment?: string | null;
  } = {},
): string {
  const keyed = options.stableKey ? `${rawPath};overstory-key=${encodeStableKey(options.stableKey)}` : rawPath;
  const pinned = options.revision ? `${keyed};overstory-rev=${options.revision}` : keyed;
  const fragment = options.contentFragment === null || options.contentFragment === undefined
    ? ""
    : `#${options.contentFragment}`;
  return `${pinned}${querySuffix(options.applicationQuery)}${fragment}`;
}

export function buildOverstoryLocator(
  tree: string,
  path: LogicalPath,
  stableKey?: string | null,
): string {
  return `overstory://${tree}${buildNetworkLocator(canonicalNodePath(path), { stableKey })}`;
}

/**
 * The join link for an account: its `overstory://` locator carrying the
 * invitation code as `;overstory-invite=<code>` (accounts §1.2). `account` is
 * the account's locator or URL at its host, without parameters, query or
 * fragment. The code is a secret: the result is for handing to the invited
 * person, never for comparing or pinning identities.
 */
export function buildInviteLocator(account: string, code: string): string {
  const match = account.match(/^(?:overstory|https?):\/\/([^/?#;]+)(\/[^?#;]*)?$/);
  if (!match || match[1]!.startsWith("tr_")) throw new TypeError(`Not an account locator: ${account}`);
  const locator = `${SCHEME}${match[1]}${(match[2] ?? "").replace(/\/+$/, "") || "/"};overstory-invite=${code}`;
  const resolved = resolveLogicalURL("/", locator);
  if (resolved?.kind !== "overstory" || resolved.invite !== code) throw new TypeError("Invalid invitation code or account locator");
  return locator;
}

/**
 * A markdown href that names a node, with the tree it names it in.
 * `tree` is null when the href is relative to the document that contains it.
 */
export interface ResolvedNodeTarget {
  tree: string | null;
  path: LogicalPath;
  stableKey: string | null;
}

/**
 * Resolve a markdown href to the node it points at, accepting both relative hrefs and `overstory://`
 * locators. Returns null for anything that does not name a node: external, system and overlay URLs,
 * bare `#fragment` anchors, and `overstory://` URLs on a DNS authority (those name another workspace,
 * not a node this tree can resolve).
 */
export function resolveNodeTarget(sourceDirectory: LogicalPath, href: string): ResolvedNodeTarget | null {
  const resolved = resolveLogicalURL(sourceDirectory, href);
  if (resolved?.kind === "local") return { tree: null, path: resolved.path, stableKey: resolved.stableKey };
  if (resolved?.kind !== "overstory" || !("treeID" in resolved.authority)) return null;
  return { tree: resolved.authority.treeID, path: resolved.path, stableKey: resolved.stableKey };
}

/**
 * Rewrite a node link to name `target`, retaining its key, revision, query and
 * content fragment. A relative href is rewritten against `sourceDirectory`; an
 * `overstory://` locator stays one.
 */
export function rewriteLocalLinkPath(
  sourceDirectory: LogicalPath,
  href: string,
  target: { path: LogicalPath; body: MarkdownBodyOrigin | null },
): string | null {
  const resolved = resolveLogicalURL(sourceDirectory, href);
  if (resolved?.kind === "overstory") {
    if (!("treeID" in resolved.authority)) return null;
    return buildOverstoryLocator(resolved.authority.treeID, target.path, resolved.stableKey);
  }
  if (resolved?.kind !== "local") return null;
  return buildMarkdownLink(sourceDirectory, { ...resolved, ...target });
}
