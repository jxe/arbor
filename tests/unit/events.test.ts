import { describe, expect, test } from "bun:test";
import { EventBus, ResyncRequiredError } from "../../packages/arborsync/src/events.ts";
import { encodeSSEFrame } from "@arbor/core";

describe("REST v1 event replay", () => {
  test("uses process epochs and expires only cursors outside the bounded window", () => {
    const events = new EventBus(2);
    const initial = events.currentCursor();
    const first = events.emit({ tree: "local", kind: "created", ref: { tree: "local", path: "/one", stableKey: null }, origin: "api", mutationID: "one" });
    events.emit({ tree: "local", kind: "created", ref: { tree: "local", path: "/two", stableKey: null }, origin: "api", mutationID: "two" });
    events.emit({ tree: "local", kind: "created", ref: { tree: "local", path: "/three", stableKey: null }, origin: "api", mutationID: "three" });

    expect(() => events.validate(first.cursor)).not.toThrow();
    expect(() => events.validate(initial)).toThrow(ResyncRequiredError);
    expect(() => events.validate("different-epoch:0")).toThrow(ResyncRequiredError);
  });
});

describe("shared SSE framing", () => {
  test("frames replayable watcher events and stateless query results without merging cursor semantics", () => {
    expect(encodeSSEFrame({ id: "watch:1", event: "tree.ref", data: { cursor: "watch:1" } }))
      .toBe('id: watch:1\nevent: tree.ref\ndata: {"cursor":"watch:1"}\n\n');
    expect(encodeSSEFrame({ event: "result", data: { id: "query", observedThrough: "query:1" } }))
      .toBe('event: result\ndata: {"id":"query","observedThrough":"query:1"}\n\n');
    expect(() => encodeSSEFrame({ id: "bad\ncursor", event: "tree.ref", data: {} })).toThrow("one non-empty line");
  });
});
