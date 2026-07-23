import { expect, test } from "@playwright/test";

test("canonicalizes Markdown storage aliases", async ({ page }) => {
  await page.goto("/render/notes.md");
  await expect(page).toHaveURL(/\/render\/notes$/);
  await expect(page.getByRole("button", { name: "· notes" })).toBeVisible();
  await expect(page.getByText("Research ideas")).toBeVisible();
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

  const topic = page.locator(".properties label").filter({ hasText: "topic" }).locator("input");
  await topic.fill("trees");
  await expect(page.getByRole("status")).toHaveText("Changes pending");
  await expect(page.getByRole("status")).toHaveText("Saved");
});

test("renders a Markdown collection and opens a record", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /books/ }).click();
  await expect(page.getByRole("columnheader", { name: "title" })).toBeVisible();
  await expect(page.locator('input[value="The Dispossessed"]')).toBeVisible();
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.getByText("An ambiguous utopia.")).toBeVisible();
});
