# Time to reinvent the web (and Dropbox, and git, and the Finder, and Next.js)

Everyone who ever wanted to reinvent the web: to make it read-write, to
reinvent databases, to make materialized views and streaming data ordinary,
to finally ship content-addressed networking. This is your time.

An opening like this appears maybe once every twenty years. Something as
foundational as the web doesn't get replaced because someone has a better
idea; it gets replaced when the ground shifts under it. The ground is
shifting now. Everyone is building agent playgrounds, and the state of the
art is a folder of Markdown files, maybe a CSV, maybe a SQLite database,
which an agent reads with `cat` and searches with `grep`. It works
remarkably well. But that folder can't be shared sensibly, it can't follow
you to the cloud agents you also run, and nobody who isn't a programmer
wants to read it in a code editor.

Fixing that properly is the opening. But you have to be clever about it. You
need to give hosting companies like Cloudflare and Vercel a role to play.
You need hobbyists to get excited. And it has to be something that can be
built into Macs and PCs so seamlessly that it just works. Hold all of those
constraints in your head at once and you can see a single system that takes
the place of:

- file sync like **Dropbox** and iCloud Drive,
- version control like **git**, for most of what people use it for,
- file browsers like the **Finder** and Windows Explorer,
- malleable hierarchical workspaces like **Notion** and Obsidian,
- web frameworks like **Next.js** and Remix,
- and, eventually, much of **the web** itself.

The key to all of it is something people have been trying to build since the
'70s and '80s: a universal file system. So let's start there.

# The web is a universal file system, almost

The web *is* a kind of universal file system. Every document has a path, and
paths compose across machines. That's the part it got right. Almost
everything else about it as a file system is bad.

**It has no inodes.** A file system knows a file's identity separately from
its name. You can move a file and everything that pointed to it still finds
it. The web only has names. Relocate something's URL and it's simply gone.

**Its caching is weak.** Since a URL names a *place* rather than *content*,
nobody can tell whether a cached copy is still right. So we built CDNs,
`Cache-Control` folklore, and purge APIs to paper over it.

**Putting things on it is too hard.** Buying a domain and setting up hosting
is fine for a website and absurd for a folder of notes. That's a big part of
why Dropbox and iCloud links exist at all: they're the web's missing "just
put this online" button.

**It's read-only by default.** Publishing something people can read is easy.
Publishing something people can *edit* means building an application, with
accounts, an API, and a database behind it.

**It doesn't include your hard drive.** The universal file system stops at
the edge of web servers. The dream has always been a unique URL for
everyone's hard drive, so your folders are part of the same space as
everything else.

The naive version of that isn't hard: your email address, then a slash, then
a path on your disk. But we can do much better.

# A canonical URL for any folder

Here's the idea. Take any folder on your computer and share it. It gets a
**canonical URL**:

```text
https://garden.example.org/~joe/atlas
```

That URL is readable according to an access list:

- **Everyone.** That's the same as publishing it on the web. A browser that
  has never heard of any of this gets an ordinary HTML page.
- **A set of people, or a group.** Each of them can read, or read and write.
- **Only you.** Which is the easiest way there's ever been to give your cloud
  agents the same workspace you have on your laptop. You sync with yourself.

Under the URL sits a stable identity, the tree's `TreeID`. That's the inode
the web never had. Links between pages carry stable keys too, so a link
heals when its target moves or is renamed:

```md
[Drift](essays/drift.md#overstory-key=id:x7f3q2)
```

That's still an ordinary relative Markdown link. Any Markdown editor follows
it, and searching the tree for `x7f3q2` finds every link to that page.

**Canonical URLs belong to hosts.** A host, called `overstoryd`, does two
jobs. It's the meeting point that synchronizes everyone who has the tree,
and it's a web server that puts the tree's public pages on the web. A host
can be a $5 server you run for your friends, or a professional hosting
company. Because identity lives in the `TreeID` and not in the URL, a tree is
designed to be able to move between hosts: up to professional hosting when
you outgrow your own server, or back down again. (Renaming a URL on the same
host works today; moving between hosts is designed but not built yet.)

**You can go the other way, too.** Any canonical URL you can read, you can
*place* into your own disk, where it stays synced:

```sh
# Share a folder. No audience means private.
story place --access public=read ./atlas https://garden.example.org/~joe/atlas

# Put Alice's tree wherever it makes sense on my disk.
story place https://garden.example.org/~alice/handbook ~/work/handbook
```

So the pieces of your company's internal docs, your team's agent skills, a
public library of reference material, and the shared notes for a project
with two friends can all live in one tree on your disk, permanently synced:

```text
~/workspace/
  projects/
    atlas/          # a little publication I run with two friends
  work/
    handbook/       # my company's docs, placed here, read-write
    skills/         # our team's agent skills, kept in sync
  reading/
    library/        # a public tree from someone else's host
```

Everything there is ordinary files. `ls` is browsing. `cat` is reading.
Saving a file is editing. `grep -r` is search. Nothing about your existing
tools or agents breaks. And instead of an endless pool of disconnected
project folders, you get one growing tree in which everything has a place.
You can scope an agent to exactly the subtrees its job concerns.

**Every tree keeps its history,** much like a git repository: an append-only
log of accepted changes, each pointing at an immutable, content-addressed
snapshot. Unlike git, nobody commits, pushes, or pulls by hand. Edits sync
continuously, and when two people (or a person and an agent) edit the same
page at once, the host merges them block by block and only asks a human
about real conflicts.

This also fixes caching. Every snapshot is a Merkle tree of immutable
objects named by their hashes. Objects never change, so they never need
invalidating, and anyone can serve them: your own disk, a peer on your LAN,
a mirror, a CDN. The only live data is a tiny pointer per tree saying which
snapshot is current. (There's a sketch of the protocol in Appendix A. It
fits on a page.)

# A browser that's also a file explorer and an editor

Files are the right format for agents. People need something better than a
code editor.

Story is a Mac and iPhone app that browses this space, the way a web browser
browses the web. It's also an editor, a lot like Notion or Obsidian, and a
file explorer, a lot like the Finder, with a Share button on every folder.
You read and write in place, on your own trees, your friends' trees, and
public trees on other hosts.

Notion stays tidy in a way file systems don't, and it's worth asking why,
because it has the same hierarchy underneath. One reason is that in Notion a
folder *is* a page. It contains its children, so you can group them under
headings, annotate the important ones, and tuck the stale ones away. Story
does the same with ordinary directories: a folder's page is its `_index.md`,
and its subpages show up underneath until you arrange them. Another reason
is that sharing happens on subtrees, which nudges people to map subtrees to
real groups, teams, and projects. That social mapping keeps a hierarchy
meaningful as it grows. Story's sharing works the same way, on trees.

Agents are first-class participants. Your own Claude Code, running on your
own machine, shows up on the page as a collaborator, with an avatar next to
yours and the people you share with. Type `! ` to turn a line into a task,
press ▶, and you can watch it work. Its edits are held and published as one
change you can review, and undo, like anyone else's.

# Put data in it

A folder of similar pages is already almost a database. Think past meeting
agendas, each with a date and attendees in its front matter. Add a
`schema.usl` beside them and it becomes one: a typed collection you can
query, written in a small schema language
([USL](../overstory-spec/11-schema-language.md)):

```text
// essays/schema.usl
model Essay {
  title  Text
  date   Date
  status Status
}

enum Status { draft, published }
```

The backing can be Markdown files with front matter, one CSV, one JSONL
file, or, when the rows pile up, a `_store.sqlite3` dropped into the same
folder. The folder keeps its path, its page, its schema, and every query
pointed at it. Reading a collection never runs code. On a public tree, each
row is a web page too.

# Put little apps in it

Since these trees are on the web anyway, you should be able to put little
apps inside them, right next to the data. That's the next piece being built,
and it's where the security model gets interesting.

The web's answer to hostile code is the same-origin sandbox: code is trusted
or distrusted *by site*. That's why your data has to live on the app's
site, under its account system, behind its private API. And it's why
combining data from two sources is a nightmare of CORS, OAuth, and API keys.

Here, code arrives with no network and no file system. Instead it states
what it reads and writes, in terms of trees, and the runtime enforces
exactly that. "This component reads `essays` and appends to `submissions`."
The write set can just as easily name a tree you don't own, such as another
community's public inbox, and the consent statement would say so. Since
access is about trees and people rather than domains, an app can fold
together data from many sources safely.

The shape we're aiming for looks roughly like this (the headless query and
mutation runtime underneath it exists today; the component layer is next):

```tsx
// atlas.tsx
const essays = node("./essays").children;
const submissions = node("./submissions").children;

export const recentEssays = query.many(essays, z.object({ tag: z.string() }),
  (essay, { input }) => ({
    where: [essay.tag.eq(input.tag), essay.status.eq("published")],
    select: essay.pick("id", "title", "date"),
  }));

export const submitEssay = mutation(node("."),
  z.object({ title: z.string(), body: z.string() }),
  async ({ tx, id, now }, input) => {
    await tx.insert(submissions, { id: id("submission"), ...input, status: "pending", submitted_at: now });
  });

export default function ReadingRoom() {
  const [tag, setTag] = useState("governance");
  const list = useQuery(recentEssays, { tag });
  return <EssayList essays={list} tag={tag} onTagChange={setTag} />;
}
```

Link to `atlas.tsx` from a page and the component renders there as a live
island. Every query is a standing subscription: when the data changes, the
component updates, because the tree is already syncing. A query on a tree
you've placed runs on your own machine against your local copy; a query on
a tree you're merely visiting runs at its host. It's the same code either
way, so there's no client/server split to design.

And because everyone has a profile, a site doesn't need its own accounts.
Your identity is a tree you control, on a host you choose. Apps grant access
to profiles, the way you share a folder with a person. Nobody builds a login
page.

# Look how much goes away

Put it together and you get something that is part file system, part
Notion, and part web: an editable surface everywhere, plain files
underneath, ordinary relative links nearby, and absolute links across hosts.
Publishing is the same thing as saving.

Now look at what a typical web app is made of, and how much of it was only
ever glue:

- **The API layer.** REST routes, GraphQL schemas, controllers. All of it
  existed to move data between a store and a client.
- **Client fetch code.** `fetch` calls, serializers, DTOs, loading-state
  plumbing. Here a component calls `useQuery` on a typed handle.
- **Type plumbing.** ORM types, API types, client types, and the code that
  keeps them aligned. Here the schema types the query that types the
  component.
- **Auth.** Sessions, JWTs, password resets, permission checks scattered
  through handlers. Here, access rules on trees and profiles you already
  have.
- **Cache invalidation and live updates.** Websocket servers, pub/sub,
  polling. Here, subscription is the default verb, and immutable objects
  never need invalidating.
- **Multiplayer.** CRDTs, presence servers, conflict UX. Here, an app built
  on a shared tree inherits the tree's sync, merging, and presence.
- **Deploy pipelines.** CI to CDN, preview environments, purges. Here,
  publishing is sync.
- **The CMS / database / file-storage split.** One tree is all three.

# Everyone gets a role

The way this wins isn't by one company owning it. It's federated: anyone can
run a host, link to anyone else's trees, and give people on other hosts
access. People own their own profiles. No company can take it over, and
many companies can make money on it. That's the clever part, and it's
deliberate:

- **Hosting companies** host trees, cache immutable objects at the edge, and
  run the queries and apps that need to live near the data. That's the
  Cloudflare and Vercel business, pointed at a better primitive.
- **Hobbyists** can run their own host for their friends on a cheap server,
  write their own client, or build a tiny app inside a tree and share it
  with a link.
- **Operating systems and app makers** can build it in. Story Sync is a
  small background daemon that keeps placed folders synced on your disk,
  which is the kind of thing that belongs in the OS next to the file
  system.

What makes that possible is that it's a protocol, not a product. The
[specification](../overstory-spec/README.md) describes the host's API, the
directory format, links, accounts, access control, and the schema language
in enough detail that there can be other hosts and other Story apps. The
code here is one implementation of each.

# Give it a try

Here's what works today: the Story app for Mac and iPhone; sharing folders
with canonical URLs and access lists; placing other people's trees on your
disk; continuous sync with history and block-level merging; public trees
served to ordinary browsers; profiles and invitation links; your own agents
as visible collaborators; and USL collections backed by files or SQLite.
Moving trees between hosts, live components, and the app security model are
next. The [status page](../../status.md) has the precise boundary.

<!-- TODO: Joe, link to the Mac download, TestFlight, and how to get an account or start a host. -->

**[Get Story](#)**, browse a public tree, or run your own host. If you've
spent years wanting a read-write web, I'd love to hear what you'd build on
it.

# Appendix A: the protocol sketch

I've avoided saying how synchronization works. Here's the sketch, and it's
small.

The protocol deals in two planes. **A ref** is one tiny live statement per
tree: *TreeID → current root hash*. **Objects** are immutable,
content-addressed nodes and blobs. Each directory node lists its children by
hash, so paths live inside one Merkle graph rather than becoming thousands
of separately mutable refs. Four routes cover it:

```text
GET  /.overstory/trees/{TreeID}                # where is the tip?
POST /.overstory/trees/{TreeID}/updates        # submit against an accepted base; the host accepts or merges
GET  /.overstory/trees/{TreeID}/watch          # tell me when it moves
GET  /.overstory/trees/{TreeID}/objects/{hash} # give me this immutable object
```

When the tip moves, your Story Sync fetches the new root and walks only the
hashes it needs for the subtree it's reading. Access is checked once, at the
tree boundary. If a subtree needs different access, it's a nested tree with
its own tip. An update names its accepted base, and the host either advances
the tip or merges.

That split unlocks much of the content-centric networking agenda, almost as
a side effect:

- **Anyone can cache objects, trustlessly.** An object verifies itself (the
  hash is the name), so it can come from anywhere: your local store, a LAN
  peer, a mirror, or the origin. A classroom reading the same public tree
  could fetch it from each other.
- **Static publication becomes mechanical.** A tree's refs and objects are
  just files, so a static host like S3 or GitHub Pages could serve them.
- **Caching gets better than a CDN's.** Immutable objects never need
  invalidation, and the only live data is refs, a few bytes each. A CDN's
  hard problem was always invalidation; content addressing deletes it.

# Appendix B: materialized views, a query language, and a successor to React

The TypeScript and React layer is a pragmatic choice. I think a v2 can do
better.

**Streaming materialized views.** Today a query re-runs when its read set
changes. The better long-term model is queries as standing dataflow:
incremental view maintenance, where changes stream *through* queries and out
to subscribers as deltas.

**A statically analyzable query language.** A builder API is familiar, but
its handlers are arbitrary JavaScript, so the runtime only learns what a
query read by running it. A declarative, Datalog-style query language would
let the compiler know everything up front: shared `?vars` make joins,
`$params` bind arguments, and the result shape follows from the joins.

```text
query RecentEssays(tag: string) {
  essay(path, title, date, authorId: ?a, tag: $tag, status: "published")
  author: person(id: ?a, name, avatar)
}
```

Because the whole body is analyzable, the compiler knows a query's exact
possible read set, so permissions can be checked before anything runs, hosts
can reason precisely about egress, and every query is incrementally
maintainable by construction.

**A successor to React.** More declarative than React: a genuine
*projection* of data into UI, rather than a program that produces one.
Compiled ahead of time, deliberately less expressive than JavaScript, with a
simpler type system and no garbage collector. The precedents are **Riffle**
(everything, including UI state, lives in the store, and a component is a
subscription to a query) and **SwiftUI** (value-semantic view trees,
identity by structural position):

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

Notice `Column`, `Row`, `Text`, not `div` and `span`. These are abstract
primitives each client maps to its own rendering surface, so a future
browser doesn't have to implement the DOM. Everything is analyzable ahead of
time (the query's read set, the view's shape), so the whole pipeline from a
changed file to a repainted pixel can be incremental, typed, and tiny. In the
long run `.tsx` islands become click-to-load legacy content, the way Flash
went.

But adoption comes first, and this already asks for a real shift in how
people think about the namespace. Asking them to learn a new language at the
same time would sink it. So v1 speaks TypeScript and React, and earns the
right to replace them later.

# Credits

Much of this is an old dream. NFS and AFS mounted remote file systems into
one local tree, so a lab full of machines saw a single namespace. Plan 9 made
everything a file and let every process compose its own namespace. Upspin
revived the idea as a global, path-shaped namespace
(`ann@example.com/photos/vacation`).

Git supplies the mutable-ref/immutable-object split. atproto shows how
replaceable domain names can front stable repositories. IPFS demonstrates
verifiable blocks over ordinary HTTP. Willow and Earthstar inform
path-shaped partial sync and capability design. Notion, Anytype, and Tana
validate tree-shaped structured content, while showing the cost of walled
identity. For the app layer, TanStack Start, Encore, Convex, Astro content
collections, and Prisma each contribute an idea: explicit compiler
boundaries, runtime validation, reactive read sets, schema-over-files
ergonomics, and a typed data client. Eve and XSLT are cautions: elegant
data/UI systems lose their advantage if ordinary authorship becomes
ceremonial.
