import { decodeWireDirectory, hashObject } from "@arbor/wire";
import {
  intentDependencies,
  parseIntentState,
  type Node,
} from "./intent-model.ts";
/** Explicit graph walk; arbitrary file bytes are never interpreted as metadata. */
export async function verifyIntentRetention(
  roots: string[],
  load: (hash: string) => Promise<Uint8Array>
): Promise<Set<string>> {
  const cache = new Map<string, Uint8Array>();
  const verified = new Set<string>(),
    states = new Set<string>(),
    directories = new Set<string>();
  const read = async (hash: string) => {
    const existing = cache.get(hash);
    if (existing) return existing;
    const bytes = await load(hash);
    if (hashObject(bytes) !== hash)
      throw new Error("Invalid retained object hash");
    verified.add(hash);
    cache.set(hash, bytes);
    if (verified.size > 1000000)
      throw new Error("Retained graph exceeds verification budget");
    return bytes;
  };
  const directory = async (hash: string) => {
    if (directories.has(hash)) return;
    directories.add(hash);
    for (const entry of decodeWireDirectory(await read(hash)).entries) {
      if (entry.directory) await directory(entry.directory);
      else if (entry.file) await read(entry.file);
    }
  };
  const nodes = async (values: Record<string, Node>) => {
    for (const node of Object.values(values)) {
      if (node.kind === "directory") await directory(node.object);
      else if (node.kind === "file") await read(node.object);
    }
  };
  const state = async (hash: string) => {
    if (states.has(hash)) return;
    states.add(hash);
    const value = parseIntentState(
      JSON.parse(new TextDecoder().decode(await read(hash)))
    );
    for (const dependency of intentDependencies(value)) await read(dependency);
    await nodes(value.nodes);
    for (const material of Object.values(value.outputs))
      if (material.view) await nodes(material.view.nodes);
    for (const effect of Object.values(value.effects)) {
      await nodes(effect.before);
      await nodes(effect.after);
      await directory(effect.authored.basis);
    }
    for (const envelope of Object.values(value.changes)) {
      const recorded = JSON.parse(
        new TextDecoder().decode(await read(envelope))
      );
      if (recorded.base?.state) await state(recorded.base.state);
      await directory(recorded.base.object);
      await directory(recorded.incoming.object);
    }
    for (const decision of value.decisions) {
      if (decision.context) await state(decision.context);
      for (const alternative of decision.alternatives)
        await state(alternative.state);
    }
  };
  for (const root of roots) await state(root);
  return verified;
}
