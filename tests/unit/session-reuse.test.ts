import { expect, test } from "bun:test";
import { sessionUsable } from "@overstory/protocol";

const MINUTE = 60_000;

test("an hour's session is replaced five minutes before it expires", () => {
  const session = { token: "t", openedAt: 0, expiresAt: 60 * MINUTE };
  expect(sessionUsable(session, 54 * MINUTE)).toBe(true);
  expect(sessionUsable(session, 55 * MINUTE)).toBe(false);
});

test("a short session, as a placement host issues near the end of its grace, is reused for three quarters of it", () => {
  const session = { token: "t", openedAt: 0, expiresAt: 2 * MINUTE };
  expect(sessionUsable(session, 0)).toBe(true);
  expect(sessionUsable(session, 89_000)).toBe(true);
  expect(sessionUsable(session, 90_000)).toBe(false);
});

test("a session saved without its opening time keeps the five-minute margin", () => {
  expect(sessionUsable({ token: "t", expiresAt: 10 * MINUTE }, 4 * MINUTE)).toBe(true);
  expect(sessionUsable({ token: "t", expiresAt: 10 * MINUTE }, 5 * MINUTE)).toBe(false);
});
