import { extname } from "node:path";
import { errorResponse } from "./http.ts";

export interface BrowserFiles {
  fileSurface(path: string, raw: boolean): Promise<{ bytes: Uint8Array; revision: string; path: string } | null>;
  fileSurfaceInScopeOf(referrer: string, path: string, raw: boolean): Promise<{ bytes: Uint8Array; revision: string; path: string } | null>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".woff2": "font/woff2",
};

/**
 * The page served at every app route until Plan B rebuilds Arbor web on the
 * working tree. Static hosting of tree files at OS-shaped routes stays.
 */
const WEB_PLACEHOLDER = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Arbor</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 36rem; line-height: 1.5;">
<h1>Arbor web is being rebuilt (Plan B)</h1>
<p>The daemon's editor path was removed; the web editor returns as a working-tree client. Use the Arbor app or the CLI in the meantime.</p>
</body>
</html>
`;

function fileResponse(
  request: Request,
  surface: { bytes: Uint8Array; revision: string; path: string },
  options: { raw?: boolean; noStore?: boolean } = {},
): Response {
  const etag = `"${surface.revision}"`;
  const baseHeaders: Record<string, string> = {
    "content-type": MIME[extname(surface.path)]
      ?? (options.raw ? "text/markdown; charset=utf-8" : "application/octet-stream"),
    etag,
    "accept-ranges": "bytes",
    ...(options.noStore ? { "cache-control": "no-store" } : {}),
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }
  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const size = surface.bytes.byteLength;
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...baseHeaders, "content-range": `bytes */${size}` } });
    }
    return new Response(request.method === "HEAD" ? null : Buffer.from(surface.bytes.slice(start, end + 1)), {
      status: 206,
      headers: { ...baseHeaders, "content-range": `bytes ${start}-${end}/${size}` },
    });
  }
  return new Response(request.method === "HEAD" ? null : Buffer.from(surface.bytes), { headers: baseHeaders });
}

export function browserHandler(service: BrowserFiles) {
  return async (request: Request, url: URL): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse("unsupported-operation", "Method not allowed", 405);
    }
    // The logical route is the file API: an ordinary file's OS-shaped
    // path serves its bytes (with ?raw overriding to a document's stored
    // body), dispatched into the owning root; the /render spelling is
    // accepted so authored relative references keep resolving under the
    // app's route prefix.
    const logicalPath = url.pathname.replace(/^\/render(?=\/|$)/, "") || "/";
    const raw = url.searchParams.has("raw");
    let surface = await service.fileSurface(decodeURIComponent(logicalPath), raw).catch(() => null);
    if (!surface) {
      // Tree-rooted authored spellings (assets) resolve against the
      // origin in the DOM; the referring document's scope supplies the
      // enclosing tree.
      const referer = request.headers.get("referer");
      const refererPath = referer ? new URL(referer).pathname.replace(/^\/render(?=\/|$)/, "") : null;
      if (refererPath?.startsWith("/")) {
        surface = await service.fileSurfaceInScopeOf(
          decodeURIComponent(refererPath),
          decodeURIComponent(logicalPath),
          raw,
        );
      }
    }
    if (surface) {
      return fileResponse(request, surface, { raw });
    }
    return new Response(WEB_PLACEHOLDER, { headers: { "content-type": MIME[".html"] ?? "text/html" } });
  };
}
