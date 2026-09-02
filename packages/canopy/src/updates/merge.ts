import {
  decodeWireObject,
  encodeWireObject,
  hashObject,
  type MergeSummary,
  type ObjectHash,
  type UpdateConflict,
  type WireDirectoryEntry,
  type WireObject,
} from "@arbor/wire";
import { canonicalCBORHash, stableJSONString, revisionOf, type Hash, type RollupDescriptor } from "@arbor/core";
import {
  decodeWireFileRollup,
  encodeWireFileRollup,
  SchemaSandbox,
  WireFileRollupError,
  type WireFileRollupRow,
} from "@arbor/stores";

export interface MergeResult {
  root: ObjectHash;
  objects: Map<ObjectHash, Uint8Array>;
  conflicts: UpdateConflict[];
  summary: MergeSummary;
}

type Load = (hash: ObjectHash) => Promise<Uint8Array>;

function entryEqual(left: WireDirectoryEntry | undefined, right: WireDirectoryEntry | undefined): boolean {
  return left?.name === right?.name
    && left?.hash === right?.hash
    && left?.tree === right?.tree
    && JSON.stringify(left?.rollup) === JSON.stringify(right?.rollup);
}

function sortedEntries(entries: WireDirectoryEntry[]): WireDirectoryEntry[] {
  return entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
}

function splitLines(source: string): string[] {
  return source.match(/.*?(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
}

interface Edit {
  start: number;
  end: number;
  replacement: string[];
}

function editsFrom(base: string[], changed: string[]): Edit[] {
  const rows = base.length + 1;
  const columns = changed.length + 1;
  const lcs = new Uint32Array(rows * columns);
  for (let left = base.length - 1; left >= 0; left--) {
    for (let right = changed.length - 1; right >= 0; right--) {
      lcs[left * columns + right] = base[left] === changed[right]
        ? 1 + lcs[(left + 1) * columns + right + 1]!
        : Math.max(lcs[(left + 1) * columns + right]!, lcs[left * columns + right + 1]!);
    }
  }
  const edits: Edit[] = [];
  let left = 0;
  let right = 0;
  while (left < base.length || right < changed.length) {
    if (left < base.length && right < changed.length && base[left] === changed[right]) {
      left++;
      right++;
      continue;
    }
    const start = left;
    const replacement: string[] = [];
    while (left < base.length || right < changed.length) {
      if (left < base.length && right < changed.length && base[left] === changed[right]) break;
      if (right < changed.length && (left === base.length || lcs[left * columns + right + 1]! >= lcs[(left + 1) * columns + right]!)) {
        replacement.push(changed[right++]!);
      } else if (left < base.length) {
        left++;
      }
    }
    edits.push({ start, end: left, replacement });
  }
  return edits;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mergeLines(base: string[], candidate: string[], remote: string[]): { lines: string[]; approximate: number } {
  const localEdits = editsFrom(base, candidate).map((edit) => ({ ...edit, side: "candidate" as const }));
  const remoteEdits = editsFrom(base, remote).map((edit) => ({ ...edit, side: "remote" as const }));
  const edits = [...localEdits, ...remoteEdits].sort((left, right) => left.start - right.start || left.end - right.end || (left.side === "remote" ? -1 : 1));
  const result: string[] = [];
  let cursor = 0;
  let approximate = 0;
  for (let index = 0; index < edits.length;) {
    const group = [edits[index++]!];
    const start = group[0]!.start;
    let end = group[0]!.end;
    while (index < edits.length && (
      edits[index]!.start < end
      || (edits[index]!.start === end && end === start && edits[index]!.end === start)
    )) {
      const next = edits[index++]!;
      group.push(next);
      end = Math.max(end, next.end);
    }
    result.push(...base.slice(cursor, start));
    const remoteReplacement = group.filter((edit) => edit.side === "remote").flatMap((edit) => edit.replacement);
    const candidateReplacement = group.filter((edit) => edit.side === "candidate").flatMap((edit) => edit.replacement);
    if (arraysEqual(remoteReplacement, candidateReplacement)) result.push(...remoteReplacement);
    else if (!remoteReplacement.length) result.push(...candidateReplacement);
    else if (!candidateReplacement.length) result.push(...remoteReplacement);
    else {
      result.push(...remoteReplacement, ...candidateReplacement);
      approximate++;
    }
    cursor = end;
  }
  result.push(...base.slice(cursor));
  return { lines: result, approximate };
}

function frontmatter(source: string): Map<string, string> | null {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") return new Map();
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  const values = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([^#][^:]*):\s*(.*)$/.exec(line);
    if (match) values.set(match[1]!.trim(), match[2]!);
  }
  return values;
}

function divergentFrontmatter(base: string, candidate: string, remote: string): boolean {
  const maps = [frontmatter(base), frontmatter(candidate), frontmatter(remote)] as const;
  if (maps.some((map) => map === null)) return true;
  const [baseMap, candidateMap, remoteMap] = maps as [Map<string, string>, Map<string, string>, Map<string, string>];
  for (const key of new Set([...candidateMap.keys(), ...remoteMap.keys()])) {
    const before = baseMap.get(key);
    const local = candidateMap.get(key);
    const accepted = remoteMap.get(key);
    if (local !== before && accepted !== before && local !== accepted) return true;
  }
  return false;
}

function balancedFences(source: string): boolean {
  const fences = source.split(/\r?\n/).filter((line) => /^\s*(```|~~~)/.test(line));
  return fences.length % 2 === 0;
}

export async function mergeWireTrees(
  base: ObjectHash,
  candidate: ObjectHash,
  remote: ObjectHash,
  load: Load,
): Promise<MergeResult> {
  const generated = new Map<ObjectHash, Uint8Array>();
  const conflicts: UpdateConflict[] = [];
  let approximatePlacements = 0;
  let mergedRows = 0;
  let sawRollupMerge = false;
  const store = (object: WireObject): ObjectHash => {
    const bytes = encodeWireObject(object);
    const hash = hashObject(bytes);
    generated.set(hash, bytes);
    return hash;
  };
  const object = async (hash: ObjectHash): Promise<WireObject> => decodeWireObject(generated.get(hash) ?? await load(hash));

  const rollupFile = async (hash: ObjectHash): Promise<Uint8Array> => {
    const value = await object(hash);
    if (value.type !== "file") throw new WireFileRollupError("source", "Rollup target is not a file object");
    return value.bytes;
  };

  const rowEqual = (left: WireFileRollupRow | undefined, right: WireFileRollupRow | undefined): boolean =>
    left === undefined ? right === undefined
      : right !== undefined && stableJSONString(left.properties) === stableJSONString(right.properties);

  const mergeRollup = async (
    path: string,
    baseDescriptor: RollupDescriptor,
    candidateDescriptor: RollupDescriptor,
    remoteDescriptor: RollupDescriptor,
  ): Promise<RollupDescriptor> => {
    sawRollupMerge = true;
    const schemaState = (value: RollupDescriptor) => stableJSONString({
      version: value.version,
      codec: value.codec,
      schemaSource: value.schemaSource,
      schema: value.schema,
      scope: value.scope,
    });
    if (schemaState(baseDescriptor) !== schemaState(candidateDescriptor)
      || schemaState(baseDescriptor) !== schemaState(remoteDescriptor)) {
      conflicts.push({ path, reason: "rollup-schema-conflict" });
      return candidateDescriptor;
    }
    const schemas = new SchemaSandbox();
    try {
      const baseRollup = await decodeWireFileRollup(
        baseDescriptor,
        await rollupFile(baseDescriptor.source),
        await rollupFile(baseDescriptor.schemaSource),
        schemas,
      );
      const candidateRollup = await decodeWireFileRollup(
        candidateDescriptor,
        await rollupFile(candidateDescriptor.source),
        await rollupFile(candidateDescriptor.schemaSource),
        schemas,
      );
      const remoteRollup = await decodeWireFileRollup(
        remoteDescriptor,
        await rollupFile(remoteDescriptor.source),
        await rollupFile(remoteDescriptor.schemaSource),
        schemas,
      );
      const baseRows = new Map(baseRollup.rows.map((row) => [row.stableKey, row]));
      const candidateRows = new Map(candidateRollup.rows.map((row) => [row.stableKey, row]));
      const remoteRows = new Map(remoteRollup.rows.map((row) => [row.stableKey, row]));
      const selected = new Map<string, WireFileRollupRow>();
      for (const key of new Set([...baseRows.keys(), ...candidateRows.keys(), ...remoteRows.keys()])) {
        const before = baseRows.get(key);
        const candidate = candidateRows.get(key);
        const remote = remoteRows.get(key);
        let row: WireFileRollupRow | undefined;
        if (rowEqual(candidate, remote)) row = candidate;
        else if (rowEqual(candidate, before)) row = remote;
        else if (rowEqual(remote, before)) {
          row = candidate;
          mergedRows += 1;
        } else {
          const parentPath = path.slice(0, path.lastIndexOf("/")) || "/";
          conflicts.push({ path: `${parentPath};arbor-key=${Buffer.from(key).toString("base64url")}`, reason: "rollup-row-conflict" });
          row = candidate;
        }
        if (row) selected.set(key, row);
      }
      const ordered: WireFileRollupRow[] = [];
      for (const row of remoteRollup.rows) {
        const selectedRow = selected.get(row.stableKey);
        if (selectedRow) {
          ordered.push(selectedRow);
          selected.delete(row.stableKey);
        }
      }
      for (const row of candidateRollup.rows) {
        const selectedRow = selected.get(row.stableKey);
        if (selectedRow) {
          ordered.push(selectedRow);
          selected.delete(row.stableKey);
        }
      }
      ordered.push(...[...selected.values()].sort((left, right) => left.stableKey < right.stableKey ? -1 : 1));
      const modelDigest = canonicalCBORHash([...ordered]
        .sort((left, right) => left.stableKey < right.stableKey ? -1 : left.stableKey > right.stableKey ? 1 : 0)
        .map((row) => ({ key: row.stableKey, path: row.path, properties: row.properties })));
      const source = store({
        type: "file",
        bytes: encodeWireFileRollup(remoteDescriptor.codec, remoteRollup.schema, ordered),
      }) as Hash;
      return { ...remoteDescriptor, source, modelDigest };
    } catch (error) {
      if (error instanceof WireFileRollupError) {
        conflicts.push({ path, reason: error.kind === "schema" ? "rollup-schema-conflict" : "rollup-constraint-conflict" });
        return candidateDescriptor;
      }
      throw error;
    } finally {
      await schemas[Symbol.asyncDispose]();
    }
  };

  const mergeHash = async (path: string, baseHash: ObjectHash, candidateHash: ObjectHash, remoteHash: ObjectHash): Promise<ObjectHash> => {
    if (candidateHash === remoteHash) return candidateHash;
    if (candidateHash === baseHash) return remoteHash;
    if (remoteHash === baseHash) return candidateHash;
    const [baseObject, candidateObject, remoteObject] = await Promise.all([object(baseHash), object(candidateHash), object(remoteHash)]);
    if (baseObject.type !== candidateObject.type || baseObject.type !== remoteObject.type) {
      conflicts.push({ path, reason: "path-kind-conflict" });
      return candidateHash;
    }
    if (baseObject.type === "file" && candidateObject.type === "file" && remoteObject.type === "file") {
      if (!path.endsWith(".md")) {
        conflicts.push({ path, reason: "binary-conflict" });
        return candidateHash;
      }
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let baseSource: string;
      let candidateSource: string;
      let remoteSource: string;
      try {
        baseSource = decoder.decode(baseObject.bytes);
        candidateSource = decoder.decode(candidateObject.bytes);
        remoteSource = decoder.decode(remoteObject.bytes);
      } catch {
        conflicts.push({ path, reason: "binary-conflict" });
        return candidateHash;
      }
      const merged = mergeLines(splitLines(baseSource), splitLines(candidateSource), splitLines(remoteSource));
      approximatePlacements += merged.approximate;
      const source = merged.lines.join("");
      if (divergentFrontmatter(baseSource, candidateSource, remoteSource)) conflicts.push({ path, reason: "frontmatter-conflict" });
      if (!balancedFences(source)) conflicts.push({ path, reason: "invalid-markdown-fence" });
      return store({ type: "file", bytes: new TextEncoder().encode(source) });
    }
    if (baseObject.type !== "directory" || candidateObject.type !== "directory" || remoteObject.type !== "directory") {
      conflicts.push({ path, reason: "path-kind-conflict" });
      return candidateHash;
    }
    const baseEntries = new Map(baseObject.entries.map((entry) => [entry.name, entry]));
    const candidateEntries = new Map(candidateObject.entries.map((entry) => [entry.name, entry]));
    const remoteEntries = new Map(remoteObject.entries.map((entry) => [entry.name, entry]));
    const entries: WireDirectoryEntry[] = [];
    const markdownPages = async (directory: WireDirectoryEntry[]): Promise<Map<string, WireDirectoryEntry & { hash: ObjectHash }>> => {
      const unique = new Map<string, WireDirectoryEntry & { hash: ObjectHash }>();
      const duplicates = new Set<string>();
      for (const entry of directory) {
        if (!entry.hash || !entry.name.endsWith(".md")) continue;
        const value = await object(entry.hash);
        if (value.type !== "file") continue;
        let source: string;
        try {
          source = new TextDecoder("utf-8", { fatal: true }).decode(value.bytes);
        } catch {
          continue;
        }
        const id = frontmatter(source)?.get("id");
        if (!id) continue;
        if (unique.has(id)) {
          unique.delete(id);
          duplicates.add(id);
        } else if (!duplicates.has(id)) {
          unique.set(id, { ...entry, hash: entry.hash });
        }
      }
      return unique;
    };
    const [basePages, candidatePages, remotePages] = await Promise.all([
      markdownPages(baseObject.entries),
      markdownPages(candidateObject.entries),
      markdownPages(remoteObject.entries),
    ]);
    const handledNames = new Set<string>();
    for (const [id, before] of basePages) {
      const local = candidatePages.get(id);
      const accepted = remotePages.get(id);
      if (!local || !accepted || (local.name === before.name && accepted.name === before.name)) continue;
      const localMoved = local.name !== before.name;
      const acceptedMoved = accepted.name !== before.name;
      if (localMoved && acceptedMoved && local.name !== accepted.name) {
        conflicts.push({ path: `${path === "/" ? "" : path}/${before.name}`, reason: "page-id-move-conflict" });
        entries.push(local);
        handledNames.add(before.name);
        handledNames.add(local.name);
        handledNames.add(accepted.name);
        continue;
      }
      const target = localMoved ? local.name : accepted.name;
      const localAtTarget = candidateEntries.get(target);
      const acceptedAtTarget = remoteEntries.get(target);
      if (
        (localAtTarget && !entryEqual(localAtTarget, local))
        || (acceptedAtTarget && !entryEqual(acceptedAtTarget, accepted))
      ) {
        conflicts.push({ path: `${path === "/" ? "" : path}/${target}`, reason: "page-id-move-conflict" });
        entries.push(local);
      } else {
        entries.push({
          name: target,
          hash: await mergeHash(`${path === "/" ? "" : path}/${target}`, before.hash, local.hash, accepted.hash),
        });
      }
      handledNames.add(before.name);
      handledNames.add(local.name);
      handledNames.add(accepted.name);
    }
    for (const name of new Set([...baseEntries.keys(), ...candidateEntries.keys(), ...remoteEntries.keys()])) {
      if (handledNames.has(name)) continue;
      const before = baseEntries.get(name);
      const local = candidateEntries.get(name);
      const accepted = remoteEntries.get(name);
      if (entryEqual(local, accepted)) {
        if (local) entries.push(local);
        continue;
      }
      if (entryEqual(local, before)) {
        if (accepted) entries.push(accepted);
        continue;
      }
      if (entryEqual(accepted, before)) {
        if (local) entries.push(local);
        continue;
      }
      if (!local || !accepted) {
        entries.push((local ?? accepted)!);
        continue;
      }
      if (local.tree || accepted.tree || before?.tree) {
        conflicts.push({ path: `${path === "/" ? "" : path}/${name}`, reason: "nested-boundary-conflict" });
        entries.push(local);
        continue;
      }
      if (local.rollup || accepted.rollup || before?.rollup) {
        const childPath = `${path === "/" ? "" : path}/${name}`;
        if (!before?.rollup || !local.rollup || !accepted.rollup) {
          conflicts.push({ path: childPath, reason: "path-kind-conflict" });
          entries.push(local);
        } else {
          entries.push({ name, rollup: await mergeRollup(childPath, before.rollup, local.rollup, accepted.rollup) });
        }
        continue;
      }
      if (!before?.hash || !local.hash || !accepted.hash) {
        const childPath = `${path === "/" ? "" : path}/${name}`;
        if (name.endsWith(".md") && local.hash && accepted.hash) {
          const empty = store({ type: "file", bytes: new Uint8Array() });
          entries.push({ name, hash: await mergeHash(childPath, empty, local.hash, accepted.hash) });
        } else {
          conflicts.push({ path: childPath, reason: "path-kind-conflict" });
          entries.push(local);
        }
        continue;
      }
      entries.push({ name, hash: await mergeHash(`${path === "/" ? "" : path}/${name}`, before.hash, local.hash, accepted.hash) });
    }
    return store({ type: "directory", entries: sortedEntries(entries) });
  };

  const root = await mergeHash("/", base, candidate, remote);
  return {
    root,
    objects: generated,
    conflicts,
    summary: sawRollupMerge
      ? { version: "rollup-rows-v1", mergedRows }
      : { version: "markdown-additive-v1", approximatePlacements },
  };
}
