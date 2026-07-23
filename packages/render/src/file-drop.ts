import type { BrowserImportEntry } from "./api.ts";

interface WebkitFileEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file(callback: (file: File) => void, error?: (error: DOMException) => void): void;
  createReader(): { readEntries(callback: (entries: WebkitFileEntry[]) => void, error?: (error: DOMException) => void): void };
}

function readFile(entry: WebkitFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readDirectory(entry: WebkitFileEntry): Promise<WebkitFileEntry[]> {
  const reader = entry.createReader();
  const result: WebkitFileEntry[] = [];
  while (true) {
    const batch = await new Promise<WebkitFileEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return result;
    result.push(...batch);
  }
}

async function walk(entry: WebkitFileEntry, prefix: string, result: BrowserImportEntry[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isDirectory) {
    result.push({ path, kind: "directory" });
    for (const child of await readDirectory(entry)) await walk(child, path, result);
  } else if (entry.isFile) {
    result.push({ path, kind: "file", file: await readFile(entry) });
  }
}

export async function importEntries(dataTransfer: DataTransfer): Promise<BrowserImportEntry[]> {
  const result: BrowserImportEntry[] = [];
  const items = [...dataTransfer.items];
  const webkitEntries = items
    .map((item) => (item as unknown as { webkitGetAsEntry?: () => WebkitFileEntry | null }).webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is WebkitFileEntry => entry !== null);
  if (webkitEntries.length) {
    for (const entry of webkitEntries) await walk(entry, "", result);
    return result;
  }
  for (const file of [...dataTransfer.files]) result.push({ path: file.name, kind: "file", file });
  return result;
}
