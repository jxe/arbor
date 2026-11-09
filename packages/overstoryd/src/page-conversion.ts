import { decodeProtocolDirectory, encodeProtocolDirectory, encodeProtocolPage, hashObject, isPageName, parsePage, treeHoldsPages, type ObjectHash, type ProtocolDirectoryEntry } from "@ovst/protocol";
import { UpdateProtocolError } from "./errors.ts";

type Load = (hash: ObjectHash) => Promise<Uint8Array>;

/**
 * Spec 02 §3: an update that brings page entries into a tree whose basis holds
 * none converts it. A host serves it only with `pages-v1`, and accepts it only
 * when each page replaces a Markdown file of the same name that reads as that
 * page, so converting changes no page. Once the basis holds pages the update
 * is ordinary. `memo` is kept across updates; directory hashes don't change
 * what they hold.
 */
export async function checkPageConversion(basis: ObjectHash, candidate: ObjectHash, load: Load, memo: Map<ObjectHash, boolean>, pages: boolean): Promise<void> {
  if (basis === candidate || await treeHoldsPages(basis, load, memo) || !await treeHoldsPages(candidate, load, memo)) return;
  if (!pages) throw new UpdateProtocolError("unsupported-operation", "This host does not accept page entries (pages-v1)");
  await checkDirectory(basis, candidate, "", load);
}

async function checkDirectory(basis: ObjectHash | null, candidate: ObjectHash, path: string, load: Load): Promise<void> {
  const before = new Map<string, ProtocolDirectoryEntry>(basis ? decodeProtocolDirectory(await load(basis)).entries.map((entry) => [entry.name, entry]) : []);
  for (const entry of decodeProtocolDirectory(await load(candidate)).entries) {
    const old = before.get(entry.name), at = `${path}/${entry.name}`;
    if (entry.directory && entry.directory !== old?.directory) await checkDirectory(old?.directory ?? null, entry.directory, at, load);
    if (entry.page && !(old?.file && isPageName(entry.name) && await readsAs(old.file, entry.page, load))) {
      throw new Error(`A conversion to pages may only replace a file by the page it reads as: ${at}`);
    }
  }
}

async function readsAs(file: ObjectHash, page: ObjectHash, load: Load) {
  const parsed = parsePage(await load(file));
  return !!parsed && hashObject(encodeProtocolPage(parsed)) === page;
}

/**
 * A tree's root with every Markdown file that reads as a page written as that
 * page, and the objects that adds; null when nothing changes. Files whose
 * front matter doesn't parse stay files, and a collection's folder is left as
 * it is. The result passes `checkPageConversion`.
 */
export async function convertedToPages(root: ObjectHash, load: Load): Promise<{ root: ObjectHash; objects: Map<ObjectHash, Uint8Array> } | null> {
  const objects = new Map<ObjectHash, Uint8Array>();
  const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
  const convert = async (hash: ObjectHash): Promise<ObjectHash> => {
    const directory = decodeProtocolDirectory(await load(hash));
    if (directory.collection) return hash;
    let changed = false;
    const entries: ProtocolDirectoryEntry[] = [];
    for (const entry of directory.entries) {
      if (entry.directory) {
        const next = await convert(entry.directory);
        changed ||= next !== entry.directory;
        entries.push(next === entry.directory ? entry : { name: entry.name, directory: next });
      } else if (entry.file && isPageName(entry.name)) {
        const page = parsePage(await load(entry.file));
        changed ||= page !== null;
        entries.push(page ? { name: entry.name, page: put(encodeProtocolPage(page)) } : entry);
      } else entries.push(entry);
    }
    return changed ? put(encodeProtocolDirectory({ ...directory, entries })) : hash;
  };
  const next = await convert(root);
  return next === root ? null : { root: next, objects };
}
