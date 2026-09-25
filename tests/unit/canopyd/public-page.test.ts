import { describe, expect, test } from "bun:test";
import { renderPublicMarkdownPage } from "../../../packages/canopyd/src/public-page.ts";

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
    expect(page("/", "[C](Calendar.md#arbor-key=id:h31mlm)\n[F](Picture-of-Life/Foo.md)\n"))
      .toContain('href="/~joe/todos/Calendar;arbor-key=id:h31mlm"');
    expect(page("/", "[F](Picture-of-Life/Foo.md)\n")).toContain('href="/~joe/todos/Picture-of-Life/Foo"');
    expect(page("/Amends", "[C](../Calendar.md)\n[N](note.md)\n")).toContain('href="/~joe/todos/Calendar"');
    expect(page("/Amends", "[N](note.md)\n")).toContain('href="/~joe/todos/Amends/note"');
  });

  test("a bare fragment stays a fragment", () => {
    expect(page("/", "[C](Calendar.md#h31mlm)\n")).toContain('href="/~joe/todos/Calendar#h31mlm"');
  });
});
