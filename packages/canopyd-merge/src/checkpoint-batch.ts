import { checkpointIntent } from "./intent-engine.ts";
import type { MergeObjects } from "./index.ts";
import type { CheckpointBatchRequest, CheckpointBatchResponse } from "./checkpoint.ts";

import { CheckpointBatchLimitError } from "@overstory/merge-protocol";
export { CheckpointBatchLimitError };

/** Reuse exact immutable material across a bounded slice, publishing outputs once. */
export async function checkpointBatch(request: CheckpointBatchRequest, objects: MergeObjects): Promise<CheckpointBatchResponse> {
  const generated = new Map<string, Uint8Array>();
  const cache = new Map<string, Uint8Array>();
  let generatedBytes = 0, cachedBytes = 0;
  const access: MergeObjects = {
    read: async hash => {
      const found = generated.get(hash) ?? cache.get(hash);
      if (found) return found;
      const bytes = await objects.read(hash);
      if (bytes.length <= 32 * 1024 * 1024) {
        while (cache.size && cachedBytes + bytes.length > 32 * 1024 * 1024) {
          const key = cache.keys().next().value!;
          cachedBytes -= cache.get(key)!.length; cache.delete(key);
        }
        cache.set(hash, bytes); cachedBytes += bytes.length;
      }
      return bytes;
    },
    // The engine names each generated object by hashing it; staging checks
    // the published bytes again, so they are not hashed a third time here.
    store: async values => {
      for (const {hash, bytes} of values) {
        if (!generated.has(hash)) {
          generatedBytes += bytes.length;
          if (generatedBytes > 128 * 1024 * 1024) throw new CheckpointBatchLimitError("Checkpoint batch exceeds object byte budget");
          generated.set(hash, bytes);
        }
      }
    },
  };
  let current = request.current;
  const checkpoints: CheckpointBatchResponse["checkpoints"] = [];
  for (const step of request.steps) {
    const response = await checkpointIntent({kind: "checkpoint", tree: request.tree, current, ...step}, access);
    current = response.result; checkpoints.push(response.result);
  }
  await objects.store([...generated].map(([hash,bytes]) => ({hash,bytes})));
  return {kind:"checkpoint-batch",result:checkpoints.at(-1)!,checkpoints,objects:[...generated.keys()]};
}
