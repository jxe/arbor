import type { ObjectDeltaInstruction } from "./types.ts";

const MIN_BLOCK = 32;
const MAX_INDEXED_BLOCKS = 16_384;
const HASH_MULTIPLIER = 0x01000193;

function blockSizeFor(length: number): number {
  let size = MIN_BLOCK;
  while (length / size > MAX_INDEXED_BLOCKS) size *= 2;
  return size;
}

function hashBlock(bytes: Uint8Array, offset: number, length: number): number {
  let hash = 0;
  for (let index = offset; index < offset + length; index += 1) {
    hash = (Math.imul(hash, HASH_MULTIPLIER) + bytes[index]!) >>> 0;
  }
  return hash;
}

function rollHash(hash: number, outgoing: number, incoming: number, power: number): number {
  return (Math.imul((hash - Math.imul(outgoing, power)) >>> 0, HASH_MULTIPLIER) + incoming) >>> 0;
}

function blockPower(length: number): number {
  let power = 1;
  for (let index = 1; index < length; index += 1) power = Math.imul(power, HASH_MULTIPLIER) >>> 0;
  return power;
}

function blocksEqual(base: Uint8Array, baseOffset: number, target: Uint8Array, targetOffset: number, length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (base[baseOffset + index] !== target[targetOffset + index]) return false;
  }
  return true;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

class DeltaBuilder {
  readonly instructions: ObjectDeltaInstruction[] = [];

  copy(offset: number, length: number): void {
    if (length <= 0) return;
    const last = this.instructions.at(-1);
    if (last && "copy" in last && last.copy.offset + last.copy.length === offset) {
      last.copy.length += length;
      return;
    }
    this.instructions.push({ copy: { offset, length } });
  }

  insert(bytes: Uint8Array): void {
    if (!bytes.byteLength) return;
    const last = this.instructions.at(-1);
    if (last && "insert" in last) {
      last.insert = concat(last.insert, bytes);
      return;
    }
    this.instructions.push({ insert: bytes.slice() });
  }
}

/**
 * Derive copy/insert instructions that rebuild `target` from `base`. Common
 * prefix and suffix are copied exactly; the middle is matched by rolling-hash
 * blocks so an edit far from the start, a moved region, or a changed CBOR
 * length header still yields a few instructions. Any instruction sequence
 * that reconstructs the exact target is a valid delta, so this algorithm is a
 * sender-side choice and may change without affecting identity.
 */
export function objectDelta(base: Uint8Array, target: Uint8Array): ObjectDeltaInstruction[] {
  const builder = new DeltaBuilder();
  let prefix = 0;
  while (prefix < base.byteLength && prefix < target.byteLength && base[prefix] === target[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < base.byteLength - prefix
    && suffix < target.byteLength - prefix
    && base[base.byteLength - suffix - 1] === target[target.byteLength - suffix - 1]
  ) suffix += 1;

  builder.copy(0, prefix);
  matchMiddle(builder, base, prefix, base.byteLength - suffix, target, prefix, target.byteLength - suffix);
  builder.copy(base.byteLength - suffix, suffix);
  if (!builder.instructions.length) throw new Error("Object delta has no instructions");
  return builder.instructions;
}

function matchMiddle(
  builder: DeltaBuilder,
  base: Uint8Array,
  baseStart: number,
  baseEnd: number,
  target: Uint8Array,
  targetStart: number,
  targetEnd: number,
): void {
  const baseLength = baseEnd - baseStart;
  const targetLength = targetEnd - targetStart;
  if (targetLength <= 0) return;
  const block = blockSizeFor(baseLength);
  if (baseLength < block || targetLength < block) {
    builder.insert(target.subarray(targetStart, targetEnd));
    return;
  }

  const index = new Map<number, number[]>();
  for (let offset = baseStart; offset + block <= baseEnd; offset += block) {
    const hash = hashBlock(base, offset, block);
    const offsets = index.get(hash);
    if (offsets) offsets.push(offset);
    else index.set(hash, [offset]);
  }

  const power = blockPower(block);
  let insertStart = targetStart;
  let position = targetStart;
  let hash = hashBlock(target, position, block);
  while (position + block <= targetEnd) {
    let matched = -1;
    const candidates = index.get(hash);
    if (candidates) {
      for (const offset of candidates) {
        if (blocksEqual(base, offset, target, position, block)) {
          matched = offset;
          break;
        }
      }
    }
    if (matched >= 0) {
      let baseOffset = matched;
      let start = position;
      while (start > insertStart && baseOffset > baseStart && base[baseOffset - 1] === target[start - 1]) {
        baseOffset -= 1;
        start -= 1;
      }
      let length = position + block - start;
      while (
        baseOffset + length < baseEnd
        && start + length < targetEnd
        && base[baseOffset + length] === target[start + length]
      ) length += 1;
      builder.insert(target.subarray(insertStart, start));
      builder.copy(baseOffset, length);
      position = start + length;
      insertStart = position;
      if (position + block <= targetEnd) hash = hashBlock(target, position, block);
      continue;
    }
    if (position + block < targetEnd) hash = rollHash(hash, target[position]!, target[position + block]!, power);
    position += 1;
  }
  builder.insert(target.subarray(insertStart, targetEnd));
}
