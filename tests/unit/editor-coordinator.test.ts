import { describe, expect, test } from "bun:test";
import type { ArborBlock, TreeNode } from "@arbor/core";
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

function tree(revision: string, snapshot: DocumentSnapshot): TreeNode {
  return {
    path: "/page",
    name: "page",
    kind: "markdown",
    revision,
    writable: true,
    materialization: "available",
    document: {
      frontmatter: snapshot.frontmatter,
      frontmatterSource: null,
      blocks: snapshot.blocks,
      bodySource: "",
    },
    diagnostics: [],
  };
}

function harness(initial: DocumentSnapshot) {
  const clock = new FakeClock();
  let captured = structuredClone(initial);
  const applied: DocumentSnapshot[] = [];
  const writes: DocumentSnapshot[] = [];
  const accepted: TreeNode[] = [];
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
});
