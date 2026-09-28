import { beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { LocatorPins } from "../../../packages/canopyd/src/locator-pins.ts";

/** Pinned profile locators (locators §1) against a host the test answers for. */

const CLUB = "https://club.example/~club";
let db: Database;
let answers: Map<string, string | null | Error>;
let changes: number;
let lifetimes = { lifetimeMs: 0, refetchMs: 0, staleMs: 60_000 };
let pins: LocatorPins;

beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE profile_locator_pins (tree_id TEXT NOT NULL, locator TEXT NOT NULL, profile_tree TEXT NOT NULL, PRIMARY KEY(tree_id, locator))`);
  answers = new Map([[CLUB, "tr_club"]]);
  changes = 0;
  lifetimes = { lifetimeMs: 0, refetchMs: 0, staleMs: 60_000 };
  pins = new LocatorPins(db, () => lifetimes, () => { changes += 1; }, async (locator) => {
    const answer = answers.get(locator);
    if (answer instanceof Error) throw answer;
    return answer ?? null;
  });
});

async function accept(tree: string, locators: string[]) {
  const fresh = await pins.prepare(tree, locators);
  db.transaction(() => pins.write(tree, fresh, locators))();
  return fresh;
}

test("an accept pins each new locator to the TreeID it resolves to, per tree", async () => {
  expect(await accept("tr_notes", [CLUB])).toEqual(new Map([[CLUB, "tr_club"]]));
  expect(pins.pinned("tr_notes", CLUB)).toBe("tr_club");
  expect(pins.pinned("tr_other", CLUB)).toBeNull();
  // A pin that holds is not resolved again by the next accept.
  answers.set(CLUB, "tr_else");
  expect(await accept("tr_notes", [CLUB])).toEqual(new Map());
  // A locator the tree no longer names loses its pin.
  await accept("tr_notes", []);
  expect(pins.pinned("tr_notes", CLUB)).toBeNull();
});

test("a locator its host cannot resolve, or resolves to nothing, refuses the accept", async () => {
  answers.set(CLUB, new Error("connection refused"));
  await expect(pins.prepare("tr_notes", [CLUB])).rejects.toMatchObject({ homeHost: "https://club.example" });
  answers.set(CLUB, null);
  await expect(pins.prepare("tr_notes", [CLUB])).rejects.toThrow("does not name a readable profile");
  await expect(pins.prepare("tr_notes", ["tr_club"])).rejects.toThrow("Not a profile locator");
});

test("another profile at the locator names nobody until an accept pins it afresh", async () => {
  await accept("tr_notes", [CLUB]);
  answers.set(CLUB, "tr_other");
  await pins.refresh();
  expect(changes).toBe(1);
  expect(pins.pinned("tr_notes", CLUB)).toBeNull();
  expect(pins.pinnedUnlessChanged("tr_notes", CLUB)).toBeNull();
  expect(await accept("tr_notes", [CLUB])).toEqual(new Map([[CLUB, "tr_other"]]));
  expect(pins.pinned("tr_notes", CLUB)).toBe("tr_other");
});

test("an unreachable host keeps its pins through the grace, then names nobody; a reservation waits on the device keys instead", async () => {
  await accept("tr_notes", [CLUB]);
  answers.set(CLUB, new Error("down"));
  lifetimes = { lifetimeMs: 0, refetchMs: 0, staleMs: 50 };
  await pins.refresh();
  expect(pins.pinned("tr_notes", CLUB)).toBe("tr_club");
  await Bun.sleep(60);
  await pins.refresh();
  expect(pins.pinned("tr_notes", CLUB)).toBeNull();
  expect(pins.pinnedUnlessChanged("tr_notes", CLUB)).toBe("tr_club");
  answers.set(CLUB, "tr_club");
  await pins.refresh();
  expect(pins.pinned("tr_notes", CLUB)).toBe("tr_club");
});
