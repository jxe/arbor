import { describe, expect, test } from "bun:test";
import { encodeProtocolDirectory, hashObject, type ObjectHash, type ProtocolDirectoryEntry } from "@overstory/protocol";
import { rootProfileFacts } from "@overstory/canopyd";

function fixture(frontmatter: string, files: Record<string, Uint8Array> = {}, title = "Profile") {
  const objects = new Map<ObjectHash, Uint8Array>();
  const index = new TextEncoder().encode(`---\n${frontmatter}\n---\n\n# ${title}\n`);
  const indexHash = hashObject(index);
  objects.set(indexHash, index);
  const rootEntries: ProtocolDirectoryEntry[] = [{ name: "_index.md", file: indexHash }];
  const nested = new Map<string, ProtocolDirectoryEntry[]>();
  for (const [path, bytes] of Object.entries(files)) {
    const parts = path.split("/");
    const file = hashObject(bytes);
    objects.set(file, bytes);
    if (parts.length === 1) rootEntries.push({ name: parts[0]!, file });
    else nested.set(parts[0]!, [{ name: parts[1]!, file }]);
  }
  for (const [name, entries] of nested) {
    const bytes = encodeProtocolDirectory({ type: "directory", entries });
    const hash = hashObject(bytes);
    objects.set(hash, bytes);
    rootEntries.push({ name, directory: hash });
  }
  const rootBytes = encodeProtocolDirectory({ type: "directory", entries: rootEntries });
  const root = hashObject(rootBytes);
  objects.set(root, rootBytes);
  return { root, load: async (hash: ObjectHash) => {
    const value = objects.get(hash);
    if (!value) throw new Error(`Missing ${hash}`);
    return value;
  } };
}

describe("profile presentation facts", () => {
  test("accepts bounded card fields and resolves a nested avatar", async () => {
    const source = fixture('type: person\ndisplayName: "  José Arbor  "\ndescription: Builder\navatar: images/me.webp', {
      "images/me.webp": new Uint8Array([1, 2, 3]),
    });
    const facts = await rootProfileFacts(source.root, source.load);
    expect(facts).toMatchObject({ version: 3, type: "person", displayName: "José Arbor", description: "Builder", avatar: { path: "images/me.webp" } });
  });

  test("drops malformed and unavailable card fields without rejecting identity", async () => {
    for (const avatar of ["../x.png", "/x.png", "https://example/x.png", "missing.png"]) {
      const source = fixture(`type: group\ndisplayName: "${"x".repeat(81)}"\ndescription: "${"y".repeat(501)}"\navatar: ${avatar}`);
      expect(await rootProfileFacts(source.root, source.load)).toEqual({
        version: 3,
        type: "group",
        members: [],
        headingTitle: "Profile",
      });
    }
  });

  test("keeps the first H1 as a group directory title without inventing a displayName", async () => {
    const source = fixture("type: group\nmembers: []", {}, "**Garden Club**");
    expect(await rootProfileFacts(source.root, source.load)).toMatchObject({
      type: "group",
      headingTitle: "Garden Club",
    });
    expect((await rootProfileFacts(source.root, source.load)).displayName).toBeUndefined();
  });
});
