import {
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  encodeProtocolPage,
  hashObject,
  loadProtocolContent,
  parsePage,
  ProtocolUpdateConflict,
  type ObjectHash,
  type ProtocolClient,
  type ProtocolDirectory,
  type TreeSnapshot,
} from "@ovst/protocol";

export interface TreeFileEdit {
  /** Whether an update was accepted; false when `change` left the file as it was. */
  changed: boolean;
  /** The accepted update the edit was made on or produced. */
  update: string;
}

const RETRIES = 4;

/**
 * Edit one file of a tree on its host, as the caller `client` speaks for:
 * read `path` at the tree's current head, apply `change` to its text, and
 * submit the result guarded by `ifCurrent`. When another update was accepted
 * meanwhile, read again and apply `change` to the new text, a bounded number
 * of times, so both changes survive. A `change` that returns the same text
 * submits nothing.
 *
 * In a tree that holds pages (spec 02 §3), a Markdown page is read as its
 * canonical file and the edited text is written back as a page; the host
 * then holds its properties and body, not these exact bytes.
 */
export async function editTreeFile(
  client: ProtocolClient,
  tree: string,
  path: string,
  change: (text: string) => string | Promise<string>,
): Promise<TreeFileEdit> {
  const names = path.split("/").filter(Boolean);
  if (!names.length || names.some((name) => name === "." || name === "..")) throw new Error(`Not a file path in a tree: ${path}`);
  for (let attempt = 0; ; attempt += 1) {
    const head = (await client.descriptor(tree)).tree;
    const snapshot = await client.snapshot(tree, head.root);
    const load = async (hash: ObjectHash) => {
      const bytes = snapshot.objects.get(hash);
      if (!bytes) throw new Error(`The snapshot of ${tree} lacks ${hash}`);
      return bytes;
    };
    const added = new Map<ObjectHash, Uint8Array>();
    let unchanged = false;
    // Rebuild the directories from the file up to the root.
    const rewrite = async (directoryHash: ObjectHash, depth: number): Promise<ObjectHash> => {
      const directory = decodeProtocolDirectory(await load(directoryHash));
      if (directory.type !== "directory") throw new Error(`${names.slice(0, depth).join("/") || "The root"} of ${tree} is not a directory`);
      const name = names[depth]!;
      const entry = directory.entries.find((candidate) => candidate.name === name);
      const where = names.slice(0, depth + 1).join("/");
      if (!entry) throw new Error(`${tree} has no ${where}`);
      let replaced: ProtocolDirectory["entries"][number];
      if (depth === names.length - 1) {
        if (!entry.file && !entry.page) throw new Error(`${where} in ${tree} is not a file`);
        const before = new TextDecoder().decode(await loadProtocolContent(entry, load));
        const after = await change(before);
        if (after === before) {
          unchanged = true;
          return directoryHash;
        }
        const bytes = new TextEncoder().encode(after);
        if (entry.page) {
          const page = parsePage(bytes);
          if (!page) throw new Error(`The edited ${where} no longer reads as a page`);
          const encoded = encodeProtocolPage(page);
          const hash = hashObject(encoded);
          added.set(hash, encoded);
          replaced = { name, page: hash };
        } else {
          const hash = hashObject(bytes);
          added.set(hash, bytes);
          replaced = { name, file: hash };
        }
      } else {
        if (!entry.directory) throw new Error(`${where} in ${tree} is not a directory`);
        const child = await rewrite(entry.directory, depth + 1);
        if (unchanged) return directoryHash;
        replaced = { name, directory: child };
      }
      const encoded = encodeProtocolDirectory({ ...directory, entries: directory.entries.map((candidate) => candidate.name === name ? replaced : candidate) });
      const hash = hashObject(encoded);
      added.set(hash, encoded);
      return hash;
    };
    const root = await rewrite(head.root, 0);
    if (unchanged) return { changed: false, update: head.update };
    const candidate: TreeSnapshot = { root, objects: new Map([...snapshot.objects, ...added]) };
    try {
      const result = await client.submitUpdate(tree, head.update, candidate, { ifCurrent: head.update });
      return { changed: true, update: result.update.id };
    } catch (error) {
      // Another update was accepted since the read: read it and try again.
      if (error instanceof ProtocolUpdateConflict && error.result.details.current?.id !== head.update && attempt < RETRIES) continue;
      throw error;
    }
  }
}
