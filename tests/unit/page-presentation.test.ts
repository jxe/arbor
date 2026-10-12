import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  authorPage, parseMarkdown, presentPage, presentedHeading, serializeMarkdown,
  type DirectoryPlacementChild, type OverstoryBlock, type PlacementDirectory,
} from "@ovst/protocol";

type Outline = Array<
  | { presented: "title" | "children"; text: string }
  | { heading: number; text: string }
  | { link: string; generated: boolean }
>;
type Edit =
  | { retitle: "title" | "children"; text: string }
  | { retype: "title"; level: number }
  | { append: string }
  | null;

interface Fixture {
  cases: Array<{ name: string; node: PlacementDirectory; source: string; children: DirectoryPlacementChild[] | null; expectedOutline: Outline }>;
  edits: Array<{ name: string; node: PlacementDirectory; source: string; children: DirectoryPlacementChild[] | null; edit: Edit; expectedSource: string }>;
}

const fixture = JSON.parse(await readFile(join(import.meta.dir, "../../docs/overstory-spec/conformance/page-presentation.json"), "utf8")) as Fixture;

function outline(blocks: readonly OverstoryBlock[]): Outline {
  return blocks.flatMap((block): Outline => {
    const kind = presentedHeading(block);
    if (kind) return [{ presented: kind, text: block.content ?? "" }];
    if (block.type === "heading") return [{ heading: Number(block.props?.level ?? 1), text: block.content ?? "" }];
    if (block.type === "standaloneLink") return [{ link: String(block.props?.path ?? ""), generated: block.props?.storyGenerated === true }];
    return [];
  });
}

describe("page presentation", () => {
  for (const item of fixture.cases) {
    test(`presents ${item.name}`, () => {
      const document = parseMarkdown(item.source);
      const page = presentPage(item.node, document, item.children);
      expect(outline(page.document.blocks)).toEqual(item.expectedOutline);
      // Nothing presented is source.
      expect(serializeMarkdown(document, page.document.blocks)).toBe(item.source);
      expect(serializeMarkdown(document, authorPage(item.node, page.document.blocks))).toBe(item.source);
    });
  }

  for (const item of fixture.edits) {
    test(`authors ${item.name}`, () => {
      const document = parseMarkdown(item.source);
      let blocks = presentPage(item.node, document, item.children).document.blocks;
      const edit = item.edit;
      if (edit && "retitle" in edit) {
        blocks = blocks.map((block) => presentedHeading(block) === edit.retitle ? { ...block, content: edit.text } : block);
      } else if (edit && "retype" in edit) {
        blocks = blocks.map((block) => presentedHeading(block) === edit.retype ? { ...block, props: { ...block.props, level: edit.level } } : block);
      } else if (edit) {
        blocks = [...blocks, { id: "appended", type: "paragraph", content: edit.append, props: {}, children: [] }];
      }
      const authored = authorPage(item.node, blocks);
      const source = serializeMarkdown(document, authored);
      expect(source).toBe(item.expectedSource);
      // The written page presents what the reader saw: the edited heading is authored now.
      const reopened = presentPage(item.node, parseMarkdown(source), item.children);
      expect(serializeMarkdown(parseMarkdown(source), authorPage(item.node, reopened.document.blocks))).toBe(source);
    });
  }

  test("an edited title does not materialize the children heading", () => {
    const node = { path: "/dir", body: "index" as const };
    const page = presentPage(node, parseMarkdown("Intro.\n"), [{ name: "a", path: "/dir/a", body: "sibling" }]);
    const edited = page.document.blocks.map((block) => presentedHeading(block) === "title" ? { ...block, content: "Dir" } : block);
    const authored = authorPage(node, edited);
    expect(authored.filter((block) => block.props?.storyGenerated === true).map((block) => block.content)).toEqual(["Children", "a"]);
  });
});
