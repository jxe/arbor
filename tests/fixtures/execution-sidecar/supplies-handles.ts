// The handles host-collections.test.ts runs in a real execution sidecar: named
// queries over Supplies' lists, one reading a list owner's profile card, and
// Supplies' own createList mutation.
// Supplies' pages import `overstory/react`, which only a page needs, so the
// sidecar process gets a stub of it, as the tests' own process does.

import { plugin } from "bun";
import { join } from "node:path";
import { node, query, type MutationHandle, type QueryHandle } from "overstory/data";
import { z } from "zod";

plugin({
  name: "overstory-react-stub",
  setup(build) {
    build.module("overstory/react", () => ({
      loader: "object",
      exports: {
        Markdown: () => null,
        skipQuery: Symbol("skip-query"),
        useMutationAction: () => [{}, () => undefined, false],
        useNavigate: () => () => undefined,
        useQuery: () => [],
        useUser: () => null,
      },
    }));
  },
});

export const LIST = "10000000-0000-4000-8000-000000000001";

const listName = query.one(node("./data/List").children, (list: any) => ({
  where: list.id.eq(LIST),
  select: list.pick("id", "name", "openToEdits"),
})) as QueryHandle<unknown, unknown>;

const listOwner = query.one(node("./data/List").children, z.object({ id: z.string() }), (list: any, { input }: any) => ({
  where: list.id.eq(input.id),
  select: { id: list.id, owner: list.owner(node("./data/Person").children.pick("id", "name", "handle")) },
})) as QueryHandle<unknown, unknown>;

const myLists = await import(join(import.meta.dir, "../../../examples/supplies/MyLists.tsx"));

export const queries = [
  { ref: { module: "/queries.ts", export: "listName", version: "sha256:listName" }, handle: listName, collection: "/supplies", authoredRoot: "./data" },
  { ref: { module: "/queries.ts", export: "listOwner", version: "sha256:listOwner" }, handle: listOwner, collection: "/supplies", authoredRoot: "./data" },
];
export const mutations = [
  { ref: { module: "/MyLists.tsx", export: "createList", version: "sha256:createList" }, handle: myLists.createList as MutationHandle<unknown, unknown>, collection: "/supplies", authoredRoot: "./data" },
];
