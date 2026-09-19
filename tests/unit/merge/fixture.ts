import {
  hashObject,
  encodeWireDirectory,
  decodeWireDirectory,
  type MaterialRef,
  type SourceOperation,
  type WireDirectoryEntry,
} from "@arbor/wire";
import { merge as mergeIntent } from "@arbor/merge";
import type {
  Frame,
  IntentRequestInput,
  IntentResponse,
} from "../../../packages/merge/src/intent-model.ts";

export class Fixture {
  objects = new Map<string, Uint8Array>();
  put(text: string | Uint8Array) {
    const bytes =
      typeof text === "string" ? new TextEncoder().encode(text) : text;
    const hash = hashObject(bytes);
    this.objects.set(hash, bytes);
    return hash;
  }
  tree(files: Record<string, string>): string {
    return this.put(
      encodeWireDirectory({
        type: "directory",
        entries: Object.entries(files)
          .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
          .map(([name, text]) => ({ name, file: this.put(text) })),
      }),
    );
  }
  dir(entries: WireDirectoryEntry[]) {
    return this.put(
      encodeWireDirectory({
        type: "directory",
        entries: [...entries].sort((a, b) =>
          Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
        ),
      }),
    );
  }
  ref(path: string, text: string, range?: [number, number]): MaterialRef {
    return {
      material: { kind: "basis", path, object: this.put(text) },
      ...(range ? { range } : {}),
    };
  }
  op(change: string, operation: string, range?: [number, number]): MaterialRef {
    return {
      material: { kind: "operation", change, operation },
      ...(range ? { range } : {}),
    };
  }
  root(object: string): MaterialRef {
    return { material: { kind: "basis", path: "/", object } };
  }
  request(
    base: string | { object: string; state: string },
    candidate: string,
    operations: SourceOperation[],
    change = "edit",
    current?: string | { object: string; state: string },
  ): IntentRequestInput {
    const ref = (r: string | { object: string; state: string }) =>
      typeof r === "string" ? { object: r } : r;
    return {
      kind: "tree",
      tree: "tree",
      base: ref(base),
      current: ref(current ?? base),
      incoming: { change, object: candidate, operations },
      rules: { id: "tree-default", revision: 1 },
    };
  }
  /** The same request with its operations carried as an explicit frame chain.
   * `frames` gives each frame's `after` root with the operations that reach it. */
  trace(
    base: string | { object: string; state: string },
    frames: Array<{ after: string; operations: SourceOperation[] }>,
    change = "edit",
    current?: string | { object: string; state: string },
  ): IntentRequestInput {
    const ref = (r: string | { object: string; state: string }) =>
      typeof r === "string" ? { object: r } : r;
    const chain: Frame[] = [];
    let before = ref(base).object;
    for (const frame of frames) {
      chain.push({ before, after: frame.after, operations: frame.operations });
      before = frame.after;
    }
    return {
      kind: "tree",
      tree: "tree",
      base: ref(base),
      current: ref(current ?? base),
      incoming: { change, object: chain.at(-1)!.after, trace: chain },
      rules: { id: "tree-default", revision: 1 },
    };
  }
  async run(
    r: IntentRequestInput,
  ): Promise<Extract<IntentResponse, { outcome: "evaluated" }>> {
    const response = await this.evaluate(r);
    if (response.outcome !== "evaluated")
      throw new Error(JSON.stringify(response));
    return response;
  }
  evaluate(r: IntentRequestInput) {
    return mergeIntent(r, {
      read: async (hash) => {
        const b = this.objects.get(hash);
        if (!b) throw new Error("missing");
        return b;
      },
      store: async (objects) => {
        for (const o of objects) this.objects.set(o.hash, o.bytes);
      },
    });
  }
  content(root: string, name: string) {
    const entry = decodeWireDirectory(this.objects.get(root)!).entries.find(
      (e) => e.name === name,
    )!;
    return new TextDecoder().decode(this.objects.get(entry.file!));
  }
}
