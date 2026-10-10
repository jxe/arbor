import { afterEach, expect, setSystemTime, test } from "bun:test";
import { AttemptLimiter } from "../../../packages/overstoryd/src/attempt-limiter.ts";

afterEach(() => { setSystemTime(); });

const size = (limiter: AttemptLimiter) => (limiter as unknown as { attempts: Map<string, number[]> }).attempts.size;

test("an attempt limit refuses within its window and allows again after it", () => {
  setSystemTime(new Date(1_000_000));
  const limiter = new AttemptLimiter(2, 1000);
  expect(limiter.allow("a")).toBe(true);
  expect(limiter.allow("a")).toBe(true);
  expect(limiter.allow("a")).toBe(false);
  expect(limiter.allow("b")).toBe(true);
  setSystemTime(new Date(1_001_001));
  expect(limiter.allow("a")).toBe(true);
});

test("expired keys are dropped and live keys are capped", () => {
  setSystemTime(new Date(1_000_000));
  const limiter = new AttemptLimiter(1, 1000, 3);
  for (const key of ["a", "b", "c", "d", "e"]) expect(limiter.allow(key)).toBe(true);
  expect(size(limiter)).toBe(3);
  expect(limiter.allow("e")).toBe(false);
  setSystemTime(new Date(1_002_000));
  expect(limiter.allow("f")).toBe(true);
  expect(size(limiter)).toBe(1);
});
