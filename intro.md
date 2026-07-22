# A universal dynamic material

*A narrative introduction to Arbor. The names — **Arbor** (the system), **workspace**, **shared tree**, **arbord** (the daemon), **TreeHopper** (the browser — web and native), **the wire** — are all provisional. The consolidated architecture lives in [spec.md](spec.md).*

---

Many people have observed that there's room for a successor to Dropbox, or to GitHub, for the agent playgrounds we're all making. The state of the art is a folder of markdown files, maybe some CSVs, maybe a SQLite database — a plain directory that an agent reads with `cat` and searches with `grep`. It works surprisingly well. But three things about it are not ideal.

**The first is sharing and syncing.** There's no good way to hand a subtree of that folder to a collaborator, or to a team, with sensible permissions. And syncing is a real problem even for one person: people run agents locally *and* in the cloud, and they want the same workspace in both places — they need to sync even just with themselves. Git is too heavy and too manual for material that changes with every conversation. Dropbox is too coarse — no history you can reason about, no permissions story fit for agents, no way to share one subfolder under different terms than another.

**The second is the human interface.** Right now humans browse these folders with the filesystem and code editors. That's fine for programmers and miserable for everyone else. The alternative is to move the material into Google Docs or Notion, which have lovely human surfaces — but they're far worse for the agent use cases: no plain files, no `grep`, walled identity, everything behind an API that wasn't designed for this. So we're forced to choose between a surface that's good for agents and a surface that's good for people.

**The third is containment and scaling.** The web is especially good at this, because it's a kind of universal namespace — everything has an address, and addresses compose. Notion is good at it too, because it encourages hierarchical containment: pages inside pages, workspaces that grow without becoming disorganized. The filesystem has the same virtue in principle. But because agents usually operate on one folder at a time, in practice we end up with an endlessly growing pool of individual project folders, each its own little island, and after a while the pool becomes hard to work with. Nothing gives us one growing, navigable, containable tree.

What I want to show you here is that solving these three problems doesn't just get you a better Dropbox or a better GitHub. It gets you something that could come to replace the web — replace HTML, and websites — with a kind of **universal dynamic material** living in a **shared universal file space**.

This is an old dream with a real lineage. NFS and AFS let you mount remote filesystems into one local tree, so a lab full of machines saw a single namespace. Plan 9 went further: everything was a file, every process had its own namespace, and union mounts let you compose namespaces the way we compose code. Upspin revived the idea as a global path-shaped namespace — `ann@example.com/photos/vacation` — with modern crypto. These systems were right about the shape and wrong about the timing. They offered files without an app layer, in an era when the interesting software was moving into browsers and silos, and they had no sharing or syncing model that ordinary people wanted to use.

Two things have changed. Agents made plain files the universal interface again — the folder of markdown *is* the state of the art, which is exactly the situation the universal-namespace systems were designed for. And local-first sync technology matured: we now know how to give a subtree an identity, a history, and a synchronization stream without a central server owning everything. The window is open. Now is the time.

## Solving the three problems

Imagine there was a thing with this kind of structure on your disk:

```text
~/workspace/
  projects/
    atlas/
      _index.md          # the folder's own body and properties
      notes.md
      app.sqlite3
      atlas.tsx
  reading/
    railton/             # someone else's tree, mounted here read-only
  library/               # a public tree, mounted from a domain name
```

Everything is ordinary files. A markdown file is YAML frontmatter for properties plus a markdown body. A directory is itself a page — its own body and properties live in `_index.md`, so a folder is never just a listing. And imagine a background process — call it arbord — that watches this tree and does three jobs.

**It handles sharing and syncing.** Take `projects/atlas`, an ordinary folder. When I choose **Share this folder**, arbord gives that subtree an independent identity, a revision history, a permission boundary, and a synchronization endpoint. The folder doesn't move; it's still at `projects/atlas`. Only its backing changes. When Alice accepts my invitation, she places the same shared tree wherever it makes sense in *her* workspace:

```text
Joe                              Alice
projects/atlas/                  work/atlas/
             └──── same shared tree ────┘
```

The tree has one identity; each of us controls its placement. And "sharing with myself" is the degenerate case and the everyday one: the same mechanism syncs my workspace between my laptop and the cloud machines where my agents run. Every device and every agent sees the same live tree.

Sharing also turns out to solve naming — the moment a folder becomes a shared tree, everything inside it gets a stable global address. That deserves its own section, just below.

**It handles containment.** Because shared trees mount anywhere, the endless pool of project folders collapses into one navigable tree where everything has a place. You mount a collaborator's tree under `work/`, a public library under `reading/`, an archive off to the side. You scope an agent to exactly the subtrees its job concerns — it sees a small tree assembled for it, and nothing else exists for it. You hand off or archive a subtree as a unit, with its history attached.

It's worth being honest that plain filesystems don't actually stay orderly — they tend toward mess — and that Notion, with the *same* hierarchical structure, somehow doesn't. The difference is three small affordances, and this design keeps all of them. First, a directory in Notion isn't a bare listing; it's a document that *contains* its children, so you can group them under headings, fold the stale ones into a toggle, annotate the important ones — the folder explains itself. Here that's exactly what `_index.md` is for. Second, page properties mean a subtree of similar pages quietly becomes a database — past meeting agendas, say, each with a date and attendees — without anyone declaring one; here that's frontmatter, hardened by an optional `schema.ts` when the pattern matures. Third, sharing works on subtrees, which nudges people to map subtrees onto groups — the team's tree, the project's tree — and that social mapping keeps the hierarchy meaningful as it grows. The same dynamic will happen here, because shared trees *are* the unit of sharing. The tree grows for years without becoming a junk drawer, for the same reason Notion workspaces and the web itself can: hierarchy plus addresses, plus folders that carry their own explanations.

**It presents everything as real files.** Arbord materializes the workspace — including mounted trees — as ordinary files on disk, because agents and editors assume them. `ls` is browsing. `cat` is reading. Writing a file is editing. `grep -r` is search. Nothing about your existing tools breaks.

That's the whole trick for the three problems: one local tree; independent shared trees wherever synchronization, history, or permissions need a boundary; and an arbord that keeps it all materialized as plain files.

## Claiming your place in the global namespace

The web's great invention was the URL — one universal way to name things, so that any document can point at any other — and the moment a folder becomes a shared tree, it joins that tradition: every file and folder inside it has a stable global name, the tree's identity plus a path. You claim your place in the global namespace the way you always have, with a domain. Publish one DNS record and your name resolves to your endpoint and your tree:

```text
notes.example.org
  → endpoint=https://arbor.example.org
  → tree=tr_7k3m…
```

From then on, `notes.example.org/essays/drift.md` is a real address that anyone's browser or agent can resolve — and no hosting company owns your namespace, because the name is yours and the endpoint behind it can move without the name changing.

And that record is the *entire* ceremony. There is no registry to enroll in, no account to create, no platform that can revoke your name — DNS, which you already have, is the only authority involved. Claiming is optional, too: a tree without a domain loses nothing but the pretty rendering of its names.

Private trees have URLs too, and this matters more than it sounds. On the web, naming and access are tangled: an "unlisted" URL is a secret, and linking to something private means moving it somewhere public. Here the name is universal and access is not. A link to a private file is safe to paste into any document — it resolves only for someone holding a grant — so your team can cite, link, and `grep` across private material with the same fluency the public web has.

## One name, many positions

On the web, a document's address *is* its location — where something lives and what it's called are the same fact, which is why reorganizing a site breaks the world's links to it. Here name and position are decoupled, and a subtree can occupy several positions at once:

- **A canonical position** — where the subtree officially lives in the global namespace. Your team's handbook belongs at `team.example.org/handbook`; that's its documented, citable home, the position that exists for everyone.
- **Your local positions** — where *you* mount it. The handbook might sit at `work/handbook` in your workspace, while its style guide alone is also mounted at `desk/style`, next to the draft you're editing. Both are live views of the same tree.
- **Per-agent positions** — when you launch an agent, you can assemble a namespace just for it, in the Plan 9 manner: just the material its job concerns, mounted at whatever paths make that agent's world simplest. The agent sees a small, purpose-built tree; you and your teammates each see your own arrangements; the global namespace sees the canonical one.

Three kinds of position, one identity. Moving something in *your* tree never breaks anyone's links, because links resolve through names, not through your furniture arrangement.

## Now put data in it

Imagine you could put structured data in this tree as easily as markdown. There are three ways, in increasing order of machinery.

**First: plain files plus a schema.** A directory with a `schema.ts` becomes a typed collection over its records — markdown files whose frontmatter conforms, or CSV or JSON rows:

```ts
// essays/schema.ts
import { z } from "zod";

export const Essay = z.object({
  title: z.string(),
  date: z.coerce.date(),
  tag: z.string(),
  status: z.enum(["draft", "published"]).default("draft"),
});
```

This is the Notion move — page properties quietly turning a subtree into a database — made explicit and typed. The records stay ordinary files you can edit by hand; arbord validates them against the schema on change and sync, and violations become diagnostics, not crashes.

**Second: a real database, by placement.** When a collection outgrows one-file-per-record, drop `_store.sqlite3` into its folder. That's it — that's the whole configuration. Arbord opens it through the SQLite driver, serves the folder's rows from it, introspects its tables to generate types, and watches committed changes. The folder keeps its path, its page, its schema, and every query pointed at it — the backing changed, nothing else did. The file remains canonical: you can still open it with any SQLite tool, back it up by copying it, and sync it to another machine like any other file in the tree.

**Third: a connection to a database you already have.** An external database enters the tree as a small reference file:

```yaml
# reports/_store.postgres
driver: postgres
connection: system:connections/production
schema: public
```

The secret lives in your platform credential store; the file in the tree is safe to sync and share. The Postgres server stays the authority for its data — the tree carries the *reference*, and each device supplies its own credentials.

Three backings, one surface. Whether a collection is files, SQLite, or Postgres, it's the same kind of node in the same tree, queryable the same way, and inspectable with the ordinary tools appropriate to its store.

And because the surface is the same, you can move between backings at any time with few or no consequences for anyone using the data. The essays folder that started as markdown files becomes a SQLite database the day it hits ten thousand records; the SQLite database graduates to Postgres when a team starts hammering it. The collection keeps its path, its schema, and its place in the tree — so every query, component, and agent pointed at it keeps working, and nobody downstream has to know the storage changed. Compare that to the web-stack version of the same migration, which is a rewrite of every layer that touched the old store.

## Now put code in it

Code is where the web gets awkward, and it's worth being precise about why. HTML was a document format that had an application platform grafted onto it: a modern web app is a JavaScript program fighting a document tree into behaving like an interface, with the actual data either baked invisibly into markup at render time or trapped behind the site's private API. And the browser's security model is a particular bargain. It will run any stranger's code instantly — that's the web's miracle — and in exchange it isolates that code *by site*. Which means your data has to live on their site, with their code, under their account system; and within its origin the code can do nearly anything, including watching everything you type and sending it home. Origin isolation is what made instant apps possible. The price is that the author owns the data, the presentation, and the relationship, and you own a cookie.

Those were defensible compromises for the world that produced them. But they are compromises, and once the data lives in a tree that belongs to the reader, a different set becomes available. This design chooses:

- **Components, not pages.** The web's unit of delivery is the page — a finished document. Here it's the component: a typed projection of data that sits inside any page, next to prose, and composes like code, because it is code.
- **Dynamic-first.** The web is static-first, twice over: markup arrives dead, so live data has to be bolted on with scripts — and so does basic interactivity, which is why every site reinvents tabs, toggles, and drag-and-drop in JavaScript. Here components are stateful and interactive from the start, and live against the data they declare: every component is a standing subscription, and a page that never changes is just the limiting case.
- **Data as its own layer.** The web has no data layer — data arrives baked into markup or hides behind each site's private API. Here the data is the tree itself, typed and addressable, and components say exactly which parts of it they project.
- **Security through declaration, not isolation.** The browser's answer to hostile code is the origin sandbox: a silo in which code can do anything, to whatever lives in the silo. Here code arrives with no ambient capabilities at all — no network, no filesystem — and states what it reads and writes; the runtime enforces the statement and can show it to you before anything runs.
- **Isomorphic by construction.** The web backed into this idea through SSR and hydration — the same component rendering on a server, then coming alive in the browser — and it works, but as a retrofit: code is still scoped to host environments (Node here, browser V8 there), carved up by bundler heuristics and `"use server"` directives, with every framework re-deriving the seams. Here that discovery is the founding model instead. JavaScript is scoped by *realm* — UI, query, mutation — not by host, and the compiler places each realm where it should run. One file holds a component and its operations; the same typed handler runs in your own arbord, against your copy of the data, or at the upstream host; rendering can begin in one place and continue in another.

Concretely: a script is an ordinary TypeScript/React `.tsx` file in the tree, next to the data it operates on, colocating components with typed queries and mutations:

```tsx
// atlas.tsx
import { useState } from "react";
import { query, mutation, tree } from "arbor/runtime";
import { useQuery, useMutation } from "arbor/react";
import type { Submission } from "./submissions/schema";

export const recentEssays = query(async ({ tag }: { tag: string }) => {
  return tree("./essays")
    .filter(essay => essay.tag === tag && essay.status === "published")
    .sortBy(essay => essay.date, "desc")
    .take(20);
});

export const submitEssay = mutation(async (submission: Submission) => {
  return tree("paxmachina.org/inbox").append(submission);
});

export default function ReadingRoom() {
  const [tag, setTag] = useState("governance");
  const essays = useQuery(recentEssays, { tag });
  const submit = useMutation(submitEssay);
  return <EssayList essays={essays} tag={tag} onTagChange={setTag} onSubmit={submit} />;
}
```

`query` and `mutation` are explicit compiler boundaries — and notice what *isn't* there: no validator, no schema ceremony, no declared read list. Arbor already requires a compiler to split code across realms, so the compiler earns its keep. It generates runtime validation from the TypeScript parameter types, so `{ tag: string }` is enforced at the execution boundary, not just at typecheck time — and where a parameter's type comes from a Zod schema, like `Submission`, that schema is reused directly. It also collects the literal tree paths — `./essays`, `paxmachina.org/inbox` — as the query's read set and the mutation's write set; you only declare `reads`/`writes` explicitly when a path is computed. The function you write is just a typed function.

A query is a deterministic function of the tree snapshot plus its validated input — determinism is what makes the isomorphism real, because the same handler must mean the same thing wherever it lands. The default placement follows the data. Trees you've synced run their queries in your own arbord: private, offline-capable, free for the host. Trees you're merely visiting run their queries at the host that owns them: whoever holds the data hosts its queries, and you never sync a tree just to ask it something. (An author can also force hosting, for queries that must control egress or touch secrets.) Hosted placement carries real advantages. The host controls how much data comes down — the query *is* the egress policy. The host can fix a security problem in a query immediately, without waiting for every reader to sync new code. And versioning happens automatically: each published query is a stable, versioned endpoint — identified by its code — so the host can patch a particular version in place while old consumers keep working, or publish a new version alongside it. Nobody sits down to design a REST API; the API is a byproduct of writing queries.

Either way, the reactive contract is the same: the runtime records what each query actually read, and when any change — local edit or synced revision — intersects that read set, the query re-runs and the UI updates. A mutation is the write-side twin: validated code running against declared write prefixes, producing ordinary file changes or store transactions that land in the tree's revision history.

That example is the compromise list made concrete. These are **explicit data-driven components** — a superset of HTML — kept alive by the runtime, at the price of a compiler and a schema-aware tree underneath. The security stance has its own price, paid differently than the origin sandbox pays it: a handler gets no ambient capabilities, not even a clock, so some programs are more awkward to write here than in a free-for-all origin. What that buys is consent as a computed sentence — "this component reads `essays` and appends to `paxmachina.org/inbox`" — with enforcement making the sentence true. Still instant, still anyone's code. But shaped for a world where the data is yours and the code is what travels to you.

## Agents and tools live in the tree

Here's where it gets interesting for the agent playgrounds we started with. A chat agent is just a markdown file in the tree. The prompt is the body. The frontmatter carries the model, the tools it can call — references to mutations in `.tsx` files — and the extra context it can see — references to queries:

```md
---
model: claude-fable-5
tools:
  - ./editorial.tsx#submitEssay
  - ./editorial.tsx#tagEssay
context:
  - ./editorial.tsx#recentEssays
---

You are the reading-room editor. Review each submission for fit
with the current issue's theme, tag it, and file it in the inbox.
```

Because an agent is a node in the tree, everything the tree gives you, it gives your agents. Agents are versioned — every prompt edit is a revision. Agents are shareable — mount a colleague's agent into your workspace and it runs against *your* view of the tree, under *your* permissions. Agents are legible — their capabilities are the same computed consent statement as any component's: this agent reads recent essays and can append to the inbox, nothing more. And agent confinement falls out of the mount model: an agent scoped to a subtree simply cannot see or touch anything else.

The prompt, the tools, the data, and the UI are all files in one tree, editable with the same motions.

## A browser that is also an editor

Now, remember the second problem: humans have been reading all this in code editors. So imagine a web browser that is also an editor — a lot like Obsidian or Notion — but instead of browsing the HTML web, it browses this universal space. Call the first one TreeHopper.

Every page is editable, including every directory — a folder isn't a listing, it's a page with its own body and properties that happens to contain other pages. A paragraph containing a link to a `.tsx` script renders that script's component inline, as a live island backed by arbord: the `ReadingRoom` above just *appears* in the page, running against the reader's tree. Every page has a source view, because underneath it's still a file. Cmd+P jumps by path, by public name, or by full-text search over your whole materialized workspace — including everything mounted into it.

This browser is a strict superset of the web browser, and the claim rests on two supersets underneath it:

**Sync is a superset of GET.** The web's fundamental verb fetches a document once; if it changes, that's your problem — refresh, poll, or bolt on a websocket. Here the fundamental verb is *subscribe*: opening a page means syncing it, and a page that never changes is just the degenerate case — a tree you're following at a pinned revision. Browsing an unfamiliar public name creates a transient mount; content arrives lazily; if you care, "add to workspace" makes it permanent. Back/forward returns you to the revision you actually saw, and "changed since you read it" is a visible state instead of a silent replacement.

**Data-driven components are a superset of HTML.** The pages you browse aren't frozen render output; they're material — data plus the declared code that projects it — and your browser holds both, so it can re-project at any moment.

So the browser inherits the web's reach — links, public names, lazy loading of things you don't have — while adding what the web never had natively: editing, offline, and liveness.

## What you get

Put together, you have something that is kind of like the filesystem, kind of like Notion, and kind of like the web at once. An editable surface everywhere, agent-native plain files underneath, links that are just paths, public names via DNS, and lazy access to trees you haven't mounted. **And deploying doesn't exist as a step**: save a file and it is live, immediately, for everyone the tree is shared with — because publishing is just sync.

Several other things fall out that the web has always struggled with:

**Multiplayer apps come for free.** On the web, making an app multiplayer is a rewrite: operational transforms or CRDTs, presence servers, conflict UX. Here, any component rendered over a shared tree *is* a multiplayer app, because synchronization is the substrate, not application code. The `ReadingRoom` above is multiplayer the moment its essays folder is shared.

**Auth, login, and cookies are replaced.** The web makes you an account at every site, tracked by cookies, authenticated by passwords. Here there are no per-app accounts: "logging in" is accepting an invitation, which mounts a tree and stores a credential. Your identity is your workspace plus your credential store. Access is a property of trees and grants, not of sites and sessions — and revocation is a change to a grant, not a hunt through settings pages.

**Customization replaces browser extensions.** The web renders the author's frozen output; changing it means fragile extensions scraping the DOM. Here, rendering is reader-wins: you can override the view on anything you've mounted, and your override is just another script in your tree. Authors propose presentation; readers dispose.

**Forking is native.** Annotate a read-only tree and your edits become an overlay — local files shadowing the source, upstream untouched. "Propose upstream" is a diff of your overlay. Fork, annotate, and pull-request are the same primitive, and they work on *everything* in the space, not just code.

**Offline is the default.** Your workspace is materialized locally and queries over it evaluate locally, so the network's absence degrades liveness, not function. (Upstream-hosted queries are the exception — offline, they show cached results with visible staleness.)

## The glue that disappears

Now consider what this does to the web stack — to Next.js and Vercel and everything around them.

There's no build step between you and production, because there's no "production": the tree is live. And there are no web frameworks in the current sense, because a component is a first-class entity and a query is a first-class entity, and the framework's whole job was to glue those to each other across a network boundary. Look at how much glue that is:

- **The API layer.** REST routes, GraphQL schemas, route handlers, controllers — all of it existed to move data between a store and a client. Queries and mutations *are* the boundary now; the compiler generates it.
- **API version management.** Deprecation policies, `/v2/` route trees, changelogs begging clients to migrate. Every published query is already a versioned endpoint; hosts patch a version or add one, and old consumers keep working.
- **Client fetch code.** `fetch` calls, serializers, DTOs, loading-state plumbing. A component calls `useQuery` on a typed handle; done.
- **Type plumbing.** The ORM types, the API types, the client types, and the code that tries to keep all three aligned. Here types flow end-to-end from store introspection — the SQLite file's actual schema types the query that types the component's props.
- **Auth middleware.** Sessions, JWTs, refresh tokens, permission checks scattered through handlers. Capabilities on trees replace them wholesale.
- **Cache invalidation.** The famous hard problem — as application code, it's gone. Read-set subscription is the invalidation.
- **Live-update infrastructure.** Websocket servers, pub/sub channels, polling. Subsumed by sync.
- **Deploy pipelines.** CI-to-CDN, environment promotion, cache purging, preview URLs. Publishing is sync; a "preview environment" is a fork.
- **The CMS/database/file-storage split.** One tree is all three.

Each piece of glue was a real necessity of the web's architecture. Change the architecture and the necessity evaporates.

## The wire

I've avoided saying how synchronization actually works. Here's the sketch — and it's small.

The wire deals in two planes. **Refs** are tiny, live statements from a tree's authority: *(tree, path) → current root hash*. **Objects** are immutable, content-addressed nodes and blobs: each directory node lists its children by hash, so every folder is a Merkle root. Four routes cover it:

```text
GET  /tree/{treeID}/ref/{path}      # where is the tip?
GET  /obj/{hash}                    # give me this immutable object
POST /tree/{treeID}/push            # compare-and-swap the tip
GET  /tree/{treeID}/watch/{path}    # tell me when the tip moves
```

When a ref moves, your arbord fetches the new root and walks down, fetching only the child hashes that changed. That Merkle diff is why sync is cheap; the recorded read sets are why the right queries re-run.

This split unlocks the whole content-centric networking agenda, almost as a side effect:

- **Anyone can cache objects, trustlessly.** An object is self-verifying — the hash is the name — so it can come from anywhere: your local store first, then LAN peers, then configured mirrors, then the origin. A classroom of students reading the same public tree fetches it from each other.
- **Static publication is trivial.** `arbor bake` emits a tree's refs and objects as plain files for nginx, S3, or GitHub Pages. A dumb HTTP host becomes a read-only origin.
- **Global caching beats a CDN.** Deploying doesn't exist, and yet cache behavior is *better* than the web's: immutable objects never need invalidation — no purges, no `Cache-Control` guesswork — and the only live data is refs, which are a few bytes. The CDN's hard problem was always invalidation; content addressing deletes the problem.

And there's an adoption bridge hiding here. Since this whole thing is, among other things, a web framework, a tree can also be deployed as an ordinary website — on Vercel, on Cloudflare, wherever. So imagine one tool that deploys both surfaces at once: the same tree becomes a normal website at your URL *and* a shared tree in the global namespace, crosslinked — the website carries a meta tag or header (`<link rel="arbor" …>`, or an `Arbor-Tree:` response header) naming the tree, so an Arbor-aware browser landing on the website silently upgrades to the live, editable, syncing version, while every legacy browser sees plain HTML. You never have to ask anyone to leave the web. Their browser just discovers the better path is available.

This is also, I'd argue, the protocol redo that QUIC and HTTP/3 gestured at. They made the web's semantics faster; this makes most of those semantics unnecessary — the cache-consistency machinery, the conditional requests, the session affinity. It starts above the transport, running over plain HTTP so any host can serve it. But nothing stops lowering it later, and there would be real advantages: refs map naturally onto QUIC streams, watch onto server push, and a transport that understands immutable hashes could dedupe, multicast, and prefetch below the application layer entirely.

Two more consequences worth spelling out:

**Media and calls.** A call or a stream is a node in the tree — its identity, membership, and history live there, and the capabilities that guard the tree guard the call. The media itself flows peer-to-peer between endpoints that the tree has already authenticated, outside the object store. And because databases are first-class citizens of the tree, it would be natural to add protocol methods for streaming — a live stream is just a fast-moving collection, and this becomes especially clean with the streaming materialized views and Datalog direction I'll sketch in the coda.

**Closer to the metal.** There's a broader lineage here — Jonathan Blow and others arguing that the software stack has drifted absurdly far from the machine. Chromebooks were one attempt to simplify: make the browser the OS. But that just crowned the heaviest layer. This is a much better attempt at the same instinct, because instead of piling the OS on top of the web stack, it *supersedes* the stack from below — the filesystem, the sync layer, and the app-delivery layer become one small model. The browser stops being an accidental operating system running megabytes of framework JavaScript to repaint a list; it becomes a native editor plus a small runtime over local data. The tower of indirection compresses.

## Who wants to build this?

I've built a reference implementation over here — the [spec](spec.md), the [build plan](plan.md), and the [browser integration](treehopper-integration.md) are in this repo. But I'm too busy running MAI to turn this into a startup. Who wants to?

It can definitely become a powerhouse. It's time for a new Dropbox, or GitHub, or Vercel — and this is all of them combined, plus the Notion layer on top. The business models are the proven ones: hosted endpoints and managed shared trees, team permissions and audit, and eventually a marketplace of views, scripts, and agents that runs on the same rails. Every company adopting agents is about to hit all three of the problems this essay opened with, at once, this year. If someone builds this, there are definitely lots of ways to make money.

## Coda: what I punted on

I should be honest that the TypeScript/React layer is a pragmatic choice, not the endpoint. A few things I deliberately left for later:

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

Notice `Column`, `Row`, `Text` — not `div` and `span`. The vocabulary is deliberately generic, in the spirit of react-native-web: abstract primitives that each client maps to its own rendering surface, so a future browser never has to implement the DOM to draw components. When a component needs state beyond the store, explicit state machines (in the statecharts lineage) are a natural fit — variants, transitions, and rendering as an exhaustive function of state:

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
