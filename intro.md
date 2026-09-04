# A universal dynamic material (sorry bret)

*This is the argument for Arbor's intended end state, not a claim that every
part exists today. The local workspace, browser/editor, tree synchronization,
Canopy hosting, profiles/accounts, and headless SQLite query/mutation runtime
are implemented. Executable-document compilation and presentation, hosted
agents, Postgres backing, and portable deployment remain in progress or
specified future work. See [current status](status.md) for the exact boundary.*

Many people have observed that there's room for a successor to Dropbox, or to GitHub, for the agent playgrounds we're all making. The state of the art is a folder of markdown files, maybe some CSVs, maybe a SQLite database — a plain directory that an agent reads with `cat` and searches with `grep`. It works surprisingly well. But three things about it are not ideal.

**The first is sharing and syncing.** There's no good way to hand a subtree of that folder to a collaborator, or to a team, with sensible permissions. And syncing is a real problem even for one person: people run agents locally *and* in the cloud, and they want the same workspace in both places — they need to sync even just with themselves. Git is too heavy and too manual for material that changes with every conversation. Dropbox is too coarse — no history you can reason about, no permissions story fit for agents, no way to share one subfolder under different terms than another.

**The second is the human interface.** Right now humans browse these folders with the filesystem and code editors. That's fine for programmers and miserable for everyone else. The alternative is to move the material into Google Docs or Notion, which have better human surfaces — but they're far worse for the agent use cases: no plain files, no `grep`, walled identity, everything behind an API that wasn't designed for this. So we're forced to choose between a surface that's good for agents and a surface that's good for people.

**The third is containment and scaling.** The web is especially good at this, because it's a kind of universal namespace — everything has an address, and addresses compose. Notion is good at it too, because it encourages hierarchical containment: pages inside pages, workspaces that grow without becoming disorganized. The filesystem has the same virtue in principle. But because agents usually operate on one folder at a time, in practice we end up with an endlessly growing pool of individual project folders, each its own little island, and after a while the pool becomes hard to work with. Nothing gives us one growing, navigable, containable tree.

What I want to show you here is that solving these three problems doesn't just get you a better Dropbox or a better GitHub. It gets you something that could come to replace the web — replace HTML, and websites — with a kind of **universal dynamic material** living in a **shared universal file space**.

The argument runs in three steps. First, a small daemon and protocol turn scattered folders into a shared universal file space, solving sharing and containment; a browser/editor gives that space a human surface. That foundation is the implemented part of Arbor. Second, structured data and code turn it from storage into a dynamic material; the headless data core exists, while document compilation and presentation do not yet. Third, the fully realized material could subsume much of the web's stack: sync subsumes GET, capabilities on trees subsume application-specific auth, content addressing subsumes much CDN work, and publishing approaches saving.

Much of this is an old dream: NFS and AFS let you mount remote filesystems into one local tree, so a lab full of machines saw a single namespace. Plan 9 made everything a file, giving every process its own namespace, and let you compose namespaces. Upspin revived the idea as a global path-shaped namespace (`ann@example.com/photos/vacation`).

Now is the time to realize some of these goals.

# Part 1: A Shared Universal File Space

This part describes the implemented foundation, although some recovery and
administration flows remain unfinished.

Imagine there was a thing with this kind of structure on your disk:

```text
~/workspace/
  projects/
    atlas/               # a little publication I run with two friends
      _index.md
      essays/
        drift.md
        fidelity.md
      submissions/
  reading/
    railton/             # someone else's tree, mounted here read-only
  library/               # a public tree, mounted from a domain name
```

Everything is ordinary files. And imagine a background process — call it arborsync — that watches this tree and does two jobs.

**It handles syncing and sharing.** Take `projects/atlas`, an ordinary folder. It starts as locally browsable files. But I can share it, and arborsync gives it a stable `TreeID` and a canonical URL, uploads its first revision, and begins synchronization. The folder is still at `projects/atlas`, but it now has an identity and a canonical home:

```text
https://garden.example.org/~joe/atlas
arbor://tr_7k3m…               # identity fallback if it moves
```

I can share it as 'private' and use it to sync with my cloud agents. Or, I can give `everyone` read or write access, or share it with specific people or groups. If I share it with Alice, she places the tree wherever it makes sense in *her* workspace:

```text
Joe                              Alice
projects/atlas/                  work/atlas/
             └──── same Arbor tree ────┘
```

Inside Markdown, these are still ordinary link destinations. From the document
`/projects/atlas`, the links look like this:

```md
[Notes](notes)
[Roadmap](../roadmap)
[Drift](arbor://notes.example.org/essays/drift;arbor-key=W1siaWQiLCJ4N2YzcTIiXV0)
```

The first points to a child, the second to a sibling, and the third to another
Arbor tree. The `;arbor-key=` suffix carries the document's durable stable key,
so links can heal after files and directories move.

I have a little CLI tool to manage all this:

```sh
# Share Atlas.
arbor place ~/workspace/projects/atlas arbor://garden.example.org/~joe/atlas

# Place Alice’s Atlas tree in my workspace.
arbor place https://garden.example.org/~alice/atlas ~/workspace/work/atlas
```

**It handles containment.** Firstly, the endless pool of project folders becomes one navigable tree, where everything has a place. You mount a collaborator's tree under `work/`, a public library under `reading/`, an archive off to the side. You can scope an agent to exactly the subtrees its job concerns, and it sees a small tree assembled for it.

That gets us to the level of plain filesystems, but we can do better. At this point, two of the three problems are solved: folders can be shared, and they compose into one navigable tree. The remaining problem is what this tree looks like to a person.

# Part 2 - A Dynamic Material

Filesystems often get messy, whereas Notion, with the *same* hierarchical structure, doesn't so easily. Why? 

* First, a directory in Notion isn't a bare listing; it's a document that *contains* its children, so you can group them under headings, fold the stale ones into a toggle, annotate the important ones. The folder explains itself and is malleable. Arbor does the same for local directories: arborsync always presents complete Markdown, treating the first standalone link to each immediate child as its position and appending ordinary links for children the stored body does not mention. An optional `_index.md` lets you author and persist that arrangement; merely browsing a bodyless directory creates no file.
* Second, page properties mean a subtree of similar pages can become a database: past meeting agendas, say, each with a date and attendees; here that's frontmatter, hardened by an optional `schema.ts` to keep things orderly and allow queries.
* Third, sharing works on subtrees, which nudges people to map subtrees onto human groups and teams and projects. That social mapping keeps hierarchies meaningful as they grow. The same dynamic will happen here.

All this, and arborsync still materializes the workspace as ordinary files on disk, for the pleasure of your agents and editors. `ls` is browsing. `cat` is reading. Writing a file is editing. `grep -r` is search. Nothing about your existing tools breaks.

## A browser that is also an editor

Now, remember the second problem: humans have been reading all this in code editors. Arbor web is a browser that is also an editor — a lot like Obsidian or Notion — but instead of browsing only the HTML web, it browses this space, including local files and remote Arbor trees the reader can access. You can read, write, and edit in place, and the browser is aware of the underlying tree structure and permissions. Immutable revision locators are part of the specification, but Canopy does not currently expose accepted-history browsing or non-current objects.

This browser is a superset of a web browser, because sync is a superset of GET. The web's fundamental verb fetches a document once; if it changes, that's your problem — refresh, poll, or bolt on a websocket. Here the verb is *subscribe*. You can take any remote tree and **add to workspace** to make a durable placement on your own machine.

Now the same workspace works for agents and humans. But it is still mostly a collection of documents. To become a dynamic material, it needs data and behavior.

## Let's put data in it

Structured data belongs in the same tree as Markdown. The reference
implementation supports expanded files, collection files, and SQLite today;
Postgres connections remain planned. There are three intended forms:

**First: plain files plus a schema.** A directory with a `schema.ts` becomes a typed collection over exactly one ordinary backing: many Markdown files whose frontmatter conforms, one `_store.csv`, or one line-oriented `_store.jsonl`:

```ts
// essays/schema.ts
import { z } from "zod";

export const schema = z.object({
  title: z.string(),
  date: z.coerce.date(),
  tag: z.string(),
  status: z.enum(["draft", "published"]).default("draft"),
});
```

This is how Notion turns page properties into a database.

**Second: a real database.** Submissions pile up faster than essays — a few hundred a month, each with review state, notes, and an author to reply to. When frontmatter files stop being fun, drop `_store.sqlite3` into `submissions/`. Arbor Sync opens it, serves the folder's rows from it, introspects its tables to generate types, and watches changes. The folder keeps its path, its page, its schema, and every query pointed at it.

**Third: a connection to a database you already have.** In the specified
Postgres model, an external database enters the tree as a small reference file:

```yaml
# reports/_store.yaml
version: 1
driver: postgres
connection: system:connections/production
schema: public
```

Whether a collection is files, SQLite, or eventually Postgres, it has the same
logical node surface. The complete Postgres child provider and observation
contract are not implemented yet.

## Now put code in it

The checked-in [Supplies example](examples/supplies/README.md) already exercises
the headless SQLite query and mutation runtime. The compiler, React
presentation, automatic activation, native presentation, and Canopy hosting
needed to make a `.tsx` node run at its ordinary location are the next product
slice. The intended authoring surface looks like this:

```tsx
// atlas.tsx
import { useState } from "react";
import { z } from "zod";
import { arbor, query, mutation } from "arbor/data";
import { useQuery, useMutationAction } from "arbor/react";
import { schema as submission } from "./submissions/schema";

const atlas = arbor(".");
const essays = arbor("./essays").children;
const submissions = arbor("./submissions").children;

export const recentEssays = query.many(
  essays,
  z.object({ tag: z.string() }),
  (essay, { input }) => ({
    where: [essay.tag.eq(input.tag), essay.status.eq("published")],
    select: essay.pick("id", "title", "date"),
  }),
);

export const submitEssay = mutation(
  atlas,
  submission.omit({ id: true, status: true }),
  async ({ tx, id, now }, input) => {
    await tx.insert(submissions, { id: id("submission"), ...input, status: "pending", submitted_at: now });
  },
);

export default function ReadingRoom() {
  const [tag, setTag] = useState("governance");
  const list = useQuery(recentEssays, { tag });
  const [, submit] = useMutationAction(submitEssay);
  return <EssayList essays={list} tag={tag} onTagChange={setTag} onSubmit={submit} />;
}
```

In this model Arbor validates every call through the handle's schema, so
`{ tag: string }` is enforced at the execution boundary. It also resolves the
literal tree paths — `./essays`, `arbor://paxmachina.org/inbox` — into reviewed
read and write capabilities so it can re-run affected queries, enforce
permissions, and tell the user what the code can do. The current runtime
implements this for its registered headless handles; compiler-generated
manifests and consent surfaces remain future work.

The design places queries near the data by default. Queries on synchronized
data can run in the reader's Arbor Sync; queries on merely visited trees run at
the host. Authors may also require hosting for controlled egress or secrets.
Stable versioned handles remove the need to hand-design an application REST
API. Local and Canopy-hosted placement of compiled handles is not complete yet.

Once the compiler and presentation work lands, a paragraph linking to a `.tsx`
script will render that component inline as a live island backed by Arbor Sync.
Today the source remains browsable and the headless handles are testable, but
the `ReadingRoom` does not yet simply appear in the page.

This offers similar benefits to a modern web app, but with different tradeoffs:

- **Live components, not pages.** The web's unit of delivery is the page — a finished document. Any actual data is either baked invisibly into markup at render time, or trapped behind the site's private API. Here, data and live components are first class: a typed projection of data can sit inside any page, next to prose. Components are stateful and interactive from the start, and are live against the data they declare: every component is a standing subscription.
- **Security through declaration, not isolation.** The browser's answer to hostile code is the origin sandbox. Browsers isolate code *by site*. That means your data has to live on their site, with their code, under their account system. Here, code arrives with no network and no filesystem. It states what it reads and writes and the runtime enforces that. "this component reads `essays` and appends to `submissions`" -- the write set could just as well name a tree you don't own — `tree("arbor://paxmachina.org/inbox")` — and the consent statement would say so.
- **Isomorphic by construction.** With arbor, there's no server vs client. There's a tree that exists somewhere, and a component that runs against it. The same component can run in the host that owns the tree, or in a reader's arborsync if they have it synced.

## Agents and tools live in the tree

The next planned layer reuses the same compiled query and mutation handles for
AI agents that live in the tree. Authored and Canopy-hosted Arbor agents are not
implemented yet.

Represent an AI agent as a markdown file in the tree. The prompt is the body. The frontmatter sets the model, the tools it can call as well as references to mutations in `.tsx` files, and the extra context it can see as references to queries:

Just add to our file earlier:

```tsx
export const pendingSubmissions = query.many(submissions, (submission) => ({
  where: submission.status.eq("pending"),
  select: submission.pick("id", "title", "body"),
}));

export const acceptSubmission = mutation(
  atlas,
  z.object({ id: z.string() }),
  async ({ tx, now }, input) => {
    const pending = await tx.one(submissions, { id: input.id });
    await tx.insert(essays, { ...pending, status: "published", date: now });
  },
);
```

and we can do this!

```markdown
---
model: claude-fable-5
tools:
  - ./atlas.tsx#acceptSubmission
  - ./atlas.tsx#tagEssay
context:
  - ./atlas.tsx#pendingSubmissions
---

You are atlas's first reader. Review each submission for fit with the
current issue's theme, tag it, and accept or decline it with a short
note to the author.
```

Thusly, agents are versioned via revisions; agents are shareable; agent capabilities are the same computed consent statement as with component's: this agent reads recent essays and can append to the inbox, nothing more. Agent confinement falls out of the mount model: an agent scoped to a subtree simply cannot see or touch anything else.

# Part 3 - What this could do to the web

Put together, the intended system is kind of like the filesystem, kind of like
Notion, and kind of like the web at once: an editable surface everywhere,
agent-native plain files underneath, ordinary relative links nearby, absolute
`arbor://` links across Arbor trees, and lazy access to trees you have not
mounted. The end-state promise is that publishing becomes synchronization
rather than a separate deployment ritual. The current reference
implementation still needs compilation, activation, and hosting work before it
can honestly make that promise for executable documents.

Several other things fall out that the web has always struggled with:

**Multiplayer state comes from the tree.** On the web, making an app
multiplayer often means adding operational transforms or CRDTs, presence
servers, and conflict UX. Here, a component rendered over a shared Arbor tree
can reuse the tree's synchronization and conflict semantics instead of
inventing another data plane.

**Per-app identity can be replaced.** The web makes you an account at every
site, tracked by cookies and authenticated by passwords. Arbor instead grants
access to a stable profile `TreeID`; a reserved Canopy account is claimed by
proving control of that exact identity and yields a device credential; a
separately generated access link remains revocable by its entry. The profile
and account foundation exists, while executable applications do not yet use it
end to end.

**Offline can be the default for placed data.** A placed workspace is
materialized locally, so ordinary documents and supported local queries can
continue without the network. Merely visited remote trees and hosted execution
still depend on their authority.

Consider also what the completed system could do to the web stack — to Next.js
and Vercel and everything around them.

The author-facing goal is no explicit build or deployment step between saving
and publishing: the tree is live, while a host compiles and activates reviewed
artifacts behind that boundary. Components and queries become first-class
entities instead of application-specific glue across a network boundary. Look
at how much glue that could remove:

- **The API layer.** REST routes, GraphQL schemas, route handlers, controllers — all of it existed to move data between a store and a client.
- **API version management.** Deprecation policies, `/v2/` route trees, changelogs begging clients to migrate. Every published query is already a versioned endpoint; hosts patch a version or add one, and old consumers keep working.
- **Client fetch code.** `fetch` calls, serializers, DTOs, loading-state plumbing. A component calls `useQuery` on a typed handle; done.
- **Type plumbing.** The ORM types, the API types, the client types, and the code that tries to keep all three aligned. Here types flow end-to-end from store introspection — the SQLite file's actual schema types the query that types the component's props.
- **Auth middleware.** Sessions, JWTs, refresh tokens, permission checks scattered through handlers. Capabilities on trees replace them wholesale.
- **Cache invalidation.** Read-set subscription is invalidation done automatically. The component re-renders when the data it reads changes.
- **Live-update infrastructure.** Websocket servers, pub/sub channels, polling. Subsumed by sync.
- **Deploy pipelines.** CI-to-CDN, environment promotion, cache purging, preview URLs. Publishing is sync; a "preview environment" is a fork.
- **The CMS/database/file-storage split.** One tree is all three.

There is also a planned adoption bridge. A future portable-deployment tool can
publish the same tree as an ordinary website and as an Arbor tree, crosslinked
with a tag or header such as `<link rel="arbor" …>` or `Arbor-Tree:`. An
Arbor-aware browser could discover the live, editable version while every
legacy browser sees HTML. Static baking and additional live deployment
adapters are specified direction, not current commands.

# Who wants to build this?

There is a working [reference implementation](docs/reference-implementation.md),
an aspirational portable [specification](spec.md), and an explicit account of
[what works now](status.md). But I'm too busy running MAI to turn this into a
startup. Who wants to?

It can definitely become a powerhouse. It's time for a new Dropbox, or GitHub, or Vercel — and this is all of them combined, plus the Notion layer on top. The business models are the proven ones: hosted endpoints and managed Arbor trees, team permissions and audit, and eventually a marketplace of views, scripts, and agents that runs on the same rails. Every company adopting agents is about to hit all three of the problems this essay opened with, at once, this year. If someone builds this, there are definitely lots of ways to make money.


# Appendix A - wire protocol sketch

I've avoided saying how synchronization actually works. Here's the sketch — and it's small.

The wire deals in two planes. **A ref** is one tiny live statement per tree: *TreeID → current root hash*. **Objects** are immutable, content-addressed nodes and blobs: each directory node lists its children by hash, so paths live inside one Merkle graph rather than becoming thousands of separately mutable refs. Four routes cover it:

```text
GET  /.arbor/trees/{TreeID}         # where is the tip?
POST /.arbor/trees/{TreeID}/updates # submit against an accepted base; Canopy accepts or merges
GET  /.arbor/trees/{TreeID}/watch   # tell me when it moves
GET  /.arbor/trees/{TreeID}/objects/{hash} # give me this immutable object
```

When the tip moves, your arborsync fetches the new root and walks only the hashes needed for the subtree it is reading. Access is checked once at the shared-tree boundary; an update names its accepted base and candidate root before Canopy advances or merges the tip. If a subtree needs different access, it is a nested tree with its own tip. Merkle structure is why sync is cheap; recorded read sets are why the right queries re-run.

This split unlocks the whole content-centric networking agenda, almost as a side effect:

- **Anyone can cache objects, trustlessly.** An object is self-verifying — the hash is the name — so it can come from anywhere: your local store first, then LAN peers, then configured mirrors, then the origin. A classroom of students reading the same public tree fetches it from each other.
- **Static publication becomes mechanical.** The proposed `arbor bake` emits a
  tree's refs and objects as plain files for nginx, S3, or GitHub Pages. This is
  not implemented yet.
- **Global caching beats a CDN.** Deploying doesn't exist, and yet cache behavior is *better* than the web's: immutable objects never need invalidation — no purges, no `Cache-Control` guesswork — and the only live data is refs, which are a few bytes. The CDN's hard problem was always invalidation; content addressing deletes the problem.

# Appendix B - materialized views, query language, and a successor to React

The TypeScript/React layer here is a pragmatic choice, but I think we can do better in v2.

**Streaming materialized views.** Today a query re-runs when its read set changes. The better long-term model is queries as standing dataflow — incremental view maintenance, where changes stream *through* queries and out to subscribers as deltas. That's also what makes tree-native streaming (the calls and media above) fully first-class.

**A query language that's statically analyzable.** The Prisma-like builder is familiar, but its handlers are arbitrary JavaScript — the runtime only learns what a query read by running it. A declarative query language over the tree would let the compiler know everything up front. The body is datalog-style clauses: shared `?vars` create joins, `$params` bind arguments, and the return shape is inferred from the join structure:

```text
query RecentEssays(tag: string) {
  essay(path, title, date, authorId: ?a, tag: $tag, status: "published")
  author: person(id: ?a, name, avatar)
}
```

Because the whole body is analyzable, the compiler knows a query's *exact* possible read set — not just declared prefixes — so permissions can be checked before anything runs, hosts can reason precisely about egress, and every query is incrementally maintainable and streamable by construction. Queries compose by calling each other as virtual relations, and the planner pushes predicates down.

**A successor to React.** More declarative than React — a genuine *projection* of data into UI rather than a program that produces one. Ahead-of-time compiled. Deliberately less expressive than JavaScript, with a simpler and more powerful type system, designed only for projecting data into interfaces. No garbage collector. A much smaller language.

The precedents to build on are **Riffle** and **SwiftUI**. From Riffle comes the model: everything, including UI state, lives in the store, and a component is a subscription to a query — UI is literally a materialized view, maintained by the same incremental machinery as the queries above. From SwiftUI comes the view language: value-semantic view trees, identity by structural position, declarative composition without a garbage collector. Where Riffle uses JSX, we'd use something closer to SwiftUI's builders. A component takes a query's result — say, the `RecentEssays` query above — and projects it:

```text
view ReadingRoom(tag: string) {
  let { essay } = RecentEssays(tag)
  Column(spacing: 12) {
    for e in essay {
      Row {
        Avatar(e.author?.avatar)
        Column {
          Text(e.title).headline()
          Text(e.author?.name ?? "anonymous").subdued()
        }
        Spacer()
        Text(relative(e.date))
      }
      .opens(e.path)
    }
  }
}
```

Notice `Column`, `Row`, `Text` — not `div` and `span`. Abstract primitives that each client maps to its own rendering surface, so a future browser doesn't have to implement the DOM. When a component needs state beyond the store, explicit state machines (in the statecharts lineage) are a natural fit:

```text
view SubmitBox() {
  state { Idle; Editing(draft: string = ""); Sending(body: string) }

  Idle           => Button("Submit an essay") { -> Editing() }
  Editing(draft) => Column {
                      TextField(draft)
                      Button("Send") { -> Sending(body: draft) }
                    }
  Sending(body)  => Progress("Sending…")
}
```

Everything here is analyzable ahead of time — the query's exact read set, the view's exact shape, the machine's exact states — so the whole pipeline from a changed file to a repainted pixel can be incremental, typed, and tiny.

And this is how the TSX layer eventually retires. A `.tsx` island needs a JavaScript engine and, behind it, most of a browser engine. In the long run those become click-to-load legacy content — the way Apple retired Flash — while components in this language are simply always live: cheap enough to render instantly, in every client, on every device.

But adoption is the first challenge, and this whole thing already asks for a real shift in mental models about the namespace. Asking people to learn a new language at the same time would sink it. So v1 speaks TypeScript and React, and earns the right to replace them later.

# Credits

Git supplies the mutable-ref/immutable-object split; atproto shows how replaceable domain names can front stable repositories and relays; IPFS demonstrates verifiable blocks over ordinary HTTP; Willow and Earthstar inform path-shaped partial synchronization and capability design. Notion, Anytype, and Tana validate tree-shaped structured content while also showing the cost of walled identity. For the app layer, TanStack Start, Encore, Convex, Astro content collections, and Prisma each contribute a useful idea—explicit compiler boundaries, runtime validation, reactive read sets, schema-over-files ergonomics, and a typed data-client feel. Eve and XSLT are cautions: elegant data/UI systems lose their advantage if ordinary authorship becomes ceremonial.
