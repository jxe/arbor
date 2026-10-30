import type { OverstoryBlock, MarkdownDocument } from "../index.ts";
import { canonicalNodePath, nodeDisplayName } from "../model/logical-path.ts";
import { placeDirectoryChildren, type DirectoryPlacementChild, type PlacementDirectory } from "./directory-document.ts";
import { serializeBlocks } from "./markdown.ts";

/** The text of the presented Subpages heading. */
export const PRESENTED_CHILDREN_HEADING = "Subpages";

/** The authored last H1s that hold a page's remainder: `# Subpages`, or `# Children` as clients wrote it before. */
export const AUTHORED_CHILDREN_HEADINGS: readonly string[] = [PRESENTED_CHILDREN_HEADING, "Children"];

export type PresentedHeading = "title" | "children";

export interface PagePresentation {
  /** The authored document with its presented headings and generated child links in place. */
  document: MarkdownDocument;
  placedChildren: string[];
  generatedChildren: string[];
}

/**
 * The title a page presents when its body does not begin with an H1: the last
 * segment of the node's logical path with each hyphen shown as a space. The
 * root has no segment and presents no title.
 */
export function presentedPageTitle(nodePath: string): string | null {
  const path = canonicalNodePath(nodePath);
  return path === "/" ? null : nodeDisplayName(path).replaceAll("-", " ");
}

function isBlank(block: OverstoryBlock): boolean {
  return block.type === "rawMarkdown" && block.props?.blank === true;
}

function isH1(block: OverstoryBlock | undefined): boolean {
  return block?.type === "heading" && Number(block.props?.level ?? 1) === 1;
}

/** Whether the body's first block is an H1, which is then the page's authored title. */
export function beginsWithTitle(blocks: readonly OverstoryBlock[]): boolean {
  return isH1(blocks.find((block) => !isBlank(block)));
}

/** Which presented heading a block is, whether or not it has been edited since. */
export function presentedHeading(block: OverstoryBlock): PresentedHeading | null {
  const value = block.props?.storyPresented;
  return value === "title" || value === "children" ? value : null;
}

function presented(kind: PresentedHeading, text: string): OverstoryBlock {
  return {
    id: `story-presented-${kind}`,
    type: "heading",
    content: text,
    props: { level: 1, storyGenerated: true, storyPresented: kind },
    children: [],
  };
}

/**
 * Present a node's operational document as a page (directory format §4.1).
 *
 * Every client shows a page through this function rather than through
 * directory placement. It adds what the page shows and its source lacks: a
 * title when the body does not begin with an H1, and, for a node with
 * children, the children no authored link names at the page's end: under the
 * body's last H1 when that is an authored `# Subpages` (or a legacy
 * `# Children`), otherwise in a presented Subpages section.
 * `children` is null for a node that has none to place.
 *
 * Everything added carries `storyGenerated`, which the Markdown serializer
 * omits, so an untouched page serializes to its source. `authorPage` is the
 * inverse for a page the reader has edited.
 */
export function presentPage(
  node: PlacementDirectory,
  document: MarkdownDocument,
  children: readonly DirectoryPlacementChild[] | null,
): PagePresentation {
  const placement = children
    ? placeDirectoryChildren(node, document, children)
    : { document, remainder: [], placedChildren: [], generatedChildren: [] };
  const blocks = [...placement.document.blocks];
  const title = presentedPageTitle(node.path);
  if (title !== null && !beginsWithTitle(blocks)) {
    // After the blank lines that open the body, where an authored title would stand.
    const first = blocks.findIndex((block) => !isBlank(block));
    blocks.splice(first === -1 ? blocks.length : first, 0, presented("title", title));
  }
  if (placement.remainder.length) {
    // An authored `# Subpages` (or legacy `# Children`) that is the body's last H1 holds the remainder at its end.
    const lastH1 = blocks.findLast((block) => isH1(block));
    const authoredChildren = lastH1 !== undefined && presentedHeading(lastH1) === null
      && AUTHORED_CHILDREN_HEADINGS.includes(lastH1.content ?? "");
    if (!authoredChildren) blocks.push(presented("children", PRESENTED_CHILDREN_HEADING));
    blocks.push(...placement.remainder);
  }
  return {
    document: { ...placement.document, blocks },
    placedChildren: placement.placedChildren,
    generatedChildren: placement.generatedChildren,
  };
}

function authoredProps(block: OverstoryBlock): OverstoryBlock {
  const { storyGenerated: _generated, storyPresented: _presented, storyOrdinal: _ordinal, ...props } = block.props ?? {};
  return { ...block, props };
}

/**
 * The authored blocks of a presented page after edits: the inverse of
 * `presentPage`, whose result serializes to the page's new source.
 *
 * A presented heading the reader left alone stays out of the source. An
 * edited title (new text, or another kind of block) is written where it
 * stands, which is the head of the body. A Subpages section the reader
 * edited (renamed, added content under, or reordered) is written whole: its
 * heading, then everything under it in the order shown, each generated link
 * as an authored link. Generated links are otherwise never written.
 */
export function authorPage(node: PlacementDirectory, blocks: readonly OverstoryBlock[]): OverstoryBlock[] {
  const title = presentedPageTitle(node.path);
  const untouched = (block: OverstoryBlock, text: string | null) =>
    isH1(block) && text !== null && (block.content ?? "") === text;
  const result: OverstoryBlock[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const kind = presentedHeading(block);
    if (kind === "title") {
      result.push(untouched(block, title) ? { ...block, props: { ...block.props, storyGenerated: true } } : authoredProps(block));
      continue;
    }
    if (kind !== "children") {
      result.push(block);
      continue;
    }
    const following = blocks.slice(index + 1);
    const authoredFollows = following.some((item) => item.props?.storyGenerated !== true && !isBlank(item));
    const ordinals = following.flatMap((item) => typeof item.props?.storyOrdinal === "number" ? [item.props.storyOrdinal] : []);
    const reordered = ordinals.some((ordinal, position) => position > 0 && ordinal < ordinals[position - 1]!);
    if (untouched(block, PRESENTED_CHILDREN_HEADING) && !authoredFollows && !reordered) {
      result.push({ ...block, props: { ...block.props, storyGenerated: true } });
      continue;
    }
    // The heading starts its own block, so authored source that ends without
    // a blank line is separated from it.
    const before = serializeBlocks(result);
    if (before && !/\r?\n\r?\n$/.test(before)) {
      const separator = /\n$/.test(before) ? "\n" : "\n\n";
      result.push({ id: "story-presented-children-separator", type: "rawMarkdown", content: separator, props: { blank: true }, children: [] });
    }
    result.push(authoredProps(block));
    // Everything under the heading is written where it is shown.
    result.push(...following.map((item) => item.props?.storyGenerated === true ? authoredProps(item) : item));
    break;
  }
  return result;
}
