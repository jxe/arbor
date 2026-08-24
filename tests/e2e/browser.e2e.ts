import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// The browser URL space is OS-shaped: /render/<absolute path>. The server
// serves the fixture workspace at this fixed session root.
const ROOT = realpathSync(join(tmpdir(), "arbor-e2e-workspace"));
const PROMOTABLE_ROOT = realpathSync(join(tmpdir(), "arbor-e2e-untracked", "arbor-e2e-promotable"));
const ALICE_PROFILE = join(tmpdir(), "arbor-e2e-alice-profile");
const COMMUNITY_PROFILE = join(realpathSync(tmpdir()), "arbor-e2e-community-profile");
const E2E_PORT = Number(process.env.ARBOR_E2E_PORT ?? 4321);
const HOST_ORIGIN = `http://127.0.0.1:${E2E_PORT + 1}`;
const r = (path: string) => `/render${ROOT}${path}`;
const promotable = (path: string) => `/render${PROMOTABLE_ROOT}${path}`;
const escaped = ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const atUrl = (path: string) => new RegExp(`/render${escaped}${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

test("renders an unplaced remote tree through read-only BlockNote without an iframe", async ({ page }) => {
  const remote = `${HOST_ORIGIN}/~editors`;
  await page.goto(`/render?browse=${encodeURIComponent(remote)}`);
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Editors", level: 1 })).toBeVisible();
  await expect(page.getByText("remote · read-only")).toBeVisible();
  await expect(page.locator(".read-only-page .bn-editor")).toHaveAttribute("contenteditable", "false");
  await page.locator('.read-only-page a[href="guide"]').click();
  await expect(page.getByRole("heading", { name: "Editorial guide", level: 1 })).toBeVisible();
  await expect(page.getByText("A remote Markdown page.")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("browse")).toBe(`${HOST_ORIGIN}/~editors/guide`);
});

test("places the writable community from the account sheet and adds a person without flattening members", async ({ page, request }) => {
  await page.goto(r(""));
  await page.getByRole("button", { name: "Community and profile" }).click();
  const accountSheet = page.locator(".tree-control-modal");
  const community = accountSheet.locator(".profile-namespace").filter({ hasText: "Community" });
  await expect(community).toContainText("Choose a local folder…");

  page.once("dialog", (dialog) => dialog.accept(COMMUNITY_PROFILE));
  await community.click();
  await expect(page).toHaveURL(new RegExp(`/render${COMMUNITY_PROFILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(page.getByRole("heading", { name: "Arbor Community", level: 1 })).toBeVisible();

  await page.locator(".properties summary").click();
  const members = page.locator(".property-list-row").filter({ has: page.locator(".property-name", { hasText: "members" }) });
  await expect(members.getByText("~owner", { exact: true })).toBeVisible();
  await expect(members.getByText("~alice", { exact: true })).toBeVisible();
  await members.getByRole("button", { name: "Add person" }).click();
  await members.getByRole("textbox", { name: "Person handle or profile" }).fill("bob");
  await members.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");

  const expected = `arbor://127.0.0.1:${E2E_PORT + 1}/~bob`;
  const storedMembers = await page.evaluate(async (path) => {
    const node = await fetch(`/v1/node?tree=local&path=${encodeURIComponent(path)}`).then((value) => value.json());
    return node.document.frontmatter.members as unknown;
  }, COMMUNITY_PROFILE);
  expect(storedMembers).toEqual([
    `arbor://127.0.0.1:${E2E_PORT + 1}/~owner`,
    `arbor://127.0.0.1:${E2E_PORT + 1}/~alice`,
    expected,
  ]);
  await expect.poll(async () => (await request.get(`${HOST_ORIGIN}/~bob`)).headers()["x-arbor-profile-state"] ?? null)
    .toBe("reserved");
});

test("canonicalizes Markdown storage aliases", async ({ page }) => {
  await page.goto(r("/notes.md"));
  await expect(page).toHaveURL(atUrl("/notes"));
  await expect(page.getByRole("button", { name: "· notes" })).toBeVisible();
  await expect(page.getByText("Research ideas")).toBeVisible();

  const header = page.locator(".app-header");
  const pageActions = page.getByLabel("Page actions");
  const profile = page.getByRole("button", { name: "Community and profile" });
  const [headerBox, actionsBox, profileBox] = await Promise.all([
    header.boundingBox(),
    pageActions.boundingBox(),
    profile.boundingBox(),
  ]);
  expect(headerBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(profileBox).not.toBeNull();
  expect(actionsBox!.y).toBeGreaterThanOrEqual(headerBox!.y);
  expect(actionsBox!.y + actionsBox!.height).toBeLessThanOrEqual(headerBox!.y + headerBox!.height);
  expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(profileBox!.x);

  await pageActions.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height - 1);
});

test("reuses loaded nodes for navigation and ignores stale sidebar responses", async ({ page }) => {
  const treeRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    const requestPath = url.searchParams.get("path") ?? "";
    if (url.pathname === "/v1/node" && requestPath.startsWith(ROOT)) treeRequests.push(requestPath);
  });

  await page.goto(r(""));
  await expect(page.getByRole("button", { name: "▸ books" })).toBeVisible();

  treeRequests.length = 0;
  await page.getByRole("button", { name: "▸ books" }).click();
  await expect(page).toHaveURL(atUrl("/books"));
  await expect(page.getByRole("columnheader", { name: "title" })).toBeVisible();
  expect(treeRequests).toEqual([`${ROOT}/books`]);

  treeRequests.length = 0;
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(atUrl("/books/one"));
  await expect(page.getByText("An ambiguous utopia.")).toBeVisible();
  expect(treeRequests).toEqual([`${ROOT}/books/one`]);

  treeRequests.length = 0;
  await page.locator(".breadcrumbs button").filter({ hasText: "books" }).click();
  await expect(page).toHaveURL(atUrl("/books"));
  await expect(page.getByRole("columnheader", { name: "title" })).toBeVisible();
  expect(treeRequests).toEqual([`${ROOT}/books`]);

  let releaseRoot!: () => void;
  let markRootStarted!: () => void;
  const rootGate = new Promise<void>((resolve) => { releaseRoot = resolve; });
  const rootStarted = new Promise<void>((resolve) => { markRootStarted = resolve; });
  let delayRoot = true;
  await page.route("**/v1/node?*", async (route) => {
    const url = new URL(route.request().url());
    if (delayRoot && url.searchParams.get("path") === ROOT) {
      delayRoot = false;
      markRootStarted();
      await rootGate;
    }
    await route.continue();
  });

  await page.goto(r("/notes"));
  await expect(page.getByText("Research ideas")).toBeVisible();
  await rootStarted;
  await page.getByText("the book", { exact: true }).click();
  await expect(page).toHaveURL(atUrl("/books/one"));
  await expect(page.getByText("An ambiguous utopia.")).toBeVisible();
  await expect(page.locator(".sidebar-path")).toHaveText(`${ROOT}/books`);
  await expect(page.getByRole("button", { name: "· one" })).toBeVisible();

  const delayedRootResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/v1/node" && url.searchParams.get("path") === ROOT;
  });
  releaseRoot();
  await delayedRootResponse;
  await expect(page.locator(".sidebar-path")).toHaveText(`${ROOT}/books`);
  await expect(page.getByRole("button", { name: "· one" })).toBeVisible();
});

test("opens authored and provider-completed child links", async ({ page }) => {
  await page.goto(r(""));
  const generated = page.locator('.managed-child-page a[href="books"]');
  await expect(generated).toBeVisible();
  await generated.click();
  await expect(page).toHaveURL(atUrl("/books"));

  await page.goto(r("/notes"));
  const authored = page.locator('.child-page[href="../books/one.md"]');
  await expect(authored).toBeVisible();
  await authored.click();
  await expect(page).toHaveURL(atUrl("/books/one"));
  await expect(page.getByText("An ambiguous utopia.")).toBeVisible();
});

test("adds a Markdown title above the first provider-completed child row", async ({ page }) => {
  await page.goto(r("/title-first"));
  const childRow = page.locator('[data-managed-row="/title-first/child"]');
  const addTitle = page.getByRole("button", { name: "Add page title" });
  const topLevelBlocks = page.locator(".bn-editor > .bn-block-group > .bn-block-outer");
  await expect(childRow).toBeVisible();
  await expect(addTitle).toBeVisible();
  await expect(topLevelBlocks.first().locator('[data-managed-row="/title-first/child"]')).toBeVisible();

  await addTitle.click();
  await expect(addTitle).toHaveCount(0);
  await expect(topLevelBlocks.first().getByRole("heading", { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => (window as any).ProseMirror.view.hasFocus())).toBe(true);

  await page.keyboard.type("Synthetic title");
  await expect(page.getByRole("heading", { name: "Synthetic title", level: 1 })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Saved");
  const titleFirstBody = async () => page.evaluate(async () => {
    const response = await fetch("/v1/node?path=%2Ftitle-first");
    const node = await response.json();
    return node.document.bodySource as string;
  });
  expect(await titleFirstBody()).toMatch(/^# Synthetic title/);
  expect(await titleFirstBody()).toContain("](child)");
  expect(await titleFirstBody()).not.toContain("managed:");

  await page.keyboard.press("Meta+z");
  await expect(page.getByRole("button", { name: "Add page title" })).toBeVisible();
  await expect(childRow).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(await titleFirstBody()).not.toContain("Synthetic title");

  await page.keyboard.press("Meta+Shift+z");
  await expect(page.getByRole("button", { name: "Add page title" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Synthetic title", level: 1 })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Synthetic title", level: 1 })).toBeVisible();
  await expect(childRow).toBeVisible();

  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(r("/empty-title"));
  const emptyAddTitle = page.getByRole("button", { name: "Add page title" });
  await expect(emptyAddTitle).toBeVisible();
  expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
  const titleBox = await emptyAddTitle.boundingBox();
  expect(titleBox).not.toBeNull();
  expect(titleBox!.x).toBeGreaterThanOrEqual(0);
  expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(390);
  await expect(topLevelBlocks).toHaveCount(1);

  await emptyAddTitle.focus();
  await expect(emptyAddTitle).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await expect(emptyAddTitle).toHaveCount(0);
  await expect(topLevelBlocks).toHaveCount(1);
  await expect(topLevelBlocks.first().getByRole("heading", { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => (window as any).ProseMirror.view.hasFocus())).toBe(true);
  await page.keyboard.type("Empty title");
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(await page.evaluate(async () => {
    const response = await fetch("/v1/node?path=%2Fempty-title");
    const node = await response.json();
    return node.document.bodySource as string;
  })).toMatch(/^# Empty title/);

  await page.setViewportSize({ width: 1200, height: 844 });
  await page.goto(r("/already-titled"));
  await expect(page.getByRole("button", { name: "Add page title" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Existing title", level: 1 })).toBeVisible();
  await page.getByText("Body.", { exact: true }).hover();
  await expect(page.getByRole("button", { name: "Add block" })).toBeVisible();
});

test("reorders a child row by writing the complete directory Markdown", async ({ page }) => {
  const operations: Array<{ op?: string; source?: string }> = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/v1/mutations") return;
    const body = request.postDataJSON() as { operations?: Array<{ op?: string; source?: string }> };
    operations.push(...(body.operations ?? []));
  });
  await page.goto(r("/drag-order"));
  const source = page.locator('[data-managed-row="/drag-order/simulacra"]');
  const heading = page.getByRole("heading", { name: "Oliver" });
  await expect(source).toBeVisible();
  await expect(heading).toBeVisible();

  await source.hover();
  const sourceHandle = page.locator('[data-arbor-managed-handle="/drag-order/simulacra"] button');
  await expect(sourceHandle).toBeVisible();
  const sourceBox = await sourceHandle.boundingBox();
  const headingBox = await page.locator('[data-node-type="blockOuter"]').filter({ has: heading }).boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(headingBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    headingBox!.x + headingBox!.width / 2,
    headingBox!.y + headingBox!.height * 0.4,
    { steps: 10 },
  );
  const dropCursor = page.locator(".prosemirror-dropcursor-block-horizontal");
  await expect(dropCursor).toBeVisible();
  const dropCursorBox = await dropCursor.boundingBox();
  expect(dropCursorBox).not.toBeNull();
  expect(dropCursorBox!.y + dropCursorBox!.height / 2).toBeGreaterThan(headingBox!.y + headingBox!.height);
  await page.mouse.up();

  await expect.poll(() => operations.filter((operation) => operation.op === "writeMarkdown").length).toBe(1);
  expect(operations.some((operation) => operation.op === "move")).toBe(false);
  const bodySource = async () => page.evaluate(async () => {
    const response = await fetch("/v1/node?path=%2Fdrag-order");
    const node = await response.json();
    return node.document.bodySource as string;
  });
  await expect.poll(async () => {
    const sourceText = await bodySource();
    return sourceText.indexOf("# Oliver") < sourceText.indexOf("[simulacra](simulacra)")
      && sourceText.indexOf("[simulacra](simulacra)") < sourceText.indexOf("[touqeville](touqeville)");
  }).toBe(true);
});

test("browses, searches, and edits toggle Markdown", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => { if (!["GET", "HEAD"].includes(request.method())) writes.push(`${request.method()} ${request.url()}`); });
  await page.goto(r(""));
  await expect(page.getByRole("button", { name: "Arbor", exact: true })).toBeVisible();
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
  await expect(page).toHaveURL(atUrl("/books/one"));
  await expect(page.getByText("An ambiguous utopia.")).toBeVisible();
  await expect(page.getByRole("button", { name: "↑ Parent directory" })).toBeVisible();
  await page.getByRole("button", { name: "· one" }).click();
  await expect(page.getByText("An ambiguous utopia.")).toBeVisible();
  await page.getByRole("button", { name: "↑ Parent directory" }).click();
  await expect(page).toHaveURL(atUrl(""));
  await page.getByRole("button", { name: "· notes" }).click();

  await page.keyboard.press("Meta+p");
  await page.getByPlaceholder("Search, or type a path (/, ~, system:)").fill("Apple orchard");
  await expect(page.getByText("Notes", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.locator(".properties summary").click();
  const topic = page.locator(".properties label").filter({ hasText: "topic" }).locator("input");
  await topic.fill("trees");
  await expect(page.getByRole("status")).toHaveText("Changes pending");
  await expect(page.getByRole("status")).toHaveText("Saved");
});

test("a prose edit persists the provider-completed directory source", async ({ page }) => {
  await page.goto(r("/garden"));
  // The stored body lacks this link, so arbord appends it to operational source.
  const row = page.locator('[data-managed-row="/garden/rose"]');
  await expect(row).toBeVisible();

  await page.getByText("Perennials.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Garden prose.");
  await expect(page.getByRole("status")).toHaveText("Changes pending");
  await expect(page.getByRole("status")).toHaveText("Saved");

  const bodySource = await page.evaluate(async () => {
    const response = await fetch("/v1/node?path=%2Fgarden");
    const node = await response.json();
    return { body: node.document.bodySource as string, bodyState: node.bodyState as string };
  });
  expect(bodySource.bodyState).toBe("stored");
  expect(bodySource.body).toContain("Garden prose.");
  expect(bodySource.body).toContain("](rose)");
  expect(bodySource.body).not.toContain("managed:");
  await expect(row).toBeVisible();
});

test("round-trips inline Markdown and uses Markdown-aware clipboard formats", async ({ page }) => {
  await page.goto(r("/inline-markdown"));

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
    const response = await fetch("/v1/node?path=%2Finline-markdown");
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

test("renders footnotes and LaTeX and preserves the cursor through background saves", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(r("/math-notes"));

  await expect(page.locator(".kind")).toHaveCount(0);
  await expect(page.locator(".inline-math .katex")).toHaveCount(2);
  const criterionMath = page.locator('.inline-math[title="$e_B : \\\\prod_{i \\\\in B} \\\\mathcal{S}_i \\\\to \\\\{0,1\\\\}$ — double-click to edit"]');
  await expect(criterionMath).toHaveCount(1);
  await expect(criterionMath.locator(".katex")).toBeVisible();
  await expect(page.locator("code").filter({ hasText: "literal $x_y$" })).toHaveText("literal $x_y$");
  await expect(page.locator(".math-block .katex-display")).toHaveCount(1);
  await expect(page.locator(".footnote-reference")).toHaveText(["1", "2"]);
  await expect(page.locator(".footnote-definition-number")).toHaveText(["2.", "1."]);
  await expect(page.locator(".body-drop-surface")).toHaveAttribute("data-footnote-layout", "margin");
  await expect(page.locator('.footnote-definition[data-footnote-referenced="true"]')).toHaveCount(2);

  const energyNote = page.locator('.bn-block-outer:has(.footnote-definition[data-footnote-label="energy"])');
  const integralNote = page.locator('.bn-block-outer:has(.footnote-definition[data-footnote-label="integral"])');
  await expect(energyNote).toHaveCSS("position", "absolute");
  await expect(integralNote).toHaveCSS("position", "absolute");
  const energyMarginBox = await energyNote.boundingBox();
  const integralMarginBox = await integralNote.boundingBox();
  expect(energyMarginBox).not.toBeNull();
  expect(integralMarginBox).not.toBeNull();
  expect(integralMarginBox!.y).toBeGreaterThanOrEqual(energyMarginBox!.y + energyMarginBox!.height);

  const energyDefinition = page.locator(".footnote-definition").filter({ hasText: "Einstein's mass-energy relation." });
  await energyDefinition.locator(".footnote-definition-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Updated.");
  await expect(page.getByRole("status")).toHaveText("Saved");

  const cursorParagraph = page.locator('[data-content-type="paragraph"]').filter({ hasText: "Cursor stays here." });
  await cursorParagraph.locator(".bn-inline-content").evaluate((element) => {
    const editor = (window as any).ProseMirror;
    const text = element.firstChild!;
    editor.view.focus();
    editor.commands.setTextSelection(editor.view.posAtDOM(text, "Cursor".length));
  });
  await page.keyboard.type("X");
  await expect(page.getByRole("status")).toHaveText("Saved");

  const selection = await page.evaluate(() => {
    const editor = (window as any).ProseMirror;
    return {
      focused: editor.view.hasFocus(),
      offset: editor.view.state.selection.$from.parentOffset,
      text: editor.view.state.selection.$from.parent.textContent,
    };
  });
  expect(selection).toEqual({ focused: true, offset: 7, text: "CursorX stays here." });

  await page.keyboard.type(" and $a+b$");
  await expect(page.locator(".inline-math .katex")).toHaveCount(3);
  await expect(page.getByRole("status")).toHaveText("Saved");

  const bodySource = await page.evaluate(async () => {
    const response = await fetch("/v1/node?path=%2Fmath-notes");
    const node = await response.json();
    return node.document.bodySource as string;
  });
  expect(bodySource).toContain("Energy is $E = mc^2$.[^energy] The integral below has a compact result.[^integral]");
  expect(bodySource).toContain("The criterion $e_B : \\prod_{i \\in B} \\mathcal{S}_i \\to \\{0,1\\}$ is intact; `literal $x_y$` remains code.");
  expect(bodySource).toContain("CursorX and $a+b$ stays here.");
  expect(bodySource).toContain("$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$");
  expect(bodySource).toContain("[^energy]: Einstein's mass-energy relation. Updated.");

  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.locator(".body-drop-surface")).toHaveAttribute("data-footnote-layout", "endnotes");
  const energyEndnote = page.locator('.bn-block-outer:has(.footnote-definition[data-footnote-label="energy"])');
  const integralEndnote = page.locator('.bn-block-outer:has(.footnote-definition[data-footnote-label="integral"])');
  await expect(energyEndnote).toHaveCSS("position", "absolute");
  await expect(energyEndnote).toHaveCSS("border-top-style", "solid");
  const closingBox = await page.locator('[data-content-type="paragraph"]').filter({ hasText: "Closing paragraph after the source definitions." }).boundingBox();
  const energyEndnoteBox = await energyEndnote.boundingBox();
  const integralEndnoteBox = await integralEndnote.boundingBox();
  expect(closingBox).not.toBeNull();
  expect(energyEndnoteBox).not.toBeNull();
  expect(integralEndnoteBox).not.toBeNull();
  expect(energyEndnoteBox!.y).toBeGreaterThan(closingBox!.y + closingBox!.height);
  expect(integralEndnoteBox!.y).toBeGreaterThan(energyEndnoteBox!.y + energyEndnoteBox!.height);

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('.footnote-definition[data-footnote-label="integral"] .footnote-delete').click();
  await expect(page.locator(".footnote-reference")).toHaveCount(1);
  await expect(page.locator(".footnote-definition")).toHaveCount(1);
  await expect(page.getByRole("status")).toHaveText("Saved");
  const afterDelete = await page.evaluate(async () => {
    const response = await fetch("/v1/node?path=%2Fmath-notes");
    const node = await response.json();
    return node.document.bodySource as string;
  });
  expect(afterDelete).not.toContain("[^integral]");
  expect(afterDelete).toContain("[^energy]: Einstein's mass-energy relation. Updated.");
});

test("renders a Markdown collection and opens a record", async ({ page }) => {
  await page.goto(r(""));
  await page.getByRole("button", { name: /books/ }).click();
  await expect(page.locator(".kind")).toContainText("Collection");
  await expect(page.getByRole("columnheader", { name: "title" })).toBeVisible();
  await expect(page.locator('input[value="The Dispossessed"]')).toBeVisible();
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.getByText("An ambiguous utopia.")).toBeVisible();
});

test("tracks an open page through a page-ID rename without replacing the editor", async ({ page }) => {
  await page.goto(r("/notes"));
  await expect(page.getByText("Research ideas")).toBeVisible();
  await page.locator(".properties summary").click();
  const topic = page.locator(".properties label").filter({ hasText: "topic" }).locator("input");
  await topic.fill("rename-continuity");
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.evaluate(() => { (window as any).__arborEditorBeforeRename = (window as any).ProseMirror; });

  const response = await page.evaluate(async () => {
    const snapshot = await fetch("/v1/node?path=%2Fnotes").then((value) => value.json());
    return fetch("/v1/mutations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mutationID: "e2e-external-rename",
        operations: [{
          op: "rename",
          ref: snapshot.ref.pageID
            ? { pageID: snapshot.ref.pageID, pathHint: "/notes" }
            : { path: "/notes" },
          name: "renamed-notes",
        }],
      }),
    }).then(async (value) => ({ status: value.status, body: await value.json() }));
  });
  expect(response.status).toBe(200);

  await expect(page).toHaveURL(atUrl("/renamed-notes"));
  await expect(page.getByText("Research ideas")).toBeVisible();
  expect(await page.evaluate(() =>
    (window as any).ProseMirror === (window as any).__arborEditorBeforeRename
  )).toBe(true);

  const paragraph = page.locator('[data-content-type="paragraph"]').filter({ hasText: "Apple orchard" }).locator(".bn-inline-content");
  await paragraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" after rename");
  await expect(page.getByRole("status")).toHaveText("Saved");
  const source = await page.evaluate(async () => {
    const snapshot = await fetch("/v1/node?path=%2Frenamed-notes").then((value) => value.json());
    if (!snapshot.ref.pageID) throw new Error("rename did not mint a durable PageID");
    return snapshot.document.bodySource as string;
  });
  expect(source).toContain("Apple orchard notes are searchable. after rename");
});

test("browses ordinary files and shares a subtree beneath the active profile", async ({ page }) => {
  await page.goto(promotable(""));
  await expect(page.getByRole("button", { name: "Share" })).toBeVisible();

  // The parent action escapes the launch root into the untracked filesystem.
  await page.getByRole("button", { name: "↑ Parent directory" }).click();
  const parent = PROMOTABLE_ROOT.slice(0, PROMOTABLE_ROOT.lastIndexOf("/"));
  await expect(page).toHaveURL(new RegExp(`/render${parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(page.getByRole("button", { name: "Share" })).toBeVisible();
  await expect(page.getByRole("button", { name: "▸ arbor-e2e-promotable", exact: true })).toBeVisible();

  // Search begins at a shared-tree boundary; local scope offers promotion.
  await page.keyboard.press("Meta+p");
  await expect(page.getByText("Search begins when this subtree has durable identity.")).toBeVisible();
  await page.keyboard.press("Escape");

  // Sharing uses an additive ACL builder, requires an explicit choice, and keeps the local folder in place.
  await page.goto(promotable(""));
  const sharingControl = page.locator(".header-trailing .share-control");
  const [actionsBox, sharingBox, profileBox] = await Promise.all([
    page.getByLabel("Page actions").boundingBox(),
    sharingControl.boundingBox(),
    page.getByRole("button", { name: "Community and profile" }).boundingBox(),
  ]);
  expect(actionsBox).not.toBeNull();
  expect(sharingBox).not.toBeNull();
  expect(profileBox).not.toBeNull();
  expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(sharingBox!.x);
  expect(sharingBox!.x + sharingBox!.width).toBeLessThanOrEqual(profileBox!.x);
  await sharingControl.click();
  const shareSheet = page.locator(".tree-control-modal");
  await shareSheet.getByLabel("Canonical path").fill("/~owner/garden");
  await expect(shareSheet.locator(".url-preview")).toContainText(`${HOST_ORIGIN}/~owner/garden`);
  await expect(shareSheet.locator(".url-preview")).toContainText(`arbor://127.0.0.1:${E2E_PORT + 1}/~owner/garden`);
  await expect(shareSheet.getByRole("button", { name: "Share", exact: true })).toBeDisabled();
  await shareSheet.getByLabel("Audience 1", { exact: true }).selectOption("everyone");
  await shareSheet.getByRole("button", { name: "Add another audience" }).click();
  await shareSheet.getByLabel("Audience 2", { exact: true }).selectOption("profile");
  await shareSheet.getByLabel("Person or group 2").fill("~editors");
  await shareSheet.getByLabel("Audience 2 permission").selectOption("write");
  let injectedCredentialFailure = false;
  await page.route("**/v1/mutations", async (route) => {
    const request = route.request();
    const operation = request.postDataJSON()?.operations?.[0];
    if (!injectedCredentialFailure && operation?.op === "promoteTree") {
      injectedCredentialFailure = true;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "credential-unavailable",
          message: "The credential for ~owner is unavailable. Run arbor connect to restore it.",
          retryable: false,
          path: "system:credentials",
        }),
      });
      return;
    }
    await route.continue();
  });
  await shareSheet.getByRole("button", { name: "Share", exact: true }).click();
  await expect(shareSheet.getByRole("alert")).toContainText("Run arbor connect");
  await expect(shareSheet).toBeVisible();
  await shareSheet.getByRole("button", { name: "Share", exact: true }).click();
  await expect(sharingControl).toHaveText(/Public read/);

  // The same Share sheet manages canonical addresses, public/profile/link access, and revocation.
  await sharingControl.click();
  await expect(page.getByText("Profile writers")).toBeVisible();
  await expect(page.getByText("~editors")).toBeVisible();
  await expect(page.getByLabel("~editors permission")).toHaveValue("write");
  await expect(page.locator(".canonical-addresses")).toContainText(`${HOST_ORIGIN}/~owner/garden`);
  await expect(page.getByLabel("Everyone permission")).toHaveValue("read");
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Arbor", exact: true }).click();
  const garden = page.locator(".home-root").filter({ hasText: PROMOTABLE_ROOT });
  await expect(garden.locator("strong")).toHaveText("URL Garden");
  await expect(garden.locator(".scope-chip")).toHaveText("public read");

  // The record is browsable read-only through the ordinary system tree.
  await garden.getByRole("button", { name: "record" }).click();
  await expect(page).toHaveURL(/\/render\/system:trees\//);
  await expect(page.locator(".scope-chip")).toHaveText(/System/);

  // Remote browsing replaces local sharing controls with the remote state.
  await page.getByRole("button", { name: "Community and profile" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.goto(`${promotable("")}?browse=${encodeURIComponent(`${HOST_ORIGIN}/~alice`)}&claimable=true`);
  await expect(page.locator(".header-trailing .share-control")).toHaveCount(0);
  await expect(page.locator(".header-trailing .scope-chip")).toHaveText("Remote · Reserved");
  await expect(page.getByRole("heading", { name: "~alice" })).toBeVisible();
  await expect(page.getByText("This is an empty profile reserved by its community.")).toBeVisible();
  await page.getByRole("button", { name: "Claim profile", exact: true }).click();
  const claimSheet = page.locator(".tree-control-modal");
  await expect(claimSheet.getByText("Activate an existing device credential")).toHaveCount(0);
  await expect(claimSheet.getByRole("textbox", { name: "Reserved profile URL" })).toHaveCount(0);
  await claimSheet.getByRole("textbox", { name: "Local profile folder" }).fill(ALICE_PROFILE);
  await claimSheet.getByRole("button", { name: "Claim profile", exact: true }).click();
  await expect(page.getByRole("button", { name: "Community and profile" })).toHaveText("~a");
  await expect(page.getByRole("button", { name: "Community and profile" })).toHaveAttribute("title", "Profile: ~alice");
  const canonicalProfilePath = realpathSync(ALICE_PROFILE);
  await expect(page).toHaveURL(new RegExp(`/render${canonicalProfilePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(page.locator(".remote-browser-frame")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /_index\.md/ })).toHaveCount(0);
  const profileHeading = page.getByRole("heading", { name: "alice", level: 1 });
  await expect(profileHeading).toBeVisible();
  await profileHeading.click();
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("End");
  await page.keyboard.up("Shift");
  await page.keyboard.type("Alice");
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(await page.evaluate(async (path) => {
    const snapshot = await fetch(`/v1/node?tree=local&path=${encodeURIComponent(path)}`).then((value) => value.json());
    return snapshot.document.bodySource as string;
  }, ALICE_PROFILE)).toContain("# Alice");
  await expect(page.locator(".header-trailing .share-control")).toBeEnabled();
});
