/** Byte-wise comparison of two UTF-8 byte sequences. */
export function compareUTF8Bytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

const encoder = new TextEncoder();

/** Compare two strings by their UTF-8 encoding, the wire's canonical name order. */
export function compareUTF8(left: string, right: string): number {
  return compareUTF8Bytes(encoder.encode(left), encoder.encode(right));
}
