import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeProtocolDirectory, encodeProtocolDirectory, hashObject, type ProtocolClient } from "@ovst/protocol";
import { serveHost } from "@ovst/overstoryd";
import { deviceClient, testAccount } from "../../helpers/devices.ts";

// Security 003: one header policy on every response, conservative types for
// stored files, and a rate-limit key a caller cannot choose.

const token = "host-responses-owner";
const HTML_BYTES = new TextEncoder().encode("<!doctype html><script>alert(document.domain)</script>");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let sandbox: string;
let running: Awaited<ReturnType<typeof serveHost>>;
let client: ProtocolClient;
let community: string;

function expectHardened(response: Response, label: string) {
  expect(response.headers.get("x-content-type-options"), label).toBe("nosniff");
  expect(response.headers.get("x-frame-options"), label).toBe("DENY");
  expect(response.headers.get("referrer-policy"), label).toBe("no-referrer");
}

/** The `script-src` hash source for the one inline script in `page`. */
function scriptHashOf(page: string): string {
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  return `'sha256-${createHash("sha256").update(scripts[0]![1]!).digest("base64")}'`;
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "overstoryd-responses-"));
  running = await serveHost({
    dataRoot: join(sandbox, "data"),
    accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  client = await deviceClient(running.url, token);
  const account = await client.account();
  community = account.account.community.id;
  const head = await client.descriptor(community);
  const snapshot = await client.snapshot(community, head.tree.root);
  const root = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
  const files: Record<string, Uint8Array> = {
    "logo.png": PNG,
    "page.html": HTML_BYTES,
    "page.unknown": HTML_BYTES,
    "drawing.svg": new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    "notes.txt": new TextEncoder().encode("plain notes\n"),
    "guide.md": new TextEncoder().encode("# Guide\n\nSome *text* and ![a logo](logo.png).\n"),
  };
  const objects = new Map(snapshot.objects);
  for (const bytes of Object.values(files)) objects.set(hashObject(bytes), bytes);
  const directory = encodeProtocolDirectory({
    ...root,
    entries: [...root.entries, ...Object.entries(files).map(([name, bytes]) => ({ name, file: hashObject(bytes) }))]
      .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))),
  });
  objects.set(hashObject(directory), directory);
  await client.submitUpdate(community, head.tree.update, { root: hashObject(directory), objects });
});

afterAll(async () => {
  running.server.stop(true);
  await running.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("the shared header policy", () => {
  test("covers JSON, HTML, Markdown, event streams, immutable objects, stored files and errors", async () => {
    const json = await fetch(`${running.url}/.overstory/health`);
    expect(json.status).toBe(200);
    expectHardened(json, "json");
    expect(json.headers.get("cache-control")).toBe("no-store");

    const page = await fetch(`${running.url}/guide`, { headers: { accept: "text/html" } });
    expect(page.status).toBe(200);
    expectHardened(page, "html");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const markdown = await fetch(`${running.url}/guide`, { headers: { accept: "text/markdown" } });
    expect(markdown.status).toBe(200);
    expectHardened(markdown, "markdown");
    expect(markdown.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(markdown.headers.get("cache-control")).toBe("no-cache");
    expect(markdown.headers.has("content-security-policy")).toBe(false);

    const abort = new AbortController();
    const stream = await fetch(`${running.url}/.overstory/trees/${community}/watch`, { signal: abort.signal });
    expect(stream.status).toBe(200);
    expectHardened(stream, "sse");
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.headers.get("cache-control")).toBe("no-cache");
    abort.abort();

    const head = await client.descriptor(community);
    const object = await fetch(`${running.url}/.overstory/trees/${community}/objects/${head.tree.root}`);
    expect(object.status).toBe(200);
    expectHardened(object, "object");
    expect(object.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const bundle = await fetch(`${running.url}/.overstory/trees/${community}/snapshots/${head.tree.root}`);
    expect(bundle.status).toBe(200);
    expectHardened(bundle, "snapshot");
    expect(bundle.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const file = await fetch(`${running.url}/logo.png`);
    expect(file.status).toBe(200);
    expectHardened(file, "file");

    const missing = await fetch(`${running.url}/nothing-here`);
    expect(missing.status).toBe(404);
    expectHardened(missing, "404 json");
    const missingPage = await fetch(`${running.url}/nothing-here`, { headers: { accept: "text/html" } });
    expect(missingPage.status).toBe(404);
    expectHardened(missingPage, "404 html");
    expect(missingPage.headers.get("content-security-policy")).toContain("default-src 'none'");
    const missingRoute = await fetch(`${running.url}/.overstory/nope`);
    expect(missingRoute.status).toBe(404);
    expectHardened(missingRoute, "404 route");

    const unauthenticated = await fetch(`${running.url}/.overstory/account`);
    expect(unauthenticated.status).toBe(401);
    expectHardened(unauthenticated, "401");
    const badToken = await fetch(`${running.url}/.overstory/account`, { headers: { authorization: "Bearer ars_nothing" } });
    expect(badToken.status).toBe(401);
    expectHardened(badToken, "401 token");
    const badExecution = await fetch(`${running.url}/.overstory/account`, { headers: { authorization: "Bearer execution_nothing" } });
    expect(badExecution.status).toBe(401);
    expectHardened(badExecution, "401 execution");
  });
});

describe("ordinary stored files", () => {
  test("an inert image or text file is shown under its own type", async () => {
    const image = await fetch(`${running.url}/logo.png`);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.has("content-disposition")).toBe(false);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
    const text = await fetch(`${running.url}/notes.txt`);
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await text.text()).toBe("plain notes\n");
  });

  test("HTML-shaped bytes download as opaque bytes whatever their extension", async () => {
    for (const name of ["page.html", "page.unknown", "drawing.svg"]) {
      const response = await fetch(`${running.url}/${name}`, { headers: { accept: "text/html" } });
      expect(response.status, name).toBe(200);
      expect(response.headers.get("content-type"), name).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition"), name).toBe("attachment");
      expect(response.headers.get("x-content-type-options"), name).toBe("nosniff");
      expect(response.headers.get("content-security-policy"), name).toBe("sandbox");
    }
    const bytes = await (await fetch(`${running.url}/page.unknown`)).arrayBuffer();
    expect(new Uint8Array(bytes)).toEqual(HTML_BYTES);
  });
});

describe("pages under the content security policy", () => {
  test("a public Markdown page carries inline style and no script, and its policy allows exactly that", async () => {
    const response = await fetch(`${running.url}/guide`, { headers: { accept: "text/html" } });
    const policy = response.headers.get("content-security-policy")!;
    const page = await response.text();
    expect(page).toContain("<style>");
    expect(page).toContain('<img class="inline-image" src="/logo.png"');
    expect(page).not.toContain("<script");
    expect(policy).toContain("style-src 'unsafe-inline'");
    expect(policy).toContain("img-src 'self'");
    expect(policy).not.toContain("script-src");
    expect(policy).toContain("default-src 'none'");
  });

  test("the access-link page's one script is permitted by its hash, with same-origin fetch", async () => {
    // An unreadable configuration answers a browser with the access-link page.
    const response = await fetch(`${running.url}/;overstory-config`, { headers: { accept: "text/html" } });
    expect(response.status).toBe(200);
    const policy = response.headers.get("content-security-policy")!;
    const page = await response.text();
    expect(page).toContain('"Overstory-Access-Link": secret');
    expect(policy).toContain(`script-src ${scriptHashOf(page)}`);
    expect(policy).toContain("connect-src 'self'");
    // The page it writes over itself has inline style, which the same policy allows.
    expect(policy).toContain("style-src 'unsafe-inline'");
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});

describe("the rate-limit key", () => {
  const claim = (url: string, pairing: string, forwardedFor?: string) => fetch(`${url}/.overstory/pairings/${pairing}/claim`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}) },
    body: "{}",
  });
  async function limitedHost(trustedProxyHops?: number) {
    const dataRoot = await mkdtemp(join(sandbox, "limited-"));
    return serveHost({
      dataRoot,
      accounts: [testAccount("owner", `${token}-${trustedProxyHops ?? "none"}`, { communityWriter: true })],
      publicOrigin: "http://127.0.0.1:0",
      hostname: "127.0.0.1",
      port: 0,
      rateLimits: true,
      ...(trustedProxyHops === undefined ? {} : { trustedProxyHops }),
    });
  }
  async function stop(host: Awaited<ReturnType<typeof serveHost>>) {
    host.server.stop(true);
    await host.overstoryd[Symbol.asyncDispose]();
  }

  test("limits are off unless asked for", async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) expect((await claim(running.url, "pr_off")).status).not.toBe(429);
  });

  test("with no trusted proxy a forged X-Forwarded-For does not move a caller to a new bucket", async () => {
    const host = await limitedHost();
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect((await claim(host.url, "pr_direct", `203.0.113.${attempt}`)).status).not.toBe(429);
      }
      const refused = await claim(host.url, "pr_direct", "203.0.113.200");
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ error: "rate-limited", retryable: true });
      expectHardened(refused, "429");
    } finally { await stop(host); }
  });

  test("one trusted proxy counts the address it appended, not what the caller wrote before it", async () => {
    const host = await limitedHost(1);
    try {
      // The caller varies the leftmost entry; the proxy's own entry stays the same.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect((await claim(host.url, "pr_proxied", `198.51.100.${attempt}, 203.0.113.9`)).status).not.toBe(429);
      }
      expect((await claim(host.url, "pr_proxied", "198.51.100.99, 203.0.113.9")).status).toBe(429);
      // A different caller behind the same proxy has its own bucket.
      expect((await claim(host.url, "pr_proxied", "198.51.100.99, 203.0.113.10")).status).not.toBe(429);
    } finally { await stop(host); }
  });

  test("a negative or fractional hop count is refused at start", async () => {
    await expect(limitedHost(-1)).rejects.toThrow("trustedProxyHops");
    await expect(limitedHost(1.5)).rejects.toThrow("trustedProxyHops");
  });
});
