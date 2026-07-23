import { expect, test } from "@playwright/test";

test("canonicalizes Markdown storage aliases", async ({ page }) => {
  await page.goto("/render/notes.md");
  await expect(page).toHaveURL(/\/render\/notes$/);
  await expect(page.getByRole("button", { name: "· notes" })).toBeVisible();
  await expect(page.getByText("Research ideas")).toBeVisible();
});

test("reuses loaded nodes for navigation and ignores stale sidebar responses", async ({ page }) => {
  const treeRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v/tree/")) treeRequests.push(url.pathname);
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "▸ books" })).toBeVisible();

  treeRequests.length = 0;
  await page.getByRole("button", { name: "▸ books" }).click();
  await expect(page).toHaveURL(/\/render\/books$/);
  await expect(page.getByRole("columnheader", { name: "title" })).toBeVisible();
  expect(treeRequests).toEqual(["/v/tree/books"]);

  treeRequests.length = 0;
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/render\/books\/one$/);
  await expect(page.getByText("An ambiguous utopia.")).toBeVisible();
  expect(treeRequests).toEqual(["/v/tree/books/one"]);

  treeRequests.length = 0;
  await page.locator(".breadcrumbs button").filter({ hasText: "books" }).click();
  await expect(page).toHaveURL(/\/render\/books$/);
  await expect(page.getByRole("columnheader", { name: "title" })).toBeVisible();
  expect(treeRequests).toEqual(["/v/tree/books"]);

  let releaseRoot!: () => void;
  let markRootStarted!: () => void;
  const rootGate = new Promise<void>((resolve) => { releaseRoot = resolve; });
  const rootStarted = new Promise<void>((resolve) => { markRootStarted = resolve; });
  let delayRoot = true;
  await page.route("**/v/tree/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (delayRoot && pathname === "/v/tree/") {
      delayRoot = false;
      markRootStarted();
      await rootGate;
    }
    await route.continue();
  });

  await page.goto("/render/notes");
  await expect(page.getByText("Research ideas")).toBeVisible();
  await rootStarted;
  await page.getByText("the book", { exact: true }).click();
  await expect(page).toHaveURL(/\/render\/books\/one$/);
  await expect(page.getByText("An ambiguous utopia.")).toBeVisible();
  await expect(page.locator(".sidebar-path")).toHaveText("/books");
  await expect(page.getByRole("button", { name: "· one" })).toBeVisible();

  const delayedRootResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/v/tree/");
  releaseRoot();
  await delayedRootResponse;
  await expect(page.locator(".sidebar-path")).toHaveText("/books");
  await expect(page.getByRole("button", { name: "· one" })).toBeVisible();
});

test("opens authored and auto-generated subpage rows", async ({ page }) => {
  await page.goto("/");
  const generated = page.locator('.managed-child-page a[href="/books"]');
  await expect(generated).toBeVisible();
  await generated.click();
  await expect(page).toHaveURL(/\/render\/books$/);

  await page.goto("/render/notes");
  const authored = page.locator('.child-page[href="books/one.md"]');
  await expect(authored).toBeVisible();
  await authored.click();
  await expect(page).toHaveURL(/\/render\/books\/one$/);
  await expect(page.getByText("An ambiguous utopia.")).toBeVisible();
});

test("browses, searches, and edits toggle Markdown", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => { if (!["GET", "HEAD"].includes(request.method())) writes.push(`${request.method()} ${request.url()}`); });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Arbor" })).toBeVisible();
  await page.getByRole("button", { name: "· notes" }).click();
  await expect(page.getByText("Research ideas")).toBeVisible();
  await expect(page.getByText("Nested thought")).not.toBeVisible();
  const toggle = page.locator(".bn-toggle-wrapper").filter({ hasText: "Research ideas" }).locator("button");
  await toggle.click();
  await expect(page.getByText("Nested thought")).toBeVisible();
  await toggle.click();
  await expect(page.getByText("Nested thought")).not.toBeVisible();
  expect(writes).toEqual([]);

  await page.getByText("the book", { exact: true }).click();
  await expect(page).toHaveURL(/\/render\/books\/one$/);
  await expect(page.getByText("An ambiguous utopia.")).toBeVisible();
  await expect(page.getByRole("button", { name: "↑ Parent directory" })).toBeVisible();
  await page.getByRole("button", { name: "· one" }).click();
  await expect(page.getByText("An ambiguous utopia.")).toBeVisible();
  await page.getByRole("button", { name: "↑ Parent directory" }).click();
  await expect(page).toHaveURL(/\/render\/$/);
  await page.getByRole("button", { name: "· notes" }).click();

  await page.keyboard.press("Meta+p");
  await page.getByPlaceholder("Search paths and contents").fill("Apple orchard");
  await expect(page.getByText("Notes", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.locator(".properties summary").click();
  const topic = page.locator(".properties label").filter({ hasText: "topic" }).locator("input");
  await topic.fill("trees");
  await expect(page.getByRole("status")).toHaveText("Changes pending");
  await expect(page.getByRole("status")).toHaveText("Saved");
});

test("round-trips inline Markdown and uses Markdown-aware clipboard formats", async ({ page }) => {
  await page.goto("/render/inline-markdown");

  const first = page.locator('[data-content-type="paragraph"]').filter({ hasText: "Untouched" });
  await expect(first.locator("strong")).toHaveText("strong");
  await expect(first.locator("em")).toHaveText("emphasis");
  await expect(first.locator("s")).toHaveText("removed");
  await expect(first.locator("code")).toHaveText("code");
  await expect(first.locator('a[href="https://example.com"]')).toHaveText("a link");

  const hardBreak = page.locator('[data-content-type="paragraph"]').filter({ hasText: /Hard.*break/ });
  await expect(hardBreak.locator("br")).toHaveCount(1);

  const originalBody = [
    "Untouched __strong__, _emphasis_, ~~removed~~, `code`, and [a link](https://example.com).",
    "",
    "Edit this __strong__ sentence.",
    "",
    "Hard\\",
    "break.",
    "",
    "```md",
    "**literal code**",
    "```",
    "",
    '<aside data-kind="raw">**literal raw Markdown**</aside>',
    "",
    "After raw Markdown.",
  ].join("\n");
  const bodySource = async () => page.evaluate(async () => {
    const response = await fetch("/v/tree/inline-markdown");
    const node = await response.json();
    return node.document.bodySource as string;
  });
  expect((await bodySource()).trimEnd()).toBe(originalBody);

  await page.locator(".properties summary").click();
  const topic = page.locator(".properties label").filter({ hasText: "topic" }).locator("input");
  await topic.fill("round-trip");
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect((await bodySource()).trimEnd()).toBe(originalBody);

  const edited = page.locator('[data-content-type="paragraph"]').filter({ hasText: "Edit this" }).locator(".bn-inline-content");
  await edited.evaluate((element) => {
    const editor = (window as any).ProseMirror;
    editor.view.focus();
    editor.commands.setTextSelection(editor.view.posAtDOM(element, element.childNodes.length));
  });
  await page.keyboard.type(" changed");
  await expect(page.getByRole("status")).not.toHaveText("Saved");
  await expect(page.getByRole("status")).toHaveText("Saved");
  const afterEdit = (await bodySource()).trimEnd();
  expect(afterEdit).toContain("Untouched __strong__, _emphasis_, ~~removed~~, `code`, and [a link](https://example.com).");
  expect(afterEdit).toContain("Edit this **strong** sentence. changed");

  await edited.evaluate((element) => {
    const editor = (window as any).ProseMirror;
    editor.view.focus();
    editor.commands.setTextSelection(editor.view.posAtDOM(element, element.childNodes.length));
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Typed **bold** and *italic* and ~~gone~~ and `code`");
  const typed = page.locator('[data-content-type="paragraph"]').filter({ hasText: "Typed" });
  await expect(typed.locator("strong")).toHaveText("bold");
  await expect(typed.locator("em")).toHaveText("italic");
  await expect(typed.locator("s")).toHaveText("gone");
  await expect(typed.locator("code")).toHaveText("code");
  await expect(page.getByRole("status")).not.toHaveText("Saved");
  await expect(page.getByRole("status")).toHaveText("Saved");

  await page.keyboard.press("Enter");
  await page.evaluate(() => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/markdown", "Pasted **Markdown MIME** with `code`.");
    document.activeElement?.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    }));
  });
  const markdownMimePaste = page.locator('[data-content-type="paragraph"]').filter({ hasText: "Markdown MIME" });
  await expect(markdownMimePaste.locator("strong")).toHaveText("Markdown MIME");
  await expect(markdownMimePaste.locator("code")).toHaveText("code");
  await expect(page.getByRole("status")).not.toHaveText("Saved");
  await expect(page.getByRole("status")).toHaveText("Saved");

  await page.keyboard.press("Enter");
  await page.evaluate(() => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "Pasted *plain Markdown* with ~~strike~~.");
    document.activeElement?.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    }));
  });
  const plainPaste = page.locator('[data-content-type="paragraph"]').filter({ hasText: "plain Markdown" });
  await expect(plainPaste.locator("em")).toHaveText("plain Markdown");
  await expect(plainPaste.locator("s")).toHaveText("strike");
  await expect(page.getByRole("status")).not.toHaveText("Saved");
  await expect(page.getByRole("status")).toHaveText("Saved");
  const afterPaste = await bodySource();
  expect(afterPaste).toContain("Pasted **Markdown MIME** with `code`.");
  expect(afterPaste).toContain("Pasted *plain Markdown* with ~~strike~~.");

  const copied = await page.evaluate(() => {
    (window as any).ProseMirror.commands.selectAll();
    const clipboard = new DataTransfer();
    document.querySelector(".bn-editor")?.dispatchEvent(new ClipboardEvent("copy", {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    }));
    return clipboard.getData("text/plain");
  });
  expect(copied).toContain("**strong**");
  expect(copied).toContain("*emphasis*");
  expect(copied).toContain("~~removed~~");
  expect(copied).toContain("`code`");
  expect(copied).toContain("[a link](https://example.com)");

  await first.locator("strong").dblclick();
  const toolbar = page.locator(".bn-formatting-toolbar");
  await expect(toolbar.locator('[data-test="bold"]')).toBeVisible();
  await expect(toolbar.locator('[data-test="italic"]')).toBeVisible();
  await expect(toolbar.locator('[data-test="strike"]')).toBeVisible();
  await expect(toolbar.locator('[data-test="code"]')).toBeVisible();
  await expect(toolbar.locator('[data-test="createLink"]')).toBeVisible();
  await expect(toolbar.locator('[data-test="underline"]')).toHaveCount(0);
  await expect(toolbar.locator('[data-test="colors"]')).toHaveCount(0);
  await expect(toolbar.locator('[data-test^="alignText"]')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('[data-content-type="paragraph"]').filter({ hasText: "Typed" }).locator("strong")).toHaveText("bold");
  await expect(page.locator('[data-content-type="paragraph"]').filter({ hasText: "Markdown MIME" }).locator("strong")).toHaveText("Markdown MIME");
  await expect(page.locator('[data-content-type="paragraph"]').filter({ hasText: "plain Markdown" }).locator("em")).toHaveText("plain Markdown");
});

test("renders a Markdown collection and opens a record", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /books/ }).click();
  await expect(page.getByRole("columnheader", { name: "title" })).toBeVisible();
  await expect(page.locator('input[value="The Dispossessed"]')).toBeVisible();
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.getByText("An ambiguous utopia.")).toBeVisible();
});
