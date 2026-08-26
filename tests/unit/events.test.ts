import { describe, expect, test } from "bun:test";
import { EventBus, ResyncRequiredError } from "../../packages/arbord/src/events.ts";

describe("REST v1 event replay", () => {
  test("uses process epochs and expires only cursors outside the bounded window", () => {
    const events = new EventBus(2);
    const initial = events.currentCursor();
    const first = events.emit({ tree: "local", kind: "created", path: "/one", origin: "api", mutationID: "one" });
    events.emit({ tree: "local", kind: "created", path: "/two", origin: "api", mutationID: "two" });
    events.emit({ tree: "local", kind: "created", path: "/three", origin: "api", mutationID: "three" });

    expect(() => events.validate(first.cursor)).not.toThrow();
    expect(() => events.validate(initial)).toThrow(ResyncRequiredError);
    expect(() => events.validate("different-epoch:0")).toThrow(ResyncRequiredError);
  });
});
