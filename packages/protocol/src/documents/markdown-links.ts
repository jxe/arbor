import type { LogicalPath } from "../model/identifiers.ts";
import { buildMarkdownLink, resolveLogicalURL, type MarkdownBodyOrigin } from "../model/logical-url.ts";

export interface MarkdownLinkDestination {
  href: string;
  /** UTF-16 offsets of `href` within the source. */
  start: number;
  end: number;
  image: boolean;
}

const DESTINATION = /(!?)\[[^\]]*\]\(([^)]+)\)/g;

/** Every inline link and image destination in a Markdown source, in order. */
export function markdownLinkDestinations(source: string): MarkdownLinkDestination[] {
  const destinations: MarkdownLinkDestination[] = [];
  for (const match of source.matchAll(DESTINATION)) {
    const href = match[2]!;
    const end = match.index + match[0].length - 1;
    destinations.push({ href, start: end - href.length, end, image: match[1] === "!" });
  }
  return destinations;
}

export interface MarkdownLinkHealing {
  /** The directory the source file was in when its links were written. */
  resolveFrom: LogicalPath;
  /** The directory the source file is in now. */
  writeFrom: LogicalPath;
  /** The source's tree: its `arbor://<tree>/…` links are same-tree links and become relative. */
  tree: string | null;
  /**
   * The node a link names now, looked up by its stable key first and then by
   * its resolved path, with that node's own key; null leaves the link as
   * written.
   */
  target(link: { path: LogicalPath; stableKey: string | null }): {
    path: LogicalPath;
    body: MarkdownBodyOrigin | null;
    stableKey: string | null;
  } | null;
}

/**
 * Rewrite every same-tree link in a Markdown source whose target is known to
 * exactly what a writer at `writeFrom` emits for it now, adding the target's
 * key when the link had none, and change nothing but those hrefs. Used when a source moves or changes body form (its links' base
 * moves) and when a target moves (its readable path goes stale).
 */
export function healMarkdownLinks(source: string, healing: MarkdownLinkHealing): string {
  let healed = "";
  let copied = 0;
  for (const destination of markdownLinkDestinations(source)) {
    const replacement = healedHref(destination.href, healing);
    if (replacement === null || replacement === destination.href) continue;
    healed += source.slice(copied, destination.start) + replacement;
    copied = destination.end;
  }
  return copied === 0 ? source : healed + source.slice(copied);
}

function healedHref(href: string, healing: MarkdownLinkHealing): string | null {
  const resolved = resolveLogicalURL(healing.resolveFrom, href);
  if (resolved?.kind === "arbor") {
    if (!("treeID" in resolved.authority) || resolved.authority.treeID !== healing.tree) return null;
  } else if (resolved?.kind !== "local") {
    return null;
  }
  const target = healing.target({ path: resolved.path, stableKey: resolved.stableKey });
  if (!target) return null;
  return buildMarkdownLink(healing.writeFrom, {
    ...target,
    stableKey: resolved.stableKey ?? target.stableKey,
    revision: resolved.revision,
    applicationQuery: resolved.applicationQuery,
    contentFragment: resolved.contentFragment,
  });
}
