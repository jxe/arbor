import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { PathEscapeError, normalizeTreePath } from "./logical-path.ts";

export function resolveTreePath(root: string, treePath: string): string {
  const normalized = normalizeTreePath(treePath);
  const candidate = resolve(root, `.${normalized}`);
  const rel = relative(resolve(root), candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PathEscapeError(`Path leaves workspace: ${treePath}`);
  }
  return candidate;
}

export async function ensureContainedPath(root: string, treePath: string): Promise<string> {
  const candidate = resolveTreePath(root, treePath);
  const rootReal = await realpath(root);
  let existing = candidate;
  let target: string | null = null;
  while (!target) {
    try { target = await realpath(existing); }
    catch {
      const parent = dirname(existing);
      if (parent === existing) throw new PathEscapeError(`Cannot resolve workspace path: ${treePath}`);
      existing = parent;
    }
  }
  const rel = relative(rootReal, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PathEscapeError(`Symlink leaves workspace: ${treePath}`);
  }
  return candidate;
}

export function toTreePath(root: string, absolutePath: string): string {
  const rel = relative(resolve(root), resolve(absolutePath)).split(sep).join("/");
  if (rel === ".." || rel.startsWith("../")) throw new PathEscapeError("Path leaves workspace");
  return rel ? `/${rel}` : "/";
}
