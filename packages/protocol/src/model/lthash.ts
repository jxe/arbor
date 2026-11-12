// LtHash16 (Lewi et al., 2019): a hash of a set of rows that changes with one row at a time
// (collections §1). Each element contributes SHAKE256 of its bytes, 2,048 bytes read as 1,024
// little-endian 16-bit lanes; the state is the lane-wise sum of the contributions modulo 2^16,
// so taking a row out or putting one in costs one contribution, and the order rows are added
// in doesn't matter. A rows hash is the SHA-256 of the state's bytes.

import { shake256 } from "@noble/hashes/sha3.js";
import type { Hash } from "./identifiers.ts";
import { sha256 } from "./hash.ts";

export const LTHASH_BYTES = 2048;
const LANES = LTHASH_BYTES / 2;

type NodeCrypto = { createHash(algorithm: string, options: { outputLength: number }): { update(bytes: Uint8Array): { digest(): Uint8Array } } };
const nodeCrypto = (globalThis as { process?: { getBuiltinModule?: (name: string) => unknown } }).process?.getBuiltinModule?.("node:crypto") as NodeCrypto | undefined;

/** An element's contribution: SHAKE256 of its bytes, 2,048 bytes long. */
function contribution(bytes: Uint8Array): Uint8Array {
  if (nodeCrypto) return nodeCrypto.createHash("shake256", { outputLength: LTHASH_BYTES }).update(bytes).digest();
  return shake256(bytes, { dkLen: LTHASH_BYTES });
}

/** A multiset hash state: 1,024 16-bit lanes. */
export class LtHash {
  readonly lanes: Uint16Array;

  constructor(lanes?: Uint16Array) {
    this.lanes = lanes ? new Uint16Array(lanes) : new Uint16Array(LANES);
  }

  /** The state's 2,048 bytes, little-endian lanes. */
  static fromBytes(bytes: Uint8Array): LtHash {
    if (bytes.length !== LTHASH_BYTES) throw new TypeError(`An LtHash state is ${LTHASH_BYTES} bytes`);
    const lanes = new Uint16Array(LANES);
    for (let i = 0; i < LANES; i++) lanes[i] = bytes[2 * i]! | (bytes[2 * i + 1]! << 8);
    return new LtHash(lanes);
  }

  clone(): LtHash {
    return new LtHash(this.lanes);
  }

  add(element: Uint8Array): this {
    const c = contribution(element);
    for (let i = 0; i < LANES; i++) this.lanes[i] = (this.lanes[i]! + (c[2 * i]! | (c[2 * i + 1]! << 8))) & 0xffff;
    return this;
  }

  remove(element: Uint8Array): this {
    const c = contribution(element);
    for (let i = 0; i < LANES; i++) this.lanes[i] = (this.lanes[i]! - (c[2 * i]! | (c[2 * i + 1]! << 8))) & 0xffff;
    return this;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(LTHASH_BYTES);
    for (let i = 0; i < LANES; i++) {
      out[2 * i] = this.lanes[i]! & 0xff;
      out[2 * i + 1] = this.lanes[i]! >> 8;
    }
    return out;
  }

  /** The rows hash: SHA-256 of the state's bytes. */
  hash(): Hash {
    return `sha256:${sha256(this.bytes())}` as Hash;
  }
}
