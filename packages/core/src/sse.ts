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
