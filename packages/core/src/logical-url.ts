import type { LogicalPath } from "./identifiers.ts";
import { canonicalNodePath, nodeDisplayName } from "./logical-path.ts";
import { decodeStableKey, encodeStableKey, pageIDFromStableKey } from "./node-key.ts";

export interface ResolvedLocatorState {
  stableKey: string | null;
  revision: string | null;
  applicationQuery: string | null;
  contentFragment: string | null;
  /** Input-only candidate. A PageID owner index must prove it unique. */
  legacyStableKeyCandidate: string | null;
}

export type ResolvedLink =
  | ({ kind: "local"; path: LogicalPath } & ResolvedLocatorState)
  | ({
    kind: "arbor";
    authority: { dns: string } | { treeID: string };
    path: LogicalPath;
  } & ResolvedLocatorState)
  | { kind: "system"; raw: string }
  | { kind: "overlay"; raw: string }
  | { kind: "external"; href: string }
  | {
    kind: "fragment";
    contentFragment: string;
    /** Input-only candidate. A PageID owner index must prove it unique. */
    legacyStableKeyCandidate: string;
  }
  | null;

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;
const PARAMETER_MARKER = ";arbor-";
const REVISION_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TREE_ID_AUTHORITY = /^tr_[a-z2-7]+$/;
const MARKDOWN_KEY_PREFIX = "arbor-key=";

function splitOnce(value: string, separator: string): [string, string | null] {
  const index = value.indexOf(separator);
  return index === -1
    ? [value, null]
    : [value.slice(0, index), value.slice(index + separator.length)];
}

/**
 * Split the final raw segment's `;arbor-key=…;arbor-rev=…` parameter block from the path.
 * Parameters appear in that order at most once each; anything else after the first
 * `;arbor-` marker is invalid rather than path data.
 */
function segmentParameters(rawPathWithParameters: string): {
  rawPath: string;
  stableKey: string | null;
  revision: string | null;
} | null {
  const segmentStart = rawPathWithParameters.lastIndexOf("/") + 1;
  const marker = rawPathWithParameters.indexOf(PARAMETER_MARKER, segmentStart);
  if (marker === -1) return { rawPath: rawPathWithParameters, stableKey: null, revision: null };
  let stableKey: string | null = null;
  let revision: string | null = null;
  let stage = 0;
  for (const parameter of rawPathWithParameters.slice(marker + 1).split(";")) {
    const [name, value] = splitOnce(parameter, "=");
    if (!value) return null;
    if (name === "arbor-key" && stage === 0) {
      stableKey = decodeStableKey(value);
      if (!stableKey) return null;
      stage = 1;
    } else if (name === "arbor-rev" && stage <= 1 && REVISION_PATTERN.test(value)) {
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
  const { rawPath, stableKey: pathStableKey, revision } = parameters;

  const markdownKeyToken = fragment?.startsWith(MARKDOWN_KEY_PREFIX)
    ? fragment.slice(MARKDOWN_KEY_PREFIX.length)
    : null;
  const markdownStableKey = markdownKeyToken !== null ? decodeStableKey(markdownKeyToken) : null;
  if (markdownKeyToken !== null && !markdownStableKey) return null;
  if (pathStableKey && markdownStableKey) return null;

  const isMarkdownAlias = markdownStableKey !== null;
  const ordinaryFragment = fragment && !isMarkdownAlias ? fragment : null;
  const stableKey = pathStableKey ?? markdownStableKey;
  return {
    rawPath,
    state: {
      stableKey,
      revision,
      applicationQuery,
      contentFragment: ordinaryFragment,
      legacyStableKeyCandidate: stableKey ? null : ordinaryFragment,
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
function resolveTreePath(baseDocumentPath: LogicalPath, rawDestination: string): LogicalPath | null {
  let stack: string[];
  if (rawDestination.startsWith("/")) {
    stack = [];
  } else {
    try {
      const base = canonicalDecodedNodePath(baseDocumentPath);
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

function parseArborURL(href: string): ResolvedLink {
  const withoutScheme = href.slice("arbor://".length);
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
  return { kind: "arbor", authority, path, ...parsed.state };
}

export function resolveLogicalURL(baseDocumentPath: LogicalPath, href: string): ResolvedLink {
  const raw = href.trim();
  if (!raw) return null;

  if (raw.startsWith("#")) {
    const contentFragment = raw.slice(1);
    if (!contentFragment || contentFragment.startsWith(MARKDOWN_KEY_PREFIX)) return null;
    return { kind: "fragment", contentFragment, legacyStableKeyCandidate: contentFragment };
  }

  const scheme = raw.match(SCHEME_PATTERN)?.[1]?.toLowerCase();
  if (scheme === "arbor") return raw.startsWith("arbor://") ? parseArborURL(raw) : null;
  if (scheme === "system") return { kind: "system", raw };
  if (scheme === "local") return { kind: "overlay", raw };
  if (scheme) return { kind: "external", href: raw };

  const [destination, fragment] = splitOnce(raw, "#");
  const parsed = locatorState(destination, fragment);
  if (!parsed) return null;
  const path = resolveTreePath(baseDocumentPath, parsed.rawPath);
  if (path === null) return null;
  return { kind: "local", path, ...parsed.state };
}

export function relativeLogicalReference(fromInput: LogicalPath, toInput: LogicalPath): string {
  const from = canonicalNodePath(fromInput).split("/").filter(Boolean);
  const to = canonicalNodePath(toInput).split("/").filter(Boolean);
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared += 1;
  return [...Array(from.length - shared).fill(".."), ...to.slice(shared)].join("/") || nodeDisplayName(toInput);
}

function querySuffix(applicationQuery: string | null | undefined): string {
  return applicationQuery === null || applicationQuery === undefined ? "" : `?${applicationQuery}`;
}

/** Emit the ordinary-Markdown-compatible stable-key alias. */
export function buildCanonicalLink(
  fromInput: LogicalPath,
  target: { path: LogicalPath; stableKey?: string | null; applicationQuery?: string | null },
): string {
  const reference = relativeLogicalReference(fromInput, target.path);
  const query = querySuffix(target.applicationQuery);
  return target.stableKey
    ? `${reference}${query}#${MARKDOWN_KEY_PREFIX}${encodeStableKey(target.stableKey)}`
    : `${reference}${query}`;
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
  const keyed = options.stableKey ? `${rawPath};arbor-key=${encodeStableKey(options.stableKey)}` : rawPath;
  const pinned = options.revision ? `${keyed};arbor-rev=${options.revision}` : keyed;
  const fragment = options.contentFragment === null || options.contentFragment === undefined
    ? ""
    : `#${options.contentFragment}`;
  return `${pinned}${querySuffix(options.applicationQuery)}${fragment}`;
}

/** Rewrite only a local link's readable path, retaining all locator state. */
export function rewriteLocalLinkPath(
  baseDocumentPath: LogicalPath,
  href: string,
  newPath: LogicalPath,
): string | null {
  const resolved = resolveLogicalURL(baseDocumentPath, href);
  if (resolved?.kind !== "local") return null;
  const relativePath = relativeLogicalReference(baseDocumentPath, newPath);
  if (resolved.revision || (resolved.stableKey && resolved.contentFragment)) {
    return buildNetworkLocator(relativePath, resolved);
  }
  if (resolved.stableKey) {
    return buildCanonicalLink(baseDocumentPath, {
      path: newPath,
      stableKey: resolved.stableKey,
      applicationQuery: resolved.applicationQuery,
    });
  }
  return buildNetworkLocator(relativePath, {
    applicationQuery: resolved.applicationQuery,
    contentFragment: resolved.contentFragment,
  });
}

/** Transitional extraction; callers must still prove a legacy candidate unique. */
export function legacyPageIDCandidate(link: Exclude<ResolvedLink, null>): string | null {
  if (link.kind === "fragment") return link.legacyStableKeyCandidate;
  if (link.kind !== "local" && link.kind !== "arbor") return null;
  return pageIDFromStableKey(link.stableKey) ?? link.legacyStableKeyCandidate;
}
