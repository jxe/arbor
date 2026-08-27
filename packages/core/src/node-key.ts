export type StableKeyScalar = string | boolean | number;
export type StableKeyPair = readonly [property: string, value: StableKeyScalar];

function assertStableKeyPair(value: readonly unknown[]): asserts value is StableKeyPair {
  if (value.length !== 2 || typeof value[0] !== "string" || !value[0]) {
    throw new TypeError("stable-key entries must be [property, value] pairs");
  }
  const scalar = value[1];
  if (
    typeof scalar !== "string"
    && typeof scalar !== "boolean"
    && !(typeof scalar === "number" && Number.isFinite(scalar))
  ) {
    throw new TypeError("stable-key values must be non-null canonical scalars");
  }
}

/** RFC 8785 JSON for an identity rule's ordered property/value pairs. */
export function canonicalStableKey(pairs: readonly (readonly unknown[])[]): string {
  for (const pair of pairs) assertStableKeyPair(pair);
  return JSON.stringify(pairs);
}

export function parseCanonicalStableKey(value: string): StableKeyPair[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.length) return null;
  try {
    for (const pair of parsed) {
      if (!Array.isArray(pair)) return null;
      assertStableKeyPair(pair);
    }
  } catch {
    return null;
  }
  // The permitted shape contains only arrays and scalars, for which
  // JSON.stringify is the RFC 8785 representation (including finite numbers).
  return JSON.stringify(parsed) === value ? parsed as StableKeyPair[] : null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function encodeStableKey(value: string): string {
  if (!parseCanonicalStableKey(value)) throw new TypeError("stable key is not canonical identity JSON");
  return bytesToBase64(new TextEncoder().encode(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeStableKey(value: string): string | null {
  const bytes = base64ToBytes(value);
  if (!bytes) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (!parseCanonicalStableKey(decoded) || encodeStableKey(decoded) !== value) return null;
  return decoded;
}

/** Compatibility bridge for Markdown `id` while PageID storage is migrated. */
export function pageIDStableKey(pageID: string): string {
  return canonicalStableKey([["id", pageID]]);
}

export function pageIDFromStableKey(stableKey: string | null): string | null {
  const pairs = stableKey ? parseCanonicalStableKey(stableKey) : null;
  return pairs?.length === 1 && pairs[0]?.[0] === "id" && typeof pairs[0][1] === "string"
    ? pairs[0][1]
    : null;
}

/** Derive one canonical key from declared properties without coercing values. */
export function stableKeyFromProperties(
  properties: readonly string[],
  values: Readonly<Record<string, unknown>>,
): string | null {
  if (!properties.length || new Set(properties).size !== properties.length) return null;
  const pairs: StableKeyPair[] = [];
  for (const property of properties) {
    if (!property) return null;
    const value = values[property];
    if (
      typeof value !== "string"
      && typeof value !== "boolean"
      && !(typeof value === "number" && Number.isFinite(value))
    ) return null;
    pairs.push([property, value]);
  }
  return canonicalStableKey(pairs);
}

function readableRowSegment(value: string): boolean {
  return Boolean(value)
    && value !== "."
    && value !== ".."
    && !value.startsWith("~row-")
    && !value.endsWith(".md")
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0");
}

/** Deterministic logical child segment for a schema-derived row key. */
export function rowPathSegment(stableKey: string): string {
  const pairs = parseCanonicalStableKey(stableKey);
  if (!pairs) throw new TypeError("row path requires a canonical stable key");
  const onlyValue = pairs.length === 1 ? pairs[0]![1] : null;
  if (typeof onlyValue === "string" && readableRowSegment(onlyValue)) return onlyValue;
  return `~row-${encodeStableKey(stableKey)}`;
}
