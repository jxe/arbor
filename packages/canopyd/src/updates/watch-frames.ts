import type { AcceptedTransition } from "@overstory/protocol";

/** Try a bounded batch once, splitting only oversized frames. This avoids
 * serializing every growing prefix (and its object payloads) during replay. */
export function encodeWatchFrames(
  transitions: AcceptedTransition[],
  encode: (batch: AcceptedTransition[]) => string,
  maxTransitions = 64,
  maxBytes = 1024 * 1024,
): string[] | null {
  const frames: string[] = [];
  const append = (batch: AcceptedTransition[]): boolean => {
    const frame = encode(batch);
    if (Buffer.byteLength(frame) <= maxBytes) { frames.push(frame); return true; }
    if (batch.length === 1) return false;
    const middle = Math.ceil(batch.length / 2);
    return append(batch.slice(0, middle)) && append(batch.slice(middle));
  };
  for (let index = 0; index < transitions.length; index += maxTransitions) {
    if (!append(transitions.slice(index, index + maxTransitions))) return null;
  }
  return frames;
}
