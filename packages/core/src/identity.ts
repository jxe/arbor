const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Generate a 128-bit lowercase base32 Arbor identity with the supplied stable prefix. */
export function generateArborID(prefix: "tr" | "dv" | "ac" | "pa" | "ax" | "up" | "ob"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) result += BASE32[(value << (5 - bits)) & 31];
  return `${prefix}_${result}`;
}

export function isGeneratedArborID(value: string, prefix: "tr" | "dv"): boolean {
  return new RegExp(`^${prefix}_[a-z2-7]{26}$`).test(value);
}
