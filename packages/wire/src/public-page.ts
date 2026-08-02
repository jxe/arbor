import type { ArborBlock } from "@arbor/core";
import { resolveLogicalURL } from "@arbor/core/logical-url";
import { parseMarkdown } from "@arbor/editor";

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
  documentPath: string;
  children?: PublicPageChild[];
}

function escapeHTML(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function encodedPath(path: string): string {
  const parts = path.split("/").filter(Boolean).map(encodeURIComponent);
  return `/${parts.join("/")}`;
}

function publicTreePath(boundary: string, path: string): string {
  const base = boundary === "/" ? "" : encodedPath(boundary).replace(/\/$/, "");
  const suffix = path === "/" ? "" : encodedPath(path);
  return `${base}${suffix}` || "/";
}

interface RenderContext {
  origin: string;
  host: string;
  treeCanonicalPath: string;
  documentPath: string;
  footnotes: Map<string, number>;
}

function linkHref(raw: string, context: RenderContext): string | null {
  const resolved = resolveLogicalURL(context.documentPath, raw);
  if (!resolved) return null;
  if (resolved.kind === "local") {
    const fragment = resolved.fragment ? `#${encodeURIComponent(resolved.fragment)}` : "";
    return `${publicTreePath(context.treeCanonicalPath, resolved.path)}${fragment}`;
  }
  if (resolved.kind === "arbor" && "dns" in resolved.authority && resolved.authority.dns === context.host) {
    const fragment = resolved.fragment ? `#${encodeURIComponent(resolved.fragment)}` : "";
    return `${encodedPath(resolved.path)}${fragment}`;
  }
  if (resolved.kind === "external") {
    try {
      const protocol = new URL(resolved.href, context.origin).protocol;
      return ["http:", "https:", "mailto:", "tel:"].includes(protocol) ? resolved.href : null;
    } catch {
      return null;
    }
  }
  if (resolved.kind === "fragment") return `#${encodeURIComponent(resolved.pageID)}`;
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

function childRow(label: string, href: string, detail: string, folder: boolean, context: RenderContext, hrefIsPublic = false): string {
  const resolved = hrefIsPublic ? href : linkHref(href, context) ?? href;
  return `<a class="child-page" href="${escapeHTML(resolved)}"><span class="child-page-kind">${childIcon(folder)}</span><strong>${renderInline(label, context)}</strong><small>${escapeHTML(detail)}</small></a>`;
}

function renderList(items: ArborBlock[], ordered: boolean, checked: boolean, context: RenderContext): string {
  const tag = ordered ? "ol" : "ul";
  const className = checked ? ' class="check-list"' : "";
  return `<${tag}${className}>${items.map((block) => `<li>${checked ? `<input type="checkbox" disabled${block.props?.checked ? " checked" : ""}>` : ""}<span>${renderInline(block.content ?? "", context)}</span>${renderBlocks(block.children, context)}</li>`).join("")}</${tag}>`;
}

function renderBlocks(blocks: ArborBlock[], context: RenderContext): string {
  let html = "";
  for (let index = 0; index < blocks.length;) {
    const block = blocks[index]!;
    if (["bulletListItem", "numberedListItem", "checkListItem"].includes(block.type)) {
      const items: ArborBlock[] = [];
      while (blocks[index]?.type === block.type) items.push(blocks[index++]!);
      html += renderList(items, block.type === "numberedListItem", block.type === "checkListItem", context);
      continue;
    }
    switch (block.type) {
      case "heading": {
        const level = Math.min(6, Math.max(1, Number(block.props?.level ?? 1)));
        html += `<h${level}>${renderInline(block.content ?? "", context)}</h${level}>${renderBlocks(block.children, context)}`;
        break;
      }
      case "paragraph":
        html += `<p>${renderInline(block.content ?? "", context)}</p>${renderBlocks(block.children, context)}`;
        break;
      case "quote":
        html += `<blockquote>${renderInline(block.content ?? "", context)}</blockquote>`;
        break;
      case "codeBlock": {
        const language = String(block.props?.language ?? "");
        html += `<div class="code-block">${language ? `<small>${escapeHTML(language)}</small>` : ""}<pre><code>${escapeHTML(block.content ?? "")}</code></pre></div>`;
        break;
      }
      case "divider":
        html += "<hr>";
        break;
      case "mathBlock":
        html += `<div class="math-block">${escapeHTML(block.content ?? "")}</div>`;
        break;
      case "image": {
        const raw = String(block.props?.url ?? "");
        const href = linkHref(raw, context);
        const caption = String(block.props?.caption ?? "");
        html += href ? `<figure><img src="${escapeHTML(href)}" alt="${escapeHTML(caption)}">${caption ? `<figcaption>${renderInline(caption, context)}</figcaption>` : ""}</figure>` : "";
        break;
      }
      case "toggle":
        html += `<details><summary>${renderInline(block.content ?? "", context)}</summary><div class="nested-blocks">${renderBlocks(block.children, context)}</div></details>`;
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
        if (!block.props?.blank) html += `<div class="raw-markdown"><span>Markdown</span><pre>${escapeHTML((block.content ?? "").trimEnd())}</pre></div>`;
        break;
    }
    index += 1;
  }
  return html;
}

function collectFootnotes(blocks: ArborBlock[]): Map<string, number> {
  const labels: string[] = [];
  const add = (label: string) => { if (label && !labels.includes(label)) labels.push(label); };
  const visit = (items: ArborBlock[]) => items.forEach((block) => {
    for (const match of (block.content ?? "").matchAll(/\[\^([^\]\s]+)\]/g)) add(match[1]!);
    if (block.type === "footnoteDefinition") add(String(block.props?.label ?? "1"));
    visit(block.children);
  });
  visit(blocks);
  return new Map(labels.map((label, index) => [label, index + 1]));
}

function plainTitle(source: string): string {
  return source
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`$]/g, "")
    .trim();
}

function referencedChildren(blocks: ArborBlock[], context: RenderContext): Set<string> {
  const result = new Set<string>();
  const visit = (items: ArborBlock[]) => items.forEach((block) => {
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
:root{color-scheme:light;--fg:#37352f;--muted:rgba(55,53,47,.5);--bg:#fff;--hover:rgba(55,53,47,.08);--border:rgba(55,53,47,.12);--strong-border:rgba(55,53,47,.22);--code-fg:#eb5757;--code-bg:rgba(135,131,120,.15);--divider:#e9e9e7;--link:#2383e2}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--fg:#dad8d3;--muted:rgba(255,255,255,.46);--bg:#191919;--hover:rgba(255,255,255,.08);--border:rgba(255,255,255,.13);--strong-border:rgba(255,255,255,.24);--code-fg:#ff7369;--code-bg:rgba(255,255,255,.08);--divider:rgba(255,255,255,.13);--link:#529cff}}
*{box-sizing:border-box}html,body{min-height:100%}body{margin:0;background:var(--bg);color:var(--fg);font:400 16px/24px Inter,ui-sans-serif,system-ui,sans-serif}.public-page{width:708px;max-width:calc(100% - 64px);margin:76px auto 96px}.arbor-document{overflow-wrap:anywhere}.arbor-document h1,.arbor-document h2,.arbor-document h3,.arbor-document h4,.arbor-document h5,.arbor-document h6{margin:0;padding:0;font-weight:600;line-height:1.2}.arbor-document h1{font-size:40px;line-height:48px}.arbor-document h2{margin-top:40px;font-size:24px}.arbor-document h3{margin-top:30px;font-size:20px}.arbor-document h4,.arbor-document h5,.arbor-document h6{margin-top:24px;font-size:16px}.arbor-document h1+*,.arbor-document h2+*,.arbor-document h3+*{margin-top:8px}.arbor-document p{margin:4px 0}.arbor-document a{color:inherit;text-decoration:underline;text-decoration-color:var(--strong-border);text-underline-offset:2px}.arbor-document a:hover{color:var(--link);text-decoration-color:var(--link)}.arbor-document strong{font-weight:600}.arbor-document code{padding:1.5px 4px;border-radius:3px;background:var(--code-bg);color:var(--code-fg);font:400 13.6px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.arbor-document ul,.arbor-document ol{margin:1px 0;padding-left:34px}.arbor-document li{padding:3px 0}.arbor-document li>ul,.arbor-document li>ol{margin-top:2px}.check-list{padding-left:0;list-style:none}.check-list li{display:grid;grid-template-columns:24px minmax(0,1fr);align-items:start}.check-list input{width:16px;height:16px;margin:5px 8px 0 0;accent-color:var(--link)}blockquote{margin:4px 0;padding-left:14px;border-left:3px solid var(--fg);font-size:19.2px;line-height:1.45}.code-block{position:relative;margin:8px 0;padding:16px;border-radius:8px;background:var(--code-bg)}.code-block small{position:absolute;top:7px;right:10px;color:var(--muted);font-size:10px}.code-block pre{margin:0;overflow:auto;white-space:pre-wrap}.code-block pre code{padding:0;background:none;color:var(--fg);font:400 14px/21px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}hr{margin:12px 0;border:0;border-top:1px solid var(--divider)}figure{margin:12px 0}figure img{display:block;max-width:100%;border-radius:3px}figcaption{margin-top:5px;color:var(--muted);font-size:13px}.inline-image{max-width:100%;vertical-align:middle}.inline-math,.math-block{font-family:Georgia,"Times New Roman",serif}.inline-math{padding:0 2px}.math-block{margin:8px 0;padding:12px 16px;overflow:auto;border-radius:8px;background:color-mix(in srgb,var(--code-bg) 72%,transparent);text-align:center}details{margin:1px 0}summary{padding:5px 0;cursor:pointer;font-weight:400}.nested-blocks{margin-left:34px}.raw-markdown{margin:8px 0;padding:10px 12px;border:1px dashed var(--strong-border);border-radius:6px;background:var(--code-bg);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.raw-markdown>span{display:block;color:var(--muted);font:10px Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase}.raw-markdown pre{margin:4px 0 0;white-space:pre-wrap}.footnote-reference a{color:var(--link);font-size:.72em;font-weight:600;text-decoration:none}.footnote-definition{display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;margin-top:8px;color:var(--muted);font-size:14px;line-height:21px}.footnote-definition>span{color:var(--link);font-weight:600;text-align:right}.footnote-definition>div{color:var(--fg)}.child-list{margin-top:8px}.child-page{display:grid;grid-template-columns:24px minmax(0,auto) minmax(0,1fr);align-items:baseline;column-gap:10px;width:100%;padding:5px 0;border-radius:4px;color:var(--fg)!important;text-decoration:none!important}.child-page:hover{background:var(--hover)}.child-page-kind{display:flex;align-items:center;justify-content:flex-end;width:24px;color:var(--muted)}.child-page svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.35;stroke-linecap:round;stroke-linejoin:round}.child-page strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.child-page small{min-width:0;overflow:hidden;color:var(--muted);font-size:11px;opacity:0;text-overflow:ellipsis;white-space:nowrap}.child-page:hover small,.child-page:focus small{opacity:1}
@media(max-width:760px){.public-page{width:auto;max-width:none;margin:42px 20px 72px}.arbor-document h1{font-size:34px;line-height:42px}.arbor-document h2{margin-top:32px}}
`;

export function renderPublicMarkdownPage(options: PublicMarkdownPageOptions): string {
  const document = parseMarkdown(options.source);
  const context: RenderContext = {
    origin: options.origin,
    host: new URL(options.origin).host,
    treeCanonicalPath: options.treeCanonicalPath,
    documentPath: options.documentPath,
    footnotes: collectFootnotes(document.blocks),
  };
  const firstHeading = document.blocks.find((block) => block.type === "heading" && Number(block.props?.level ?? 1) === 1);
  const title = plainTitle(firstHeading?.content ?? "") || options.fallbackTitle;
  const beginsWithTitle = document.blocks.find((block) => block.type !== "rawMarkdown" || !block.props?.blank)?.type === "heading"
    && Number(document.blocks.find((block) => block.type !== "rawMarkdown" || !block.props?.blank)?.props?.level ?? 1) === 1;
  const referenced = referencedChildren(document.blocks, context);
  const projectedChildren = (options.children ?? [])
    .filter((child) => !referenced.has(child.href))
    .map((child) => childRow(child.name, child.href, child.href, child.kind === "folder", context, true))
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"><title>${escapeHTML(title)}</title><style>${PUBLIC_STYLES}</style></head><body><main class="public-page"><article class="arbor-document">${beginsWithTitle ? "" : `<h1>${escapeHTML(title)}</h1>`}${renderBlocks(document.blocks, context)}${projectedChildren ? `<div class="child-list">${projectedChildren}</div>` : ""}</article></main></body></html>`;
}
