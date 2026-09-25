import { expect, test } from "bun:test";
import {
  describeTransitionPayload, encodeProtocolDirectory, hashObject, transitionPayload,
  type ObjectHash, type ProtocolDirectoryEntry,
} from "@overstory/protocol";

function store() {
  const objects = new Map<ObjectHash, Uint8Array>();
  const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
  const file = (text: string | Uint8Array) => put(typeof text === "string" ? new TextEncoder().encode(text) : text);
  const dir = (entries: ProtocolDirectoryEntry[]) => put(encodeProtocolDirectory({ type: "directory",
    entries: [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))) }));
  return { objects, file, dir };
}

const page = (middle: string) => `# Page\n\n${Array.from({ length: 400 }, (_, index) => index === 200 ? middle : `Line ${index} of the page.`).join("\n")}\n`;

test("a file delta reads against its base text and a directory lists its entries by name", async () => {
  const s = store();
  const kept = s.file("kept\n");
  const before = s.dir([{ name: "page.md", file: s.file(page("Old middle.")) }, { name: "gone.txt", file: s.file("bye\n") }, { name: "kept.md", file: kept }]);
  const basis = new Set(s.objects.keys());
  const after = s.dir([{ name: "page.md", file: s.file(page("New middle.")) }, { name: "kept.md", file: kept },
    { name: "notes", directory: s.dir([{ name: "new.md", file: s.file("# Fresh\n\nHello.\n") }]) }]);
  const payload = await transitionPayload(before, after, async (hash) => s.objects.get(hash)!);
  expect(payload.deltas.length).toBeGreaterThan(0);
  const text = await describeTransitionPayload({ before, after, payload, load: async (hash) => basis.has(hash) ? s.objects.get(hash) : undefined });
  expect(text).toContain(`Basis      ${before}`);
  expect(text).toContain(`Candidate  ${after}`);
  expect(text).toContain(`${payload.objects.length} objects, ${payload.deltas.length} delta`);
  expect(text).toMatch(/file \/page\.md \(delta from sha256:[0-9a-f]{12}…/);
  // The delta keeps the shared " middle." suffix, so only the replaced word prints.
  expect(text).toMatch(/\n {2}… \d+ unchanged bytes \(lines 1–202\) …\n {2}- Old\n {2}\+ New\n {2}… \d+ unchanged bytes \(lines 203–402\) …$/);
  expect(text).toContain("  + notes/");
  expect(text).toContain("  - gone.txt");
  expect(text).toContain("  ~ page.md");
  expect(text).not.toContain("kept.md");
  expect(text).toContain("file /notes/new.md (new, 16 bytes)\n  + # Fresh\n  + \n  + Hello.");
  expect(text).toContain("directory /notes (new,");
});

test("a whole binary object is summarized, never printed", async () => {
  const s = store();
  const before = s.dir([]);
  const after = s.dir([{ name: "blob.bin", file: s.file(new Uint8Array([0xff, 0xfe, 0x00, 0x01])) }]);
  const payload = await transitionPayload(before, after, async (hash) => s.objects.get(hash)!);
  const text = await describeTransitionPayload({ before, after, payload, load: async (hash) => hash === before ? s.objects.get(hash) : undefined });
  expect(text).toContain("file /blob.bin (new, 4 bytes)\n  binary");
  expect(text).toContain("directory / (whole, replaces");
  expect(text).toContain("  + blob.bin");
});

test("a directory delta is decoded and listed by name, never printed as CBOR", async () => {
  const s = store();
  const entries = Array.from({ length: 60 }, (_, index) => ({ name: `page-${String(index).padStart(2, "0")}.md`, file: s.file(`# Page ${index}\n`) }));
  const before = s.dir(entries);
  const basis = new Set(s.objects.keys());
  const after = s.dir([...entries.filter((entry) => entry.name !== "page-07.md"), { name: "page-60.md", file: s.file("# Page 60\n") }]);
  const payload = await transitionPayload(before, after, async (hash) => s.objects.get(hash)!);
  expect(payload.deltas.map((delta) => delta.result)).toEqual([after]);
  const text = await describeTransitionPayload({ before, after, payload, load: async (hash) => basis.has(hash) ? s.objects.get(hash) : undefined });
  expect(text).toMatch(/directory \/ \(delta from sha256:[0-9a-f]{12}…, \d+ instructions, \d+ bytes\)\n {2}\+ page-60\.md\n {2}- page-07\.md\n/);
  expect(text).toContain("file /page-60.md (new, 10 bytes)\n  + # Page 60");
  expect(text).not.toMatch(/[\u0000-\u0008]/);
});

test("an empty payload between equal roots describes only its endpoints", async () => {
  const s = store();
  const root = s.dir([{ name: "a.md", file: s.file("A\n") }]);
  const text = await describeTransitionPayload({ before: root, after: root, payload: { objects: [], deltas: [] }, load: async (hash) => s.objects.get(hash) });
  expect(text.split("\n")).toEqual([`Basis      ${root}`, `Candidate  ${root}`, "0 objects, 0 deltas"]);
});
