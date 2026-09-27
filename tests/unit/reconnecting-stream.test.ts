import { expect, test } from "bun:test";
import { observationReconnectDelay, reconnectingStream } from "@overstory/protocol";

test("the reconnect schedule matches Swift's: 250 ms doubling, capped", () => {
  expect([0, 1, 2, 3, 4, 5, 9].map((failures) => observationReconnectDelay(failures))).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
  expect(observationReconnectDelay(9, 30_000)).toBe(8_000);
});

test("streams are joined across failures and clean ends until aborted; a fatal error stops them", async () => {
  const abort = new AbortController();
  let attempt = 0;
  const seen: number[] = [];
  const stream = reconnectingStream(async function* () {
    attempt += 1;
    if (attempt === 1) throw new Error("connection refused");
    yield attempt;
    if (attempt === 3) abort.abort();
  }, { signal: abort.signal, maximumDelayMs: 1 });
  for await (const item of stream) seen.push(item);
  expect(seen).toEqual([2, 3]);

  const fatal = new Error("unauthorized");
  const failing = reconnectingStream(async function* (): AsyncGenerator<number> { throw fatal; }, { maximumDelayMs: 1, fatal: (error) => error === fatal });
  await expect(failing.next()).rejects.toBe(fatal);
});
