import { buildNetworkLocator, resolveLogicalURL } from "@ovst/protocol/logical-url";
import type { OverstoryBlock, JSONValue } from "@ovst/protocol";
import { PRESENTED_CHILDREN_HEADING, beginsWithTitle, isPageID, markdownDisplayTitle, markdownStableKey, parseMarkdown } from "@ovst/protocol";

export interface PublicPageChild {
  name: string;
  href: string;
  kind: "document" | "folder" | "file";
}

export interface PublicMarkdownPageOptions {
  source: string;
  fallbackTitle: string;
  origin: string;
  treeCanonicalPath: string;
  /** The tree directory holding the page's Markdown file; its relative links resolve against it. */
  sourceDirectory: string;
  children?: PublicPageChild[];
  /** The page's own public path. With it the page gets a link preview and an Open in Story bar. */
  publicPath?: string;
  storyDownloads?: StoryDownloads;
}

export function escapeHTML(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function encodedPath(path: string): string {
  const parts = path.split("/").filter(Boolean).map(encodeURIComponent);
  return `/${parts.join("/")}`;
}

/** A tree path as a public URL path: the tree's boundary joined to it, each segment encoded. */
export function publicTreePath(boundary: string, path: string): string {
  const base = boundary === "/" ? "" : encodedPath(boundary).replace(/\/$/, "");
  const suffix = path === "/" ? "" : encodedPath(path);
  return `${base}${suffix}` || "/";
}

interface RenderContext {
  origin: string;
  host: string;
  treeCanonicalPath: string;
  /** The tree directory holding the page's Markdown file; its relative links resolve against it. */
  sourceDirectory: string;
  footnotes: Map<string, number>;
}

function linkHref(raw: string, context: RenderContext): string | null {
  const resolved = resolveLogicalURL(context.sourceDirectory, raw);
  if (!resolved) return null;
  if (resolved.kind === "local") {
    return buildNetworkLocator(publicTreePath(context.treeCanonicalPath, resolved.path), resolved);
  }
  if (resolved.kind === "overstory" && "dns" in resolved.authority && resolved.authority.dns === context.host) {
    return buildNetworkLocator(encodedPath(resolved.path), resolved);
  }
  if (resolved.kind === "external") {
    try {
      const protocol = new URL(resolved.href, context.origin).protocol;
      return ["http:", "https:", "mailto:", "tel:"].includes(protocol) ? resolved.href : null;
    } catch {
      return null;
    }
  }
  if (resolved.kind === "fragment") return `#${resolved.contentFragment}`;
  return null;
}

function wrappedInline(source: string, marker: string, tag: string, context: RenderContext): string | null {
  if (!source.startsWith(marker)) return null;
  const end = source.indexOf(marker, marker.length);
  if (end < marker.length) return null;
  return `<${tag}>${renderInline(source.slice(marker.length, end), context)}</${tag}>`;
}

function renderInline(source: string, context: RenderContext): string {
  let html = "";
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    if (rest[0] === "\\" && rest.length > 1) {
      html += escapeHTML(rest[1]!);
      index += 2;
      continue;
    }
    if (rest[0] === "`") {
      const end = rest.indexOf("`", 1);
      if (end > 0) {
        html += `<code>${escapeHTML(rest.slice(1, end))}</code>`;
        index += end + 1;
        continue;
      }
    }
    const footnote = rest.match(/^\[\^([^\]\s]+)\]/);
    if (footnote) {
      const label = footnote[1]!;
      const number = context.footnotes.get(label) ?? context.footnotes.size + 1;
      html += `<sup class="footnote-reference"><a href="#fn-${encodeURIComponent(label)}">${number}</a></sup>`;
      index += footnote[0].length;
      continue;
    }
    const image = rest.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (image) {
      const href = linkHref(image[2]!, context);
      html += href
        ? `<img class="inline-image" src="${escapeHTML(href)}" alt="${escapeHTML(image[1]!)}">`
        : escapeHTML(image[0]);
      index += image[0].length;
      continue;
    }
    const link = rest.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (link) {
      const href = linkHref(link[2]!, context);
      html += href
        ? `<a href="${escapeHTML(href)}">${renderInline(link[1]!, context)}</a>`
        : renderInline(link[1]!, context);
      index += link[0].length;
      continue;
    }
    const strong = wrappedInline(rest, "**", "strong", context) ?? wrappedInline(rest, "__", "strong", context);
    if (strong) {
      const marker = rest.startsWith("**") ? "**" : "__";
      const end = rest.indexOf(marker, marker.length);
      html += strong;
      index += end + marker.length;
      continue;
    }
    const strike = wrappedInline(rest, "~~", "s", context);
    if (strike) {
      const end = rest.indexOf("~~", 2);
      html += strike;
      index += end + 2;
      continue;
    }
    const emphasisMarker = rest.startsWith("*") ? "*" : rest.startsWith("_") ? "_" : null;
    if (emphasisMarker) {
      const end = rest.indexOf(emphasisMarker, 1);
      if (end > 1) {
        html += `<em>${renderInline(rest.slice(1, end), context)}</em>`;
        index += end + 1;
        continue;
      }
    }
    if (rest[0] === "$" && rest[1] !== "$") {
      const end = rest.indexOf("$", 1);
      if (end > 1) {
        html += `<span class="inline-math">${escapeHTML(rest.slice(1, end))}</span>`;
        index += end + 1;
        continue;
      }
    }
    if (rest[0] === "\n") {
      html += "<br>";
      index += 1;
      continue;
    }
    html += escapeHTML(rest[0]!);
    index += 1;
  }
  return html;
}

function childIcon(folder: boolean): string {
  return folder
    ? `<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M1.75 4.25h4l1.4 1.5h7.1v6.75a1.25 1.25 0 0 1-1.25 1.25H3a1.25 1.25 0 0 1-1.25-1.25z"/><path d="M1.75 4.25V3.5A1.25 1.25 0 0 1 3 2.25h2.35l1.4 1.5h6A1.25 1.25 0 0 1 14 5"/></svg>`
    : `<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 1.75h6l4 4v8.5H3z"/><path d="M9 1.75v4h4M5.25 9h5.5M5.25 11.5h4"/></svg>`;
}

// Drawn to stand in for the symbols Story's editor uses, which browsers don't have.
const SPARKLES_ICON = `<svg aria-hidden="true" viewBox="0 0 13 13"><path d="M5.5 1.5 6.7 5l3.3 1.2-3.3 1.2-1.2 3.5-1.2-3.5L1 6.2 4.3 5zM10.5.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5zM10.5 8.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z"/></svg>`;
const CHECK_CIRCLE_ICON = `<svg aria-hidden="true" viewBox="0 0 13 13"><path fill-rule="evenodd" d="M6.5.5a6 6 0 1 1 0 12 6 6 0 0 1 0-12zM9.6 4.2 5.7 8 3.6 6l-.8.8 2.9 2.8 4.7-4.6z"/></svg>`;
const CHECK_BOX_ICON = `<svg aria-hidden="true" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M3.5 1h9A2.5 2.5 0 0 1 15 3.5v9a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 1 12.5v-9A2.5 2.5 0 0 1 3.5 1zm8.3 4L7 10.3 4.3 7.8l-.8.9L7 12l5.7-6.2z"/></svg>`;
const OPEN_BOX_ICON = `<svg aria-hidden="true" viewBox="0 0 16 16"><rect x="1.6" y="1.6" width="12.8" height="12.8" rx="2.2" fill="none" stroke="currentColor" stroke-width="1"/></svg>`;
const TOGGLE_ICON = `<svg aria-hidden="true" viewBox="0 0 12 12"><path d="M1 .5v11l10.5-5.5z"/></svg>`;

/** A title's leading emoji, which Story draws as the page's icon, and the text after it. */
function splitLeadingEmoji(source: string): { emoji: string | null; rest: string } {
  const match = source.match(/^\s*(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s+(?=\S)/u);
  return match ? { emoji: match[1]!, rest: source.slice(match[0].length) } : { emoji: null, rest: source };
}

function childRow(label: string, href: string, detail: string, folder: boolean, context: RenderContext, hrefIsPublic = false): string {
  const resolved = hrefIsPublic ? href : linkHref(href, context) ?? href;
  const { emoji, rest } = splitLeadingEmoji(label);
  const icon = emoji ? `<span class="child-page-emoji">${escapeHTML(emoji)}</span>` : childIcon(folder);
  return `<a class="child-page" href="${escapeHTML(resolved)}"><span class="child-page-kind">${icon}</span><strong>${renderInline(rest, context)}</strong><small>${escapeHTML(detail)}</small></a>`;
}

function renderChildren(children: OverstoryBlock[], context: RenderContext): string {
  return children.length ? `<div class="children">${renderBlocks(children, context)}</div>` : "";
}

function renderList(items: OverstoryBlock[], kind: "bullet" | "number" | "check", context: RenderContext): string {
  const tag = kind === "number" ? "ol" : "ul";
  return `<${tag}>${items.map((block, index) => {
    const done = kind === "check" && Boolean(block.props?.checked);
    const marker = kind === "bullet"
      ? `<span class="marker bullet"></span>`
      : kind === "number"
        ? `<span class="marker number">${index + 1}.</span>`
        : `<span class="marker checkbox${done ? " done" : ""}" role="img" aria-label="${done ? "Done" : "Not done"}">${done ? CHECK_BOX_ICON : OPEN_BOX_ICON}</span>`;
    return `<li><div class="list-row">${marker}<span class="row-text${done ? " finished" : ""}">${renderInline(block.content ?? "", context)}</span></div>${renderChildren(block.children, context)}</li>`;
  }).join("")}</${tag}>`;
}

/** An agent task as Story draws it: a tinted panel, not a quote. */
function renderCallout(block: OverstoryBlock, context: RenderContext): string | null {
  const match = (block.content ?? "").match(/^\[!agent(-done)?\]\s*/i);
  if (!match) return null;
  const done = Boolean(match[1]);
  const text = renderInline((block.content ?? "").slice(match[0].length), context);
  return `<div class="callout"><div class="callout-panel${done ? " done" : ""}"><span class="marker callout-marker">${done ? CHECK_CIRCLE_ICON : SPARKLES_ICON}</span><span class="row-text${done ? " finished" : ""}">${text}</span></div></div>`;
}

function renderBlocks(blocks: OverstoryBlock[], context: RenderContext): string {
  let html = "";
  for (let index = 0; index < blocks.length;) {
    const block = blocks[index]!;
    if (["bulletListItem", "numberedListItem", "checkListItem"].includes(block.type)) {
      const items: OverstoryBlock[] = [];
      while (blocks[index]?.type === block.type) items.push(blocks[index++]!);
      html += renderList(items, block.type === "numberedListItem" ? "number" : block.type === "checkListItem" ? "check" : "bullet", context);
      continue;
    }
    switch (block.type) {
      case "heading": {
        const level = Math.min(6, Math.max(1, Number(block.props?.level ?? 1)));
        html += `<h${level}>${renderInline(block.content ?? "", context)}</h${level}>${renderBlocks(block.children, context)}`;
        break;
      }
      case "pageTitle" as OverstoryBlock["type"]:
        html += `${String(block.props?.html ?? "")}${renderBlocks(block.children, context)}`;
        break;
      case "paragraph":
        html += `<p>${renderInline(block.content ?? "", context)}</p>${renderChildren(block.children, context)}`;
        break;
      case "quote":
        html += renderCallout(block, context) ?? `<div class="quote"><blockquote>${renderInline(block.content ?? "", context)}</blockquote></div>`;
        html += renderChildren(block.children, context);
        break;
      case "codeBlock": {
        const language = String(block.props?.language ?? "");
        html += `<div class="code-block"><div class="code-panel">${language ? `<small>${escapeHTML(language)}</small>` : ""}<pre><code>${escapeHTML(block.content ?? "")}</code></pre></div></div>`;
        break;
      }
      case "divider":
        html += `<div class="divider"><hr></div>`;
        break;
      case "mathBlock":
        html += `<div class="math-block">${escapeHTML(block.content ?? "")}</div>`;
        break;
      case "image": {
        const raw = String(block.props?.url ?? "");
        const href = linkHref(raw, context);
        html += href ? `<figure><img src="${escapeHTML(href)}" alt="${escapeHTML(String(block.props?.caption ?? ""))}"></figure>` : "";
        break;
      }
      case "toggle":
        html += `<details><summary><span class="marker toggle-marker">${TOGGLE_ICON}</span><span class="row-text">${renderInline(block.content ?? "", context)}</span></summary>${renderChildren(block.children, context)}</details>`;
        break;
      case "footnoteDefinition": {
        const label = String(block.props?.label ?? "1");
        const number = context.footnotes.get(label) ?? context.footnotes.size + 1;
        html += `<div class="footnote-definition" id="fn-${encodeURIComponent(label)}"><span>${number}.</span><div>${renderInline(block.content ?? "", context)}${renderBlocks(block.children, context)}</div></div>`;
        break;
      }
      case "standaloneLink": {
        const path = String(block.props?.path ?? "");
        html += childRow(block.content ?? path, path, path, false, context);
        break;
      }
      case "rawMarkdown":
        if (!block.props?.blank) html += `<div class="raw-markdown"><div class="raw-panel"><small>Raw Markdown</small><pre>${escapeHTML((block.content ?? "").trimEnd())}</pre></div></div>`;
        break;
    }
    index += 1;
  }
  return html;
}

function collectFootnotes(blocks: OverstoryBlock[]): Map<string, number> {
  const labels: string[] = [];
  const add = (label: string) => { if (label && !labels.includes(label)) labels.push(label); };
  const visit = (items: OverstoryBlock[]) => items.forEach((block) => {
    for (const match of (block.content ?? "").matchAll(/\[\^([^\]\s]+)\]/g)) add(match[1]!);
    if (block.type === "footnoteDefinition") add(String(block.props?.label ?? "1"));
    visit(block.children);
  });
  visit(blocks);
  return new Map(labels.map((label, index) => [label, index + 1]));
}

function referencedChildren(blocks: OverstoryBlock[], context: RenderContext): Set<string> {
  const result = new Set<string>();
  const visit = (items: OverstoryBlock[]) => items.forEach((block) => {
    if (block.type === "standaloneLink") {
      const href = linkHref(String(block.props?.path ?? ""), context);
      if (href) result.add(href);
    }
    visit(block.children);
  });
  visit(blocks);
  return result;
}

const PUBLIC_STYLES = `
:root{color-scheme:light;--fg:#37352f;--muted:rgba(55,53,47,.5);--bg:#fff;--hover:rgba(55,53,47,.08);--border:rgba(55,53,47,.12);--strong-border:rgba(55,53,47,.22);--code-fg:#eb5757;--code-bg:rgba(135,131,120,.15);--divider:#e9e9e7;--link:#2383e2;--code-panel:rgba(135,131,120,.075);--raw-panel:rgba(135,131,120,.0525);--callout:rgb(175,82,222);--callout-bg:rgba(175,82,222,.06)}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--fg:#dad8d3;--muted:rgba(255,255,255,.46);--bg:#191919;--hover:rgba(255,255,255,.08);--border:rgba(255,255,255,.13);--strong-border:rgba(255,255,255,.24);--code-fg:#ff7369;--code-bg:rgba(255,255,255,.08);--divider:rgba(255,255,255,.13);--link:#529cff;--code-panel:rgba(255,255,255,.04);--raw-panel:rgba(255,255,255,.028);--callout:rgb(191,90,242);--callout-bg:rgba(191,90,242,.06)}}
*{box-sizing:border-box}html,body{min-height:100%}body{margin:0;background:var(--bg);color:var(--fg);font:400 16px/22.5px Inter,ui-sans-serif,system-ui,sans-serif}.public-page{width:708px;max-width:calc(100% - 64px);margin:76px auto 96px}.story-document{overflow-wrap:anywhere}
.story-document>:first-child{margin-top:0}
.story-document h1,.story-document h2,.story-document h3,.story-document h4,.story-document h5,.story-document h6{margin:0;padding:0;font-weight:600;line-height:calc(1.19em + 1px)}.story-document :is(h1,h2,h3,h4,h5,h6){margin-bottom:-1px}.story-document h1{margin-top:40px;font-size:30px}.story-document h2{margin-top:40px;font-size:24px}.story-document h3{margin-top:30px;font-size:20px}.story-document h4{margin-top:24px;font-size:18px}.story-document h5{margin-top:24px;font-size:17px}.story-document h6{margin-top:24px;font-size:16px}
.story-document h1.page-title{display:flex;align-items:baseline;margin-top:0;font-size:40px}.page-icon{flex:none;width:52px;font-weight:400}.page-icon svg{display:inline-block;width:40px;height:40px;margin:0 0 -6px 3px;fill:none;stroke:var(--muted);stroke-width:1.1;stroke-linecap:round;stroke-linejoin:round}.page-title-text{min-width:0}
.story-document p{margin:4px 0 3px;padding:1.25px 0}.story-document a{color:inherit;font-weight:600;text-decoration:none}.story-document a:hover{color:var(--link)}.story-document strong{font-weight:600}.story-document code{padding:1.5px .6em;border-radius:3px;background:var(--code-bg);color:var(--code-fg);font:400 13.6px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.story-document ul,.story-document ol{margin:3px 0 0;padding:0;list-style:none}.story-document li+li{margin-top:1px}.story-document li>.children>*:first-child,.story-document details>.children>*:first-child{margin-top:0}.children{margin-left:34px}.story-document .children>:is(ul,ol,details,a.child-page){margin-left:-10px}
.list-row,.story-document summary,.callout-panel,.child-page{display:grid;grid-template-columns:24px minmax(0,1fr);column-gap:10px}.list-row,.story-document summary,.child-page{padding:3.25px 0}.marker{display:flex;justify-content:flex-end}.marker.bullet{width:6px;height:6px;margin:9px 0 0;border-radius:50%;background:var(--fg);justify-self:end}.marker.number{white-space:nowrap}.marker.checkbox{height:22.5px;align-items:center;color:var(--fg)}.marker.checkbox svg{width:16px;height:16px;fill:currentColor}.marker.checkbox.done{color:var(--muted)}.row-text.finished{color:var(--muted);text-decoration:line-through}
.quote{position:relative;margin:4px 0;padding:3px 0}.quote::before{content:"";position:absolute;top:3px;bottom:3px;left:0;width:3px;background:var(--fg)}.quote blockquote{margin:-1.75px 0;padding-left:17px;font-size:19.2px;line-height:27.5px}
.callout{margin:4px 0;padding:3px 0}.callout-panel{padding:6.25px 12px 6.25px 0;border-radius:8px;background:var(--callout-bg)}.callout-marker{height:13px;margin-top:5px;transform:translateX(1.5px);color:var(--callout)}.callout-marker svg{width:13px;height:13px;fill:currentColor}.callout-panel.done .callout-marker{color:var(--muted)}
.code-block{margin:8px 0;padding:16px 0}.code-panel{padding:0 16px;border-radius:8px;background:var(--code-panel)}.code-panel small,.raw-panel small{display:block;padding-bottom:8px;color:var(--muted);font:400 11px/14px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.code-panel pre,.raw-panel pre{margin:0;overflow:auto;font:400 14px/normal ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap}.code-panel pre code{padding:0;background:none;color:var(--fg);font:400 14px/normal ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.divider{margin:12px 0;padding:3px 0}.divider hr{height:1px;margin:0;border:0;background:var(--divider)}figure{margin:8px 0;padding:3px 0}figure img{display:block;max-width:100%;max-height:400px;border-radius:6px}.inline-image{max-width:100%;vertical-align:middle}.inline-math,.math-block{font-family:Georgia,"Times New Roman",serif}.inline-math{padding:0 2px}.math-block{margin:8px 0;padding:12px 16px;overflow:auto;border-radius:8px;background:color-mix(in srgb,var(--code-bg) 72%,transparent);text-align:center}
.story-document details{margin:3px 0 0}.story-document summary{cursor:pointer;list-style:none}.story-document summary::-webkit-details-marker{display:none}.toggle-marker{height:12px;margin-top:5px;transform:translateX(1.5px)}.toggle-marker svg{width:12px;height:12px;fill:var(--fg)}details[open]>summary .toggle-marker svg{transform:rotate(90deg)}
.raw-markdown{margin:8px 0;padding:3px 0}.raw-panel{padding:0 15px 12px;border:1px dashed var(--divider);border-radius:8px;background:var(--raw-panel)}.raw-panel small{margin-top:-1px}.raw-panel pre{color:var(--muted)}.footnote-reference a{color:var(--link);font-size:.72em;font-weight:600;text-decoration:none}.footnote-definition{display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;margin-top:8px;color:var(--muted);font-size:14px;line-height:21px}.footnote-definition>span{color:var(--link);font-weight:600;text-align:right}.footnote-definition>div{color:var(--fg)}
.child-list{margin-top:8px}a.child-page{display:grid;grid-template-columns:24px minmax(0,auto) minmax(0,1fr);width:100%;margin-top:3px;border-radius:4px;color:var(--fg)!important;text-decoration:none!important}a.child-page:hover{background:var(--hover)}.child-page-kind{display:flex;align-items:center;justify-content:flex-end;width:24px;height:22.5px;transform:translateX(4px);color:var(--muted)}.child-page svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.35;stroke-linecap:round;stroke-linejoin:round}.child-page-emoji{font-size:17px;font-weight:400;transform:translateX(6px)}.child-page strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.child-page small{min-width:0;overflow:hidden;color:var(--muted);font-size:11px;font-weight:400;opacity:0;text-overflow:ellipsis;white-space:nowrap}.child-page:hover small,.child-page:focus small{opacity:1}
.story-document :is(ul,ol,details,a.child-page)+:is(ul,ol,details,a.child-page){margin-top:1px}.story-document :is(h1,h2,h3,h4,h5,h6)+:is(ul,ol,details,a.child-page){margin-top:7px}
.story-bar{display:flex;justify-content:flex-end;gap:16px;padding:12px 20px;font-size:14px}.story-bar a{color:var(--muted);text-decoration:none}.story-bar a:hover{color:var(--fg)}.story-bar a.open-in-story{color:var(--link);font-weight:500}.story-bar .on-phone{display:none}@media(pointer:coarse){.story-bar .on-desktop{display:none}.story-bar .on-phone{display:inline}}
.data-properties{margin:28px 0 0}.data-properties>div{display:grid;grid-template-columns:minmax(120px,1fr) minmax(0,2fr);gap:24px;padding:10px 0;border-top:1px solid var(--border)}.data-properties dt{color:var(--muted);font-size:14px}.data-properties dd{min-width:0;margin:0;overflow-wrap:anywhere}.data-properties pre{margin:0;overflow:auto;white-space:pre-wrap}.data-properties code{padding:0;background:none;color:var(--fg)}
@media(max-width:760px){.public-page{width:auto;max-width:none;margin:42px 20px 72px}.data-properties>div{grid-template-columns:1fr;gap:3px}}
`;

export function renderPublicMarkdownPage(options: PublicMarkdownPageOptions): string {
  const document = parseMarkdown(options.source);
  const context: RenderContext = {
    origin: options.origin,
    host: new URL(options.origin).host,
    treeCanonicalPath: options.treeCanonicalPath,
    sourceDirectory: options.sourceDirectory,
    footnotes: collectFootnotes(document.blocks),
  };
  // Presented headings (directory format §4.1): a page whose body does not
  // begin with an H1 opens with its name, hyphens shown as spaces, and
  // children no authored link names close it under Subpages.
  const title = markdownDisplayTitle(document, options.fallbackTitle.replaceAll("-", " "));
  const referenced = referencedChildren(document.blocks, context);
  const projectedChildren = (options.children ?? [])
    .filter((child) => !referenced.has(child.href))
    .map((child) => childRow(child.name, child.href, child.href, child.kind === "folder", context, true))
    .join("");
  const childList = projectedChildren ? `<div class="child-list">${projectedChildren}</div>` : "";
  const body = `${renderBlocks(titledBlocks(document.blocks, context), context)}${childList ? `<h1>${escapeHTML(PRESENTED_CHILDREN_HEADING)}</h1>${childList}` : ""}`;
  const id = document.frontmatter.id;
  // A tree's home page is its address already; any other page's ID keeps its link working through renames.
  const stableKey = isPageID(id) && options.publicPath !== publicTreePath(options.treeCanonicalPath, "/") ? markdownStableKey(id) : null;
  const located = options.publicPath === undefined ? null : `${context.host}${buildNetworkLocator(options.publicPath, { stableKey })}`;
  const preview = located ? linkPreview(title, `${new URL(options.origin).protocol}//${located}`, document.blocks, context) : "";
  const bar = located ? storyBar(`overstory://${located}`, options.storyDownloads) : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"><title>${escapeHTML(title)}</title>${preview}<style>${PUBLIC_STYLES}</style></head><body>${bar}<main class="public-page"><article class="story-document">${beginsWithTitle(document.blocks) ? "" : pageTitle(escapeHTML(title), null)}${body}</article></main></body></html>`;
}

/** The first heading in Story's page-title form: the icon column, then the title. */
function pageTitle(html: string, emoji: string | null): string {
  const icon = emoji ? escapeHTML(emoji) : childIcon(false);
  return `<h1 class="page-title"><span class="page-icon">${icon}</span><span class="page-title-text">${html}</span></h1>`;
}

/** The blocks with a leading H1 replaced by its page-title form. */
function titledBlocks(blocks: OverstoryBlock[], context: RenderContext): OverstoryBlock[] {
  const first = blocks.findIndex((block) => !(block.type === "rawMarkdown" && block.props?.blank));
  const block = blocks[first];
  if (block?.type !== "heading" || Number(block.props?.level ?? 1) !== 1) return blocks;
  const { emoji, rest } = splitLeadingEmoji(block.content ?? "");
  const title: OverstoryBlock = { ...block, type: "pageTitle", props: { ...block.props, html: pageTitle(renderInline(rest, context), emoji) } } as unknown as OverstoryBlock;
  return [...blocks.slice(0, first), title, ...blocks.slice(first + 1)];
}

/** The text a link preview shows: the page's first paragraph, cut to about two lines. */
function previewDescription(blocks: OverstoryBlock[], context: RenderContext): string | null {
  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.content?.trim()) continue;
    const text = renderInline(block.content, context).replace(/<[^>]*>/g, " ")
      .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
      .replace(/\s+/g, " ").trim();
    if (text) return text.length > 200 ? `${text.slice(0, 199).trimEnd()}…` : text;
  }
  return null;
}

/** The page's first picture a link preview can show, as an absolute URL. */
function previewImage(blocks: OverstoryBlock[], context: RenderContext): string | null {
  for (const block of blocks) {
    const raw = block.type === "image" ? String(block.props?.url ?? "") : block.content?.match(/!\[[^\]]*\]\(([^)\s]+)\)/)?.[1];
    const href = raw ? linkHref(raw, context) : null;
    if (href && /\.(png|jpe?g|gif|webp)(;|\?|#|$)/i.test(href)) return new URL(href, context.origin).href;
    const nested = previewImage(block.children, context);
    if (nested) return nested;
  }
  return null;
}

/** Open Graph and Twitter tags: the page's title, opening text and first picture, or the Story card. */
function linkPreview(title: string, url: string, blocks: OverstoryBlock[], context: RenderContext): string {
  const description = previewDescription(blocks, context);
  const image = previewImage(blocks, context);
  const cardImage = image ?? new URL(PAGE_ASSETS.card, context.origin).href;
  return [
    description ? `<meta name="description" content="${escapeHTML(description)}">` : "",
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="Story">`,
    `<meta property="og:title" content="${escapeHTML(title)}">`,
    description ? `<meta property="og:description" content="${escapeHTML(description)}">` : "",
    `<meta property="og:url" content="${escapeHTML(url)}">`,
    `<meta property="og:image" content="${escapeHTML(cardImage)}">`,
    image ? "" : `<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHTML(title)}">`,
    description ? `<meta name="twitter:description" content="${escapeHTML(description)}">` : "",
    `<meta name="twitter:image" content="${escapeHTML(cardImage)}">`,
    `<link rel="icon" href="${PAGE_ASSETS.icon}">`,
    `<link rel="apple-touch-icon" href="${PAGE_ASSETS.icon}">`,
  ].join("");
}

/** The bar above a page: Open in Story, and where to get it. A browser without Story does nothing with the link. */
function storyBar(locator: string, downloads: StoryDownloads = {}): string {
  const both = downloads.mac && downloads.iphone;
  const mac = downloads.mac ? `<a${both ? ' class="on-desktop"' : ""} href="${escapeHTML(downloads.mac)}">Get Story</a>` : "";
  const iphone = downloads.iphone ? `<a${both ? ' class="on-phone"' : ""} href="${escapeHTML(downloads.iphone)}">Get Story</a>` : "";
  return `<nav class="story-bar">${mac}${iphone}<a class="open-in-story" href="${escapeHTML(locator)}">Open in Story</a></nav>`;
}

function renderedProperty(value: JSONValue): string {
  if (value === null) return "<span>null</span>";
  if (typeof value === "string") return escapeHTML(value);
  if (typeof value === "number" || typeof value === "boolean") return `<code>${String(value)}</code>`;
  return `<pre><code>${escapeHTML(JSON.stringify(value, null, 2))}</code></pre>`;
}

/** Public HTML presentation of a logical data node with no authored Markdown body. */
export function renderPublicDataPage(title: string, properties: Record<string, JSONValue>): string {
  const rows = Object.entries(properties)
    .map(([name, value]) => `<div><dt>${escapeHTML(name)}</dt><dd>${renderedProperty(value)}</dd></div>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"><title>${escapeHTML(title)}</title><style>${PUBLIC_STYLES}</style></head><body><main class="public-page"><article class="story-document"><h1>${escapeHTML(title)}</h1><dl class="data-properties">${rows}</dl></article></main></body></html>`;
}

/** Where a person without Story can get it; a link is offered only for a URL the operator configured. */
export interface StoryDownloads {
  mac?: string;
  iphone?: string;
}

/**
 * The one script of the reserved-address page. When the address was opened
 * as an invitation link it reveals the invitation choices, hides the line
 * asking for one, and points the Open button at the same URL under the
 * `overstory:` scheme, and does nothing else. The code stays in the
 * fragment: the script sends it nowhere. Constant text, so the page's policy
 * names it by hash.
 */
export const RESERVED_PAGE_SCRIPT = `
if (location.hash.startsWith("#overstory-invite=")) {
  document.getElementById("open-in-story").href = "overstory:" + location.href.slice(location.protocol.length);
  document.getElementById("invitation").hidden = false;
  document.getElementById("no-invitation").hidden = true;
}
`;

/** Images overstoryd serves itself, for its own pages and their link previews. */
export const PAGE_ASSETS = {
  icon: "/.overstory/assets/story-icon.png",
  card: "/.overstory/assets/story-card.png",
} as const;

const RESERVED_STYLES = `
:root{color-scheme:light dark;--fg:#1d1b17;--muted:#6b6457;--bg:#f5efe3;--panel:#fffdf8;--border:rgba(29,27,23,.1);--button:#1d1b17;--button-fg:#f5efe3}
@media(prefers-color-scheme:dark){:root{--fg:#ece7dc;--muted:#a39b8c;--bg:#171614;--panel:#211f1c;--border:rgba(255,255,255,.1);--button:#ece7dc;--button-fg:#171614}}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:48px 20px;background:var(--bg);color:var(--fg);font:400 16px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}
main{width:100%;max-width:680px;text-align:center}
.app-icon{display:block;width:96px;height:96px;margin:0 auto 22px;filter:drop-shadow(0 6px 14px rgba(0,0,0,.18))}
h1{margin:0;font-size:34px;line-height:1.2;font-weight:700;letter-spacing:-.01em;overflow-wrap:anywhere}
.lede{margin:10px auto 0;max-width:460px;color:var(--muted)}
.choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;margin-top:36px;text-align:left}
.choice{display:flex;flex-direction:column;padding:24px;border:1px solid var(--border);border-radius:16px;background:var(--panel)}
.choice h2{margin:0;font-size:17px;font-weight:600}
.choice p{margin:6px 0 0;color:var(--muted);font-size:14px}
.choice .button{margin-top:auto}
.choice p+.button{margin-top:20px}
.button{display:block;padding:11px 16px;border-radius:10px;background:var(--button);color:var(--button-fg);font-weight:600;text-align:center;text-decoration:none}
.button:hover{opacity:.88}
.button.secondary{margin-top:8px;background:none;color:var(--fg);border:1px solid var(--border)}
.choice small{display:block;margin-top:14px;color:var(--muted);font-size:12.5px;line-height:1.45}
`;

/**
 * The page at a reserved, unclaimed `/~handle`. It depends on the handle,
 * the host's origin and the operator's download links only, so it is the
 * same bytes whether the address is held for one profile or for a pending
 * invitation, and says nothing about which. Its link preview comes from the
 * same text, since crawlers never see an invitation link's fragment.
 */
export function renderReservedPage(handle: string, origin: string, downloads: StoryDownloads = {}): string {
  const host = new URL(origin).host;
  const address = `~${escapeHTML(handle)}`;
  const pageURL = `${origin}/~${encodeURIComponent(handle)}`;
  const title = `${address} on ${escapeHTML(host)}`;
  const description = `This address is reserved for you. Open the link to claim it in Story.`;
  const meta = [
    `<meta name="description" content="${description}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Story">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${escapeHTML(pageURL)}">`,
    `<meta property="og:image" content="${escapeHTML(origin + PAGE_ASSETS.card)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="Story">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${escapeHTML(origin + PAGE_ASSETS.card)}">`,
    `<link rel="icon" href="${PAGE_ASSETS.icon}">`,
    `<link rel="apple-touch-icon" href="${PAGE_ASSETS.icon}">`,
  ].join("");
  const downloadLinks = [
    downloads.mac ? `<a class="button" href="${escapeHTML(downloads.mac)}">Get Story for Mac</a>` : "",
    downloads.iphone ? `<a class="button${downloads.mac ? " secondary" : ""}" href="${escapeHTML(downloads.iphone)}">Get Story for iPhone</a>` : "",
  ].join("");
  const getStory = downloadLinks
    ? `<section class="choice"><h2>New to Story?</h2><p>Download it, then come back to this page and choose Open in Story.</p>${downloadLinks}</section>`
    : "";
  const body = `<main><img class="app-icon" src="${PAGE_ASSETS.icon}" alt="Story" width="96" height="96"><h1>${address}</h1><p class="lede">This address on ${escapeHTML(host)} is reserved and has not been claimed yet.</p><p class="lede" id="no-invitation">If someone sent you an invitation to it, open the invitation in Story.</p><div id="invitation" hidden><div class="choices"><section class="choice"><h2>Already have Story?</h2><p>Open this invitation in the app to claim the address.</p><a class="button" id="open-in-story" href="#">Open in Story</a><small>If Story asks for your invitation, which can happen the first time you run it, choose Open in Story again, or paste this page's address into Story.</small></section>${getStory}</div></div></main><script>${RESERVED_PAGE_SCRIPT}</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${address}</title>${meta}<style>${RESERVED_STYLES}</style></head><body>${body}</body></html>`;
}

const NOTICE_STYLES = "body{max-width:620px;margin:72px auto;padding:0 24px;font:16px/1.55 system-ui;color:#292823}code{display:block;padding:12px;background:#f4f2ec;border-radius:8px}";

/** A short page with no tree content: nothing published at an address, or
 * the state of a person's reserved or linked address. `body` is HTML. */
export function renderNoticePage(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHTML(title)}</title><style>${NOTICE_STYLES}</style>${body}`;
}
