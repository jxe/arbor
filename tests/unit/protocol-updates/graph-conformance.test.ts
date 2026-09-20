import { test, expect } from "bun:test";
import { verifyTreeSnapshotGraph } from "@overstory/protocol";
import vectors from "../../../conformance/protocol-graphs.json";

for (const vector of vectors.cases) {
  test(`shared Wire graph: ${vector.name}`, () => {
    const snapshot = { root: vector.root, objects: new Map(vector.objects.map(object => [object.hash, new Uint8Array(Buffer.from(object.bytesBase64, "base64"))])) };
    const validate = () => verifyTreeSnapshotGraph(snapshot, vector.mode as "complete" | "sparse-files");
    if (vector.valid) expect(validate().root).toBe(vector.root);
    else expect(validate).toThrow();
  });
}
