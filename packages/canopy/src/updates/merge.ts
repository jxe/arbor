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

export interface MergeResult {
  root: ObjectHash;
  objects: Map<ObjectHash, Uint8Array>;
  conflicts: UpdateConflict[];
  summary: MergeSummary;
}

type Load = (hash: ObjectHash) => Promise<Uint8Array>;

function entryEqual(left: WireDirectoryEntry | undefined, right: WireDirectoryEntry | undefined): boolean {
  return left?.name === right?.name && left?.hash === right?.hash && left?.tree === right?.tree;
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
  const store = (object: WireObject): ObjectHash => {
    const bytes = encodeWireObject(object);
    const hash = hashObject(bytes);
    generated.set(hash, bytes);
    return hash;
  };
  const object = async (hash: ObjectHash): Promise<WireObject> => decodeWireObject(generated.get(hash) ?? await load(hash));

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
    summary: { version: "markdown-additive-v1", approximatePlacements },
  };
}
