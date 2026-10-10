import { createHash } from "node:crypto";
import { isIP } from "node:net";

/** The CSP source that permits exactly this inline script: the hash of the text between its tags. */
export function inlineScriptSource(script: string): string {
  return `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`;
}

/** An inline script a page carries, constant text so its hash can be named in the page's policy. */
export interface PageScript {
  /** Exactly the text between `<script>` and `</script>`. */
  source: string;
  /** Whether the script fetches from this origin. */
  connects?: boolean;
}

/**
 * The policy of every HTML page the host renders. Pages carry one inline
 * `<style>` and images an author linked; nothing else loads. A page with a
 * script names that one script by hash, never `unsafe-inline`.
 */
export function htmlContentSecurityPolicy(script?: PageScript): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data: https: http:",
    ...(script ? [`script-src ${inlineScriptSource(script.source)}`] : []),
    ...(script?.connects ? ["connect-src 'self'"] : []),
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * The headers every response from the host carries, whatever built it: JSON,
 * HTML, an event stream, an immutable object, Markdown, a stored file or an
 * error. An HTML response that set no policy of its own gets the script-less
 * page policy. Cache headers are each route's own and are left alone.
 */
export function hardenResponse(response: Response): Response {
  const headers = response.headers;
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  if (!headers.has("content-security-policy") && /^text\/html\b/i.test(headers.get("content-type") ?? "")) {
    headers.set("content-security-policy", htmlContentSecurityPolicy());
  }
  return response;
}

/**
 * The stored-file types a browser may show in place: inert images and text.
 * Reviewed by hand; overstoryd does not share Story Sync's table, which serves
 * a person's own files to their own machine.
 */
const INERT_FILE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
};

/**
 * Type and disposition for an ordinary stored file, by its name. Anything
 * outside the inert list, HTML and SVG included, downloads as opaque bytes, so
 * stored content never runs or renders with this origin's authority. The
 * sandbox is a second barrier for a browser that shows a file anyway.
 */
export function storedFileHeaders(name: string): Record<string, string> {
  const dot = name.lastIndexOf(".");
  const type = dot > 0 ? INERT_FILE_TYPES[name.slice(dot).toLowerCase()] : undefined;
  return {
    "content-type": type ?? "application/octet-stream",
    ...(type ? {} : { "content-disposition": "attachment" }),
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
  };
}

/**
 * The address a rate limit counts a caller by. It is the connection's peer
 * unless the operator declared `trustedProxyHops` reverse proxies in front of
 * the listener, each appending the address it received from to
 * `X-Forwarded-For`. Then it is the entry that many places from the right:
 * the one the outermost trusted proxy wrote. Entries left of it came from the
 * caller and are never read. A chain shorter than the declared hops, or whose
 * trusted entries are not addresses, is not believed, and the peer is used.
 * The address is a rate-limit key, never an identity.
 */
export function clientAddress(forwardedFor: string | null, peer: string | undefined, trustedProxyHops: number): string {
  if (trustedProxyHops > 0 && forwardedFor !== null) {
    const chain = forwardedFor.split(",").map((entry) => entry.trim());
    const trusted = chain.slice(-trustedProxyHops);
    if (trusted.length === trustedProxyHops && trusted.every((entry) => isIP(entry) !== 0)) return trusted[0]!;
  }
  return peer ?? "unknown";
}
