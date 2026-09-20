export interface SSEFrame {
  event: string;
  data: unknown;
  id?: string;
}

function singleLine(name: string, value: string): string {
  if (!value || value.includes("\n") || value.includes("\r")) throw new TypeError(`SSE ${name} must be one non-empty line`);
  return value;
}

/** Shared framing only; replay and cursor semantics remain endpoint-specific. */
export function encodeSSEFrame(frame: SSEFrame): string {
  const data = JSON.stringify(frame.data);
  if (data === undefined) throw new TypeError("SSE data must be JSON-serializable");
  return `${frame.id === undefined ? "" : `id: ${singleLine("id", frame.id)}\n`}event: ${singleLine("event", frame.event)}\ndata: ${data}\n\n`;
}

export interface ParsedSSEFrame {
  id?: string;
  event?: string;
  data: string;
}

/** Parse one frame's lines. Comment-only and keepalive frames return null. */
export function parseSSEFrame(raw: string): ParsedSSEFrame | null {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (id === undefined && event === undefined && !data.length) return null;
  return { ...(id === undefined ? {} : { id }), ...(event === undefined ? {} : { event }), data: data.join("\n") };
}

/**
 * Split a UTF-8 event stream into frames. Shared framing only: LF, CRLF, and
 * CR line endings, multi-line `data`, ignored comments. Cursor and replay
 * semantics stay with each endpoint. Cancelling the consumer cancels the
 * underlying stream.
 */
export async function* parseSSEStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<ParsedSSEFrame> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = stream.getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let text = buffer.replaceAll("\r\n", "\n");
      let held = "";
      if (!done && text.endsWith("\r")) {
        held = "\r";
        text = text.slice(0, -1);
      }
      text = text.replaceAll("\r", "\n");
      let boundary = text.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = parseSSEFrame(text.slice(0, boundary));
        text = text.slice(boundary + 2);
        if (frame) yield frame;
        boundary = text.indexOf("\n\n");
      }
      buffer = text + held;
      if (done) return;
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
}
