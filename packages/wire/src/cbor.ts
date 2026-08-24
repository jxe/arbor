const encoder = new TextEncoder();

function head(major: number, value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid CBOR length: ${value}`);
  if (value < 24) return [(major << 5) | value];
  if (value <= 0xff) return [(major << 5) | 24, value];
  if (value <= 0xffff) return [(major << 5) | 25, value >> 8, value & 0xff];
  if (value <= 0xffffffff) {
    return [(major << 5) | 26, value >>> 24, value >>> 16, value >>> 8, value].map((part) => part & 0xff);
  }
  const high = Math.floor(value / 0x1_0000_0000);
  const low = value >>> 0;
  return [
    (major << 5) | 27,
    high >>> 24,
    high >>> 16,
    high >>> 8,
    high,
    low >>> 24,
    low >>> 16,
    low >>> 8,
    low,
  ].map((part) => part & 0xff);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  if (left.length !== right.length) return left.length - right.length;
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference) return difference;
  }
  return 0;
}

function parts(value: unknown): Uint8Array[] {
  if (value === null) return [Uint8Array.of(0xf6)];
  if (value === false) return [Uint8Array.of(0xf4)];
  if (value === true) return [Uint8Array.of(0xf5)];
  if (value instanceof Uint8Array) return [Uint8Array.from(head(2, value.length)), value];
  if (typeof value === "string") {
    const bytes = encoder.encode(value);
    return [Uint8Array.from(head(3, bytes.length)), bytes];
  }
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      return [Uint8Array.from(value >= 0 ? head(0, value) : head(1, -1 - value))];
    }
    const bytes = new Uint8Array(9);
    bytes[0] = 0xfb;
    new DataView(bytes.buffer).setFloat64(1, value);
    return [bytes];
  }
  if (Array.isArray(value)) {
    return [Uint8Array.from(head(4, value.length)), ...value.flatMap(parts)];
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => ({ key: encodeCanonicalCBOR(key), value: item }))
      .sort((left, right) => compareBytes(left.key, right.key));
    return [
      Uint8Array.from(head(5, entries.length)),
      ...entries.flatMap((entry) => [entry.key, ...parts(entry.value)]),
    ];
  }
  throw new Error(`Unsupported CBOR value: ${typeof value}`);
}

export function encodeCanonicalCBOR(value: unknown): Uint8Array {
  const encoded = parts(value);
  const length = encoded.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of encoded) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function readLength(bytes: Uint8Array, offset: number, additional: number): { value: number; offset: number } {
  if (additional < 24) return { value: additional, offset };
  const size = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
  if (!size || offset + size > bytes.length) throw new Error("Invalid CBOR length");
  let value = 0;
  for (let index = 0; index < size; index += 1) value = value * 256 + bytes[offset + index]!;
  if (!Number.isSafeInteger(value)) throw new Error("CBOR integer exceeds JavaScript safe range");
  if (
    (size === 1 && value < 24)
    || (size === 2 && value <= 0xff)
    || (size === 4 && value <= 0xffff)
    || (size === 8 && value <= 0xffffffff)
  ) throw new Error("Non-minimal CBOR length");
  return { value, offset: offset + size };
}

function decodeAt(bytes: Uint8Array, start: number, depth = 0): { value: unknown; offset: number } {
  if (depth > 64) throw new Error("CBOR nesting too deep");
  if (start >= bytes.length) throw new Error("Unexpected end of CBOR");
  const first = bytes[start]!;
  const major = first >> 5;
  const additional = first & 31;
  if (first === 0xf4) return { value: false, offset: start + 1 };
  if (first === 0xf5) return { value: true, offset: start + 1 };
  if (first === 0xf6) return { value: null, offset: start + 1 };
  if (first === 0xfb) {
    if (start + 9 > bytes.length) throw new Error("Invalid CBOR float");
    return { value: new DataView(bytes.buffer, bytes.byteOffset).getFloat64(start + 1), offset: start + 9 };
  }
  const length = readLength(bytes, start + 1, additional);
  if (major === 0) return length;
  if (major === 1) return { value: -1 - length.value, offset: length.offset };
  if (major === 2 || major === 3) {
    const end = length.offset + length.value;
    if (end > bytes.length) throw new Error("Invalid CBOR byte/string length");
    const slice = bytes.slice(length.offset, end);
    if (major === 2) return { value: slice, offset: end };
    try {
      return { value: new TextDecoder("utf-8", { fatal: true }).decode(slice), offset: end };
    } catch {
      throw new Error("Invalid CBOR UTF-8 string");
    }
  }
  if (major === 4) {
    const result: unknown[] = [];
    let offset = length.offset;
    for (let index = 0; index < length.value; index += 1) {
      const item = decodeAt(bytes, offset, depth + 1);
      result.push(item.value);
      offset = item.offset;
    }
    return { value: result, offset };
  }
  if (major === 5) {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let offset = length.offset;
    let previousKey: Uint8Array | undefined;
    for (let index = 0; index < length.value; index += 1) {
      const keyStart = offset;
      const key = decodeAt(bytes, offset, depth + 1);
      const encodedKey = bytes.slice(keyStart, key.offset);
      const item = decodeAt(bytes, key.offset, depth + 1);
      if (typeof key.value !== "string") throw new Error("Arbor CBOR map keys must be strings");
      if (key.value in result) throw new Error("Duplicate CBOR map key");
      if (previousKey && compareBytes(previousKey, encodedKey) >= 0) throw new Error("Non-canonical CBOR map key order");
      result[key.value] = item.value;
      previousKey = encodedKey;
      offset = item.offset;
    }
    return { value: result, offset };
  }
  throw new Error(`Unsupported CBOR major type ${major}`);
}

export function decodeCBOR(bytes: Uint8Array): unknown {
  const decoded = decodeAt(bytes, 0);
  if (decoded.offset !== bytes.length) throw new Error("Trailing CBOR bytes");
  return decoded.value;
}
