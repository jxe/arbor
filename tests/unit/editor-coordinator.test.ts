import { describe, expect, test } from "bun:test";
import type { ArborBlock, NodeSnapshot } from "@arbor/core";
import type { NodeResponse } from "@arbor/arborsync-client";
import { serializeMarkdown } from "@arbor/editor";
import {
  EditorCoordinator,
  type DocumentSnapshot,
  type EditorClock,
} from "../../packages/render/src/editor-coordinator.ts";

class FakeClock implements EditorClock {
  private nextID = 1;
  private tasks = new Map<number, () => void>();

  setTimeout(callback: () => void): number {
    const id = this.nextID++;
    this.tasks.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  runAll(): void {
    const pending = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of pending) task();
  }
}

function paragraph(id: string, content: string): ArborBlock {
  return { id, type: "paragraph", content, props: {}, children: [] };
}

function tree(revision: string, snapshot: DocumentSnapshot): NodeSnapshot {
  const document = {
    source: "",
    frontmatter: snapshot.frontmatter,
    frontmatterSource: null,
    blocks: snapshot.blocks,
    bodySource: "",
  };
  return {
    ref: { tree: "local", path: "/page", stableKey: '[["id","abc123"]]' },
    name: "page",
    revision,
    properties: snapshot.frontmatter as Record<string, import("@arbor/core").JSONValue>,
    capabilities: {
      properties: { revision, writable: true },
      content: { revision, mediaType: "text/markdown", format: "markdown", writable: true },
    },
    materialization: "available",
    content: { source: serializeMarkdown(document, snapshot.blocks, snapshot.frontmatter) },
    diagnostics: [],
    observedThrough: `test:${revision}`,
  };
}

function harness(initial: DocumentSnapshot) {
  const clock = new FakeClock();
  let captured = structuredClone(initial);
  const applied: DocumentSnapshot[] = [];
  const writes: DocumentSnapshot[] = [];
  const accepted: NodeSnapshot[] = [];
  const coordinator = new EditorCoordinator({
    path: "/page",
    revision: "r0",
    baseBlocks: initial.blocks,
    baseFrontmatter: initial.frontmatter,
    initialSnapshot: initial,
    clock,
    capture: () => structuredClone(captured),
    write: async (_path, _revision, snapshot) => {
      writes.push(structuredClone(snapshot));
      return tree(`r${writes.length}`, snapshot);
    },
    applySnapshot: (snapshot) => {
      captured = structuredClone(snapshot);
      applied.push(structuredClone(snapshot));
    },
    acceptNode: (node) => accepted.push(node),
    notify: () => {},
  });
  return {
    accepted,
    applied,
    clock,
    coordinator,
    get captured() { return captured; },
    set captured(value: DocumentSnapshot) { captured = value; },
    writes,
  };
}

describe("editor coordinator", () => {
  test("coalesces rapid authored generations into the latest save", async () => {
    const initial = { blocks: [paragraph("p", "initial")], frontmatter: {} };
    const value = harness(initial);
    value.captured = { blocks: [paragraph("p", "one")], frontmatter: {} };
    value.coordinator.markAuthored(value.captured);
    value.captured = { blocks: [paragraph("p", "two")], frontmatter: {} };
    value.coordinator.markAuthored(value.captured);

    await value.coordinator.flush();

    expect(value.writes).toHaveLength(1);
    expect(value.writes[0]?.blocks[0]?.content).toBe("two");
    expect(value.coordinator.saveState).toBe("saved");
    expect(value.accepted).toHaveLength(1);
  });

  test("keeps editor normalization outside authored generations and history", async () => {
    const initial = { blocks: [paragraph("p", "initial")], frontmatter: {} };
    const value = harness(initial);
    const normalized = { blocks: [paragraph("p", "normalized")], frontmatter: {} };

    value.coordinator.applyNormalizationSnapshot(normalized);
    await value.coordinator.flush();

    expect(value.applied).toEqual([normalized]);
    expect(value.writes).toHaveLength(0);
    expect(value.coordinator.canUndo).toBe(false);
    expect(value.coordinator.saveState).toBe("saved");
  });

  test("groups authored snapshots into one deterministic history boundary", async () => {
    const initial = { blocks: [paragraph("p", "initial")], frontmatter: {} };
    const value = harness(initial);
    value.captured = { blocks: [paragraph("p", "one")], frontmatter: {} };
    value.coordinator.markAuthored(value.captured);
    value.captured = { blocks: [paragraph("p", "two")], frontmatter: {} };
    value.coordinator.markAuthored(value.captured);
    value.coordinator.flushHistory();

    expect(value.coordinator.canUndo).toBe(true);
    await value.coordinator.undo();
    expect(value.captured.blocks[0]?.content).toBe("initial");
    expect(value.coordinator.canRedo).toBe(true);
  });

  test("applies clean external revisions without creating an authored change", () => {
    const initial = { blocks: [paragraph("p", "initial")], frontmatter: {} };
    const value = harness(initial);
    const external = { blocks: [paragraph("p", "external")], frontmatter: {} };

    value.coordinator.observeExternal(tree("external-revision", external));

    expect(value.accepted).toHaveLength(1);
    expect(value.coordinator.currentRevision).toBe("external-revision");
    expect(value.coordinator.isDirty).toBe(false);
  });

  test("discards an external read that predates a newer saved editor generation", async () => {
    const initial = { blocks: [paragraph("p", "initial")], frontmatter: {} };
    const value = harness(initial);
    const observation = value.coordinator.captureExternalObservation();
    const stale = { blocks: [paragraph("p", "accepted prefix")], frontmatter: {} };

    value.captured = { blocks: [paragraph("p", "newest local")], frontmatter: {} };
    value.coordinator.markAuthored(value.captured);
    await value.coordinator.flush();
    value.coordinator.observeExternal(tree("stale-prefix", stale), observation);

    expect(value.captured.blocks[0]?.content).toBe("newest local");
    expect(value.coordinator.currentRevision).toBe("r1");
    expect(value.accepted).toHaveLength(1);
    expect(value.coordinator.saveState).toBe("saved");
  });

  test("waits for its own accepted request digest before applying an authoritative prefix", async () => {
    const digest = `sha256:${"a".repeat(64)}` as const;
    const initial = { blocks: [paragraph("p", "initial")], frontmatter: {} };
    let captured = structuredClone(initial);
    const accepted: NodeResponse[] = [];
    const coordinator = new EditorCoordinator({
      path: "/page",
      revision: "r0",
      baseBlocks: initial.blocks,
      baseFrontmatter: {},
      initialSnapshot: initial,
      capture: () => structuredClone(captured),
      write: async (_path, _revision, value) => ({
        ...tree("r-local", value),
        admissionRequestDigest: digest,
      }),
      applySnapshot: (value) => { captured = structuredClone(value); },
      acceptNode: (node) => accepted.push(node),
      notify: () => {},
    });
    captured = { blocks: [paragraph("p", "latest local")], frontmatter: {} };
    coordinator.markAuthored(captured);
    await coordinator.flush();

    coordinator.observeExternal(tree("r-prefix", {
      blocks: [paragraph("p", "accepted prefix")],
      frontmatter: {},
    }));
    expect(captured.blocks[0]?.content).toBe("latest local");

    coordinator.observeExternal({
      ...tree("r-authoritative", {
        blocks: [paragraph("p", "accepted latest")],
        frontmatter: {},
      }),
      acceptedRequestDigests: [digest],
    });
    expect(accepted.at(-1)?.content?.source).toContain("accepted latest");
    expect(coordinator.currentRevision).toBe("r-authoritative");
  });

  test("persists every authored row because directory rows are ordinary Markdown", async () => {
    const child = { ...paragraph("child-link", "child"), type: "standaloneLink" as const };
    const initial = { blocks: [paragraph("p", "initial"), child], frontmatter: {} };
    const value = harness(initial);
    value.captured = { blocks: [paragraph("p", "edited"), child], frontmatter: {} };
    value.coordinator.markAuthored(value.captured);
    value.clock.runAll();
    await value.coordinator.flush();

    expect(value.writes).toHaveLength(1);
    expect(value.writes[0]!.blocks.map((block) => block.id)).toEqual(["p", "child-link"]);
  });
});

describe("editor coordinator admission machine", () => {
  test("fifteen rapid edits make one admission carrying the final source", async () => {
    const initial = { blocks: [paragraph("p", "initial")], frontmatter: {} };
    const value = harness(initial);
    for (let index = 1; index <= 15; index++) {
      value.captured = { blocks: [paragraph("p", `edit ${index}`)], frontmatter: {} };
      value.coordinator.markAuthored(value.captured);
    }
    expect(value.coordinator.admissionState.kind).toBe("dirty");
    expect(value.writes).toHaveLength(0);
    value.clock.runAll();
    await value.coordinator.flush();
    expect(value.writes).toHaveLength(1);
    expect(value.writes[0]?.blocks[0]?.content).toBe("edit 15");
    expect(value.coordinator.saveState).toBe("saved");
  });

  test("edits during an in-flight admission become one successor, never a second concurrent request", async () => {
    const initial = { blocks: [paragraph("p", "initial")], frontmatter: {} };
    const clock = new FakeClock();
    let captured = structuredClone(initial);
    const writes: DocumentSnapshot[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let inFlight = 0;
    let maxInFlight = 0;
    const coordinator = new EditorCoordinator({
      path: "/page",
      revision: "r0",
      baseBlocks: initial.blocks,
      baseFrontmatter: {},
      initialSnapshot: initial,
      clock,
      capture: () => structuredClone(captured),
      write: async (_path, _revision, snapshot) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        writes.push(structuredClone(snapshot));
        if (writes.length === 1) await held;
        inFlight -= 1;
        return tree(`r${writes.length}`, snapshot);
      },
      applySnapshot: (snapshot) => { captured = structuredClone(snapshot); },
      acceptNode: () => {},
      notify: () => {},
    });
    captured = { blocks: [paragraph("p", "one")], frontmatter: {} };
    coordinator.markAuthored(captured);
    clock.runAll();
    expect(coordinator.admissionState.kind).toBe("submitting");
    for (const text of ["two", "three", "four"]) {
      captured = { blocks: [paragraph("p", text)], frontmatter: {} };
      coordinator.markAuthored(captured);
    }
    expect(coordinator.admissionState.kind).toBe("submitting-dirty");
    expect(writes).toHaveLength(1);
    release();
    await coordinator.flush();
    expect(writes).toHaveLength(2);
    expect(writes[1]?.blocks[0]?.content).toBe("four");
    expect(maxInFlight).toBe(1);
    expect(coordinator.currentRevision).toBe("r2");
  });

  test("an edit back to the accepted bytes performs no request", async () => {
    const initial = { blocks: [paragraph("p", "initial")], frontmatter: {} };
    const value = harness(initial);
    value.captured = { blocks: [paragraph("p", "changed")], frontmatter: {} };
    value.coordinator.markAuthored(value.captured);
    value.captured = structuredClone(initial);
    value.coordinator.markAuthored(value.captured);
    value.clock.runAll();
    await value.coordinator.flush();
    expect(value.writes).toHaveLength(0);
    expect(value.coordinator.saveState).toBe("saved");
  });

  test("a Canopy-backed conflict never runs the local block merge", async () => {
    const initial = { blocks: [paragraph("p", "initial")], frontmatter: {} };
    const clock = new FakeClock();
    let captured = structuredClone(initial);
    const applied: DocumentSnapshot[] = [];
    const coordinator = new EditorCoordinator({
      path: "/page",
      revision: "r0",
      baseBlocks: initial.blocks,
      baseFrontmatter: {},
      initialSnapshot: initial,
      transport: "canopy",
      admissionBasis: "basis",
      clock,
      capture: () => structuredClone(captured),
      write: async () => {
        const error = Object.assign(new Error("conflict"), {
          status: 409,
          payload: { current: tree("r-remote", { blocks: [paragraph("q", "remote")], frontmatter: {} }) },
        });
        throw error;
      },
      applySnapshot: (snapshot) => { applied.push(structuredClone(snapshot)); captured = structuredClone(snapshot); },
      acceptNode: () => {},
      notify: () => {},
    });
    captured = { blocks: [paragraph("p", "mine")], frontmatter: {} };
    coordinator.markAuthored(captured);
    clock.runAll();
    await expect(coordinator.flush()).rejects.toThrow();
    expect(coordinator.saveState).toBe("conflict");
    expect(applied).toHaveLength(0);
    expect(captured.blocks[0]?.content).toBe("mine");
  });
});
