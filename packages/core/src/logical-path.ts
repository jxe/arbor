export class PathEscapeError extends Error {}

export function normalizeTreePath(input: string): string {
  const decoded = decodeURIComponent(input || "/").replaceAll("\\", "/");
  const parts = decoded.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw new PathEscapeError(`Unsafe workspace path: ${input}`);
  }
  return `/${parts.join("/")}`;
}

/** Canonical browser/API identity for x.md, x/, or x/_index.md. */
export function canonicalNodePath(input: string): string {
  const path = normalizeTreePath(input);
  if (path === "/_index.md") return "/";
  if (path.endsWith("/_index.md")) return path.slice(0, -"/_index.md".length) || "/";
  if (path.endsWith(".md")) return path.slice(0, -3) || "/";
  return path;
}

/** The Markdown body stored beside a same-named directory: /x -> /x.md. */
export function siblingMarkdownTreePath(nodePath: string): string {
  const canonical = canonicalNodePath(nodePath);
  if (canonical === "/") return "/_index.md";
  return `${canonical}.md`;
}

/** The fallback Markdown body stored inside a directory: /x -> /x/_index.md. */
export function directoryIndexTreePath(nodePath: string): string {
  const canonical = canonicalNodePath(nodePath);
  if (canonical === "/") return "/_index.md";
  return `${canonical}/_index.md`;
}

export function nodePathFromPhysical(treePath: string): string {
  return canonicalNodePath(treePath);
}

export function nodeDisplayName(nodePath: string): string {
  const canonical = canonicalNodePath(nodePath);
  return canonical === "/" ? "/" : canonical.slice(canonical.lastIndexOf("/") + 1);
}

/** Parent of a logical node path; the root is its own parent. */
export function parentNodePath(nodePath: string): string {
  const canonical = canonicalNodePath(nodePath);
  return canonical.slice(0, canonical.lastIndexOf("/")) || "/";
}
