#!/usr/bin/env bun
// Compare how Story's editor and overstoryd's public pages draw every block.
//
//   bun tools/public-page-compare/compare.ts [--inter]
//
// Renders kitchen-sink.md (for looking at) and a generated page holding every
// ordered pair of adjacent block types (for measuring) in both renderers, writes
// PNGs to .local/public-page-compare, and reports each pair's gap difference.
// Exits 1 when a gap differs by a point or more. The web side uses the system
// font, as Story does, unless --inter asks for the page's own font stack. Mac only.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { renderPublicMarkdownPage } from "../../packages/overstoryd/src/public-page.ts";

const repository = join(import.meta.dir, "../..");
const output = join(repository, ".local/public-page-compare");

/** Story's text column at the render width: its 0.055 side padding of 708pt. */
const COLUMN = { left: 39, width: 630 };

const BLOCKS: Record<string, string> = {
  p: "Hxg para",
  h1: "# Hxg one",
  h2: "## Hxg two",
  h3: "### Hxg three",
  h4: "#### Hxg four",
  h5: "##### Hxg five",
  h6: "###### Hxg six",
  bullet: "- Hxg bullet",
  number: "1. Hxg number",
  todo: "- [ ] Hxg todo",
  quote: "> Hxg quote",
  callout: "> [!agent] Hxg callout",
  code: "```swift\nHxg\n```",
  divider: "---",
  toggle: "▸ Hxg toggle",
  link: "[Hxg link](Other.md)",
};
/** Ink bands a block draws, where it isn't one: a code block's language and its code. */
const BANDS: Record<string, number> = { code: 2 };

/** A walk over every ordered pair of block types, each pair once (Hierholzer's algorithm). */
function everyPair(): string[] {
  const names = Object.keys(BLOCKS);
  const remaining = new Map(names.map((name) => [name, [...names]]));
  const stack = [names[0]!];
  const walk: string[] = [];
  while (stack.length) {
    const next = remaining.get(stack.at(-1)!)!.pop();
    if (next) stack.push(next);
    else walk.push(stack.pop()!);
  }
  return walk.reverse();
}

function webPage(source: string, inter: boolean): string {
  const page = renderPublicMarkdownPage({
    source, fallbackTitle: "Comparison", origin: "https://example.org", treeCanonicalPath: "/~joe/t", sourceDirectory: "/", publicPath: "/~joe/t/comparison",
  });
  // Lays the column where the editor does, rather than the page's own margins.
  const placement = `.story-bar{display:none}.public-page{width:${COLUMN.width}px!important;max-width:none!important;margin:36px 0 0 ${COLUMN.left}px!important}`;
  const font = inter ? "" : "body{font-family:-apple-system,system-ui!important}";
  return page.replace("</style>", `${placement}${font}</style>`);
}

/** The rows of a non-interlaced 8-bit RGB or RGBA PNG. */
function decodePNG(bytes: Uint8Array): { width: number; channels: number; rows: Uint8Array[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, channels = 0;
  const data: Uint8Array[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      channels = body[9] === 6 ? 4 : 3;
    }
    if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows: Uint8Array[] = [];
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const offset = y * (stride + 1);
    const filter = raw[offset]!;
    const row = new Uint8Array(raw.subarray(offset + 1, offset + 1 + stride));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels]! : 0;
      const up = previous[x]!;
      const corner = x >= channels ? previous[x - channels]! : 0;
      if (filter === 1) row[x] = row[x]! + left;
      else if (filter === 2) row[x] = row[x]! + up;
      else if (filter === 3) row[x] = row[x]! + ((left + up) >> 1);
      else if (filter === 4) {
        const estimate = left + up - corner;
        const [a, b, c] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)];
        row[x] = row[x]! + (a <= b && a <= c ? left : b <= c ? up : corner);
      }
    }
    rows.push(row);
    previous = row;
  }
  return { width, channels, rows };
}

/** The top of each horizontal run of ink, in points, from the 2x image, right of `fromPoint`. */
async function inkTops(path: string, fromPoint: number): Promise<number[]> {
  const { width, channels, rows } = decodePNG(new Uint8Array(await Bun.file(path).arrayBuffer()));
  const tops: number[] = [];
  let inside = false;
  rows.forEach((row, y) => {
    let ink = false;
    for (let x = fromPoint * 2; x < width && !ink; x += 1) {
      const at = x * channels;
      ink = Math.min(row[at]!, row[at + 1]!, row[at + 2]!) < 232;
    }
    if (ink && !inside) tops.push(y / 2);
    inside = ink;
  });
  return tops;
}

const inter = process.argv.includes("--inter");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const walk = everyPair();
const pages: Record<string, string> = {
  "kitchen-sink": await Bun.file(join(import.meta.dir, "kitchen-sink.md")).text(),
  pairs: `${walk.map((name) => BLOCKS[name]).join("\n\n")}\n`,
};
for (const [name, source] of Object.entries(pages)) {
  await Bun.write(join(output, `${name}.md`), source);
  await Bun.write(join(output, `${name}.html`), webPage(source, inter));
}

console.log("Rendering in Story's editor and in WebKit…");
const render = Bun.spawnSync(
  ["swift/scripts/test-story-editor-local.sh", "--filter", "PublicPageComparisonRender"],
  { cwd: repository, env: { ...process.env, PUBLIC_PAGE_COMPARE_DIR: output }, stdout: "pipe", stderr: "pipe" },
);
if (!render.success) {
  console.error(new TextDecoder().decode(render.stderr).slice(-2000));
  throw new Error("The render failed");
}

// Right of the markers and the page title's icon, so each block is one band of its text.
const fromPoint = COLUMN.left + 4;
const [story, web] = await Promise.all(["story", "web"].map((side) => inkTops(join(output, `pairs-${side}-light.png`), fromPoint)));
// Both pages open with a presented title or heading that only the page draws its way.
const expected = walk.reduce((sum, name) => sum + (BANDS[name] ?? 1), 0);
const skip = (tops: number[]) => tops.slice(tops.length - expected);
const positions = (tops: number[]) => {
  const result: number[] = [];
  let band = 0;
  for (const name of walk) {
    result.push(tops[band]!);
    band += BANDS[name] ?? 1;
  }
  return result;
};
if (story!.length < expected || web!.length < expected) {
  throw new Error(`Expected ${expected} bands of text; Story drew ${story!.length} and the page ${web!.length}. Look at the PNGs in ${output}.`);
}
const storyAt = positions(skip(story!));
const webAt = positions(skip(web!));

const differences: { pair: string; points: number }[] = [];
for (let index = 1; index < walk.length; index += 1) {
  const points = (webAt[index]! - webAt[index - 1]!) - (storyAt[index]! - storyAt[index - 1]!);
  differences.push({ pair: `${walk[index - 1]} → ${walk[index]}`, points });
}
differences.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
const off = differences.filter(({ points }) => Math.abs(points) >= 1);
console.log(`${differences.length} pairs measured; ${off.length} differ by a point or more${inter ? " (with the page's own fonts)" : ""}.`);
for (const { pair, points } of off) console.log(`  ${pair}: the page is ${Math.abs(points)}pt ${points > 0 ? "wider" : "narrower"}`);
console.log(`Largest difference: ${Math.abs(differences[0]?.points ?? 0)}pt. Images: ${output}`);
process.exit(off.length ? 1 : 0);
