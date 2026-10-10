import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { clientAddress, hardenResponse, htmlContentSecurityPolicy, inlineScriptSource, storedFileHeaders } from "../../../packages/overstoryd/src/response-policy.ts";

describe("response hardening", () => {
  test("every response gets the shared headers and keeps its own cache contract", () => {
    const response = hardenResponse(Response.json({ ok: true }, { headers: { "cache-control": "no-store" } }));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("content-security-policy")).toBe(false);
  });

  test("an HTML response with no policy of its own gets the script-less page policy", () => {
    const response = hardenResponse(new Response("<p>hi</p>", { headers: { "content-type": "text/html; charset=utf-8" } }));
    expect(response.headers.get("content-security-policy")).toBe(htmlContentSecurityPolicy());
    const sandboxed = hardenResponse(new Response("<p>hi</p>", { headers: { "content-type": "text/html", "content-security-policy": "sandbox" } }));
    expect(sandboxed.headers.get("content-security-policy")).toBe("sandbox");
  });

  test("the page policy allows inline style and linked images, and a script only by its hash", () => {
    const plain = htmlContentSecurityPolicy();
    expect(plain).toContain("default-src 'none'");
    expect(plain).toContain("style-src 'unsafe-inline'");
    expect(plain).toContain("frame-ancestors 'none'");
    expect(plain).not.toContain("script-src");
    expect(plain).not.toContain("connect-src");

    const source = "\nconsole.log(1);\n";
    const hash = `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
    expect(inlineScriptSource(source)).toBe(hash);
    const scripted = htmlContentSecurityPolicy({ source });
    expect(scripted).toContain(`script-src ${hash}`);
    expect(scripted.match(/script-src[^;]*/)![0]).not.toContain("unsafe-inline");
    expect(scripted).not.toContain("connect-src");
    expect(htmlContentSecurityPolicy({ source, connects: true })).toContain("connect-src 'self'");
  });
});

describe("stored file types", () => {
  test("inert images and text are shown under their own type", () => {
    expect(storedFileHeaders("logo.png")["content-type"]).toBe("image/png");
    expect(storedFileHeaders("Photo.JPG")["content-type"]).toBe("image/jpeg");
    expect(storedFileHeaders("notes.txt")["content-type"]).toBe("text/plain; charset=utf-8");
    expect(storedFileHeaders("logo.png")["content-disposition"]).toBeUndefined();
    expect(storedFileHeaders("logo.png")["x-content-type-options"]).toBe("nosniff");
  });

  test("active and unknown types download as opaque bytes", () => {
    for (const name of ["page.html", "page.htm", "drawing.svg", "script.js", "style.css", "doc.xhtml", "archive.zip", "paper.pdf", "noextension", ".png", "weird.html.unknown"]) {
      expect(storedFileHeaders(name), name).toEqual({
        "content-type": "application/octet-stream",
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      });
    }
  });
});

describe("the rate-limit caller address", () => {
  test("with no trusted proxy the forwarding header is ignored", () => {
    expect(clientAddress("203.0.113.9", "10.0.0.1", 0)).toBe("10.0.0.1");
    expect(clientAddress(null, "10.0.0.1", 0)).toBe("10.0.0.1");
    expect(clientAddress("203.0.113.9", undefined, 0)).toBe("unknown");
  });

  test("N trusted proxies select the Nth address from the right", () => {
    // The caller wrote the leftmost entries; each trusted proxy appended one.
    expect(clientAddress("198.51.100.7, 203.0.113.9", "10.0.0.1", 1)).toBe("203.0.113.9");
    expect(clientAddress("198.51.100.7, 203.0.113.9, 10.0.0.2", "10.0.0.1", 2)).toBe("203.0.113.9");
    expect(clientAddress("203.0.113.9", "10.0.0.1", 1)).toBe("203.0.113.9");
    expect(clientAddress("not-an-address, 2001:db8::1", "10.0.0.1", 1)).toBe("2001:db8::1");
  });

  test("a chain that is short or malformed where it is trusted falls back to the peer", () => {
    expect(clientAddress(null, "10.0.0.1", 1)).toBe("10.0.0.1");
    expect(clientAddress("203.0.113.9", "10.0.0.1", 2)).toBe("10.0.0.1");
    expect(clientAddress("203.0.113.9, garbage", "10.0.0.1", 1)).toBe("10.0.0.1");
    expect(clientAddress("garbage, 10.0.0.2", "10.0.0.1", 2)).toBe("10.0.0.1");
    expect(clientAddress("", undefined, 1)).toBe("unknown");
  });
});
