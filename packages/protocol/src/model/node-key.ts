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

const UNRESERVED = /[A-Za-z0-9\-._~]/;

function percentEncode(value: string): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(value)) {
    const character = String.fromCharCode(byte);
    encoded += byte < 0x80 && UNRESERVED.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

function percentDecode(value: string): string | null {
  if (/%(?![0-9A-F]{2})/.test(value)) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * The readable key token carried by `;arbor-key=` and `#arbor-key=`: each pair
 * as `name:value` for a string or `name=literal` for a number or boolean,
 * joined by `,`, with every byte outside the URI unreserved set
 * percent-encoded. `[["id","h31mlm"]]` is `id:h31mlm`.
 */
export function encodeStableKey(value: string): string {
  const pairs = parseCanonicalStableKey(value);
  if (!pairs) throw new TypeError("stable key is not canonical identity JSON");
  return pairs.map(([name, scalar]) => typeof scalar === "string"
    ? `${percentEncode(name)}:${percentEncode(scalar)}`
    : `${percentEncode(name)}=${JSON.stringify(scalar)}`).join(",");
}

export function decodeStableKey(token: string): string | null {
  if (!token) return null;
  const pairs: StableKeyPair[] = [];
  for (const part of token.split(",")) {
    const separator = part.search(/[:=]/);
    if (separator < 1) return null;
    const name = percentDecode(part.slice(0, separator));
    const raw = part.slice(separator + 1);
    if (name === null) return null;
    if (part[separator] === ":") {
      const scalar = percentDecode(raw);
      if (scalar === null) return null;
      pairs.push([name, scalar]);
      continue;
    }
    let literal: unknown;
    try {
      literal = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof literal !== "boolean" && !(typeof literal === "number" && Number.isFinite(literal))) return null;
    pairs.push([name, literal]);
  }
  const key = canonicalStableKey(pairs);
  return encodeStableKey(key) === token ? key : null;
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
  return `~row-${rowKeyToken(stableKey)}`;
}

/** `~row-` keeps base64url of the canonical key JSON until Postgres 005 settles the row segment rule. */
function rowKeyToken(stableKey: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(stableKey)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
