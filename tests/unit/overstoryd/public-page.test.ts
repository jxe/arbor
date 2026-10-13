import { describe, expect, test } from "bun:test";
import { renderPublicMarkdownPage, renderReservedPage, RESERVED_PAGE_SCRIPT } from "../../../packages/overstoryd/src/public-page.ts";

const page = (sourceDirectory: string, source: string) => renderPublicMarkdownPage({
  source,
  fallbackTitle: "Page",
  origin: "https://garden.example.org",
  treeCanonicalPath: "/~joe/todos",
  sourceDirectory,
});

describe("public Markdown pages", () => {
  test("resolve relative links from the directory holding the source file", () => {
    // `Picture-of-Life.md` sits beside `Picture-of-Life/`; `Amends/_index.md` sits inside `Amends/`.
    expect(page("/", "[C](Calendar.md#overstory-key=id:h31mlm)\n[F](Picture-of-Life/Foo.md)\n"))
      .toContain('href="/~joe/todos/Calendar;overstory-key=id:h31mlm"');
    expect(page("/", "[F](Picture-of-Life/Foo.md)\n")).toContain('href="/~joe/todos/Picture-of-Life/Foo"');
    expect(page("/Amends", "[C](../Calendar.md)\n[N](note.md)\n")).toContain('href="/~joe/todos/Calendar"');
    expect(page("/Amends", "[N](note.md)\n")).toContain('href="/~joe/todos/Amends/note"');
  });

  test("a bare fragment stays a fragment", () => {
    expect(page("/", "[C](Calendar.md#h31mlm)\n")).toContain('href="/~joe/todos/Calendar#h31mlm"');
  });
});

describe("presented headings on a public page", () => {
  const children = [{ name: "note", href: "/~joe/todos/dir/note", kind: "document" as const }];
  const render = (source: string, fallbackTitle = "field-notes") => renderPublicMarkdownPage({
    source, fallbackTitle, origin: "https://garden.example.org", treeCanonicalPath: "/~joe/todos", sourceDirectory: "/dir", children,
  });

  test("a body without a leading H1 opens with the name, hyphens shown as spaces", () => {
    expect(render("Text.\n")).toContain("<h1>field notes</h1>");
    expect(render("# Authored\n")).not.toContain("<h1>field notes</h1>");
  });

  test("unlinked children close the page under Children", () => {
    const html = render("# Dir\n\n## Last\n\nBody.\n");
    expect(html).toContain('<h1>Children</h1><div class="child-list">');
    expect(html.indexOf("Body.")).toBeLessThan(html.indexOf("<h1>Children</h1>"));
  });

  test("an explicit marker places them with no heading", () => {
    const html = render("# Dir\n\n<!-- overstory:children -->\n\nTail.\n");
    expect(html).not.toContain("<h1>Children</h1>");
    expect(html).not.toContain('class="raw-markdown"');
    expect(html.indexOf('class="child-list"')).toBeLessThan(html.indexOf("Tail."));
  });

  test("linked children present no heading", () => {
    expect(render("# Dir\n\n[Note](note.md)\n")).not.toContain("<h1>Children</h1>");
  });
});

describe("the reserved-address page", () => {
  test("says the address is reserved and unclaimed, and that an invitation opens in Story", () => {
    const page = renderReservedPage("alice", "https://garden.example.org");
    expect(page).toContain("<h1>~alice</h1>");
    expect(page).toContain('<img class="app-icon" src="/.overstory/assets/story-icon.png"');
    expect(page).toContain("This address on garden.example.org is reserved and has not been claimed yet.");
    expect(page).toContain("open the invitation in Story");
    // Nothing about what holds the reservation.
    expect(page).not.toMatch(/profile|identity|digest/i);
  });

  test("keeps the invitation block hidden until its one constant script reveals it", () => {
    const page = renderReservedPage("alice", "https://garden.example.org");
    expect(page).toContain('<div id="invitation" hidden>');
    expect(page).toContain('<a class="button" id="open-in-story" href="#">Open in Story</a>');
    expect(page.match(/<script>/g)).toHaveLength(1);
    expect(page).toContain(`<script>${RESERVED_PAGE_SCRIPT}</script>`);
    // The script is the same text for every handle and configuration.
    expect(renderReservedPage("bob", "https://other.example", { mac: "https://example.org/mac" })).toContain(`<script>${RESERVED_PAGE_SCRIPT}</script>`);
    expect(RESERVED_PAGE_SCRIPT).toContain('location.hash.startsWith("#overstory-invite=")');
    expect(RESERVED_PAGE_SCRIPT).toContain('"overstory:" + location.href.slice(location.protocol.length)');
    expect(RESERVED_PAGE_SCRIPT).not.toMatch(/fetch|XMLHttpRequest|sendBeacon|src\s*=/);
  });

  test("offers each download link only when its URL is configured", () => {
    const none = renderReservedPage("alice", "https://garden.example.org");
    expect(none).not.toContain("Get Story for");
    const mac = renderReservedPage("alice", "https://garden.example.org", { mac: "https://example.org/story?a=1&b=2" });
    expect(mac).toContain('<a class="button" href="https://example.org/story?a=1&amp;b=2">Get Story for Mac</a>');
    expect(mac).not.toContain("Get Story for iPhone");
    const both = renderReservedPage("alice", "https://garden.example.org", { mac: "https://example.org/mac", iphone: "https://example.org/iphone" });
    expect(both).toContain('<a class="button" href="https://example.org/mac">Get Story for Mac</a>');
    expect(both).toContain('<a class="button secondary" href="https://example.org/iphone">Get Story for iPhone</a>');
    // Both sit inside the hidden block.
    expect(both.indexOf("Get Story for Mac")).toBeGreaterThan(both.indexOf('<div id="invitation" hidden>'));
    expect(both.indexOf("Get Story for iPhone")).toBeLessThan(both.indexOf("</main>"));
  });

  test("carries a link preview built from the address alone, since crawlers never see the invitation fragment", () => {
    const page = renderReservedPage("alice", "https://garden.example.org");
    expect(page).toContain('<meta property="og:title" content="~alice on garden.example.org">');
    expect(page).toContain('<meta property="og:url" content="https://garden.example.org/~alice">');
    expect(page).toContain('<meta property="og:image" content="https://garden.example.org/.overstory/assets/story-card.png">');
    expect(page).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(page.slice(0, page.indexOf("</head>"))).not.toMatch(/invit|profile|identity|digest/i);
  });
});
