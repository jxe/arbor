import { expect, test } from "bun:test";
import { Recent } from "../../../packages/canopyd/src/recent.ts";

test("a recent cache keeps the most recently used entries within its count", () => {
  const cache = new Recent<number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  expect(cache.get("a")).toBe(1);
  cache.set("c", 3);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe(1);
  expect(cache.get("c")).toBe(3);
});

test("a weighted recent cache also keeps its total weight within the bound, replacing a key's weight", () => {
  const cache = new Recent<number[]>(8, { weight: (value) => value.length, maxWeight: 5 });
  cache.set("a", [1, 2]);
  cache.set("b", [1, 2]);
  cache.set("a", [1]);
  cache.set("c", [1, 2]);
  // a (1) + b (2) + c (2) = 5 fits; one more evicts the least recently used.
  expect(cache.get("b")).toEqual([1, 2]);
  cache.set("d", [1]);
  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("b")).toEqual([1, 2]);
  expect(cache.get("c")).toEqual([1, 2]);
  expect(cache.get("d")).toEqual([1]);
});
