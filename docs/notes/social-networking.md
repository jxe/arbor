# Social networking on Arbor
*A thought experiment: if Arbor were ubiquitous and the wire were lowered to a transport peer of TCP and UDP, what would remain of a protocol like atproto — and how would you build something like Bluesky? Companion to [spec/04-wire.md](../../spec/04-wire.md) and the prior-art notes in [spec.md](../../spec.md).*

## The relationship to atproto

atproto and Arbor share a skeleton: DNS names resolving to a stable identity plus a movable endpoint (handle → DID → PDS ≈ domain → `TreeID` → endpoint hints); signed Merkle repositories of content-addressed records; identity decoupled from hosting; a sync protocol that moves diffs. The wire section could describe an atproto repo with a thesaurus.

But the defaults are inverted on every axis that matters. atproto is constitutionally public — the firehose works *because* every repo is world-readable, and private data remains its acknowledged open problem; Arbor is capability-gated from the first byte, and public is the degenerate case of a grant. An atproto repo is single-writer — one DID signs it, and there is no shared-document story; Arbor's center of gravity is Arbor trees, grants, and merges. atproto records are small lexicon-schema'd JSON built for global aggregation; Arbor nodes are files, documents, and databases built to be worked in. And atproto's crown jewel is the layer Arbor deliberately lacks: relays and AppViews, the big-world aggregation that gives the network a single queryable timeline.

So neither obviates the other today: atproto is a broadcast medium; Arbor is a workspace medium that can also broadcast. The question this note asks is what happens when the substrate assumption flips.

## The premise

Assume Arbor is ambient: every person and service has a workspace, public trees are as common as websites, and the wire's four verbs — ref, obj, push, watch — run at the transport layer, where refs map to streams, watch to push, and immutable objects dedupe, multicast, and prefetch below the application entirely.

Most of atproto's bespoke surface exists because it had to build its own substrate: XRPC for APIs, firehose framing for change streams, lexicon distribution for schemas, the feed-generator protocol for custom feeds. Under the premise, each collapses into a tree, a watch, or a query — and the network's remaining job becomes *content and services*, not protocol.

## The mapping

**The relay/firehose becomes a tree someone maintains.** A relay is a service that watches many public trees and materializes what it sees into its *own* public tree — an append-heavy, database-backed collection of "everything new across the trees I follow." Consumers don't speak a firehose protocol; they mount the relay's tree and watch it like anything else. Lowered to the transport, this gets cheap in a way the firehose famously isn't: refs are the only live bytes, immutable objects dedupe and multicast below the application layer, and the cache cascade (LAN peers, mirrors) absorbs fan-out. The firehose's bandwidth problem — every consumer drinks everything — is exactly the shape content-addressed multicast solves.

**The AppView becomes a Postgres-backed folder plus hosted queries.** An AppView is a big index with a hand-built API. Here it is a tree with a Postgres `_store.yaml` descriptor, maintained by a crawler, whose read surface is upstream-hosted queries — automatically versioned APIs with server-side read-set tracking pushing invalidations over watch ([executable documents](../../spec/07-executable-documents.md)). Nobody designs the timeline API; it is a byproduct of writing the timeline query. The timeline UI is an executable document in a tree that any compatible client renders with a computed consent sentence.

**Lexicons become `schema.ts` in a public tree.** Shared record shapes are schemas everyone mounts; typegen flows to every client automatically. (Schema evolution stays hard — Arbor open problem #6 wearing atproto's clothes.)

**Posting, likes, follows — unchanged in shape, simpler in mechanism.** atproto got this right: every social edge lives in the *author's* repository, and indexers assemble the graph. That maps one-to-one — a post is an append to your public microblog collection; a like is a record in your tree naming theirs by global name. What disappears is the special machinery around it.

**Feed generators become published queries.** Today a custom feed is a whole service speaking a skeleton-fetch protocol. Here it is one deterministic query over the index tree — hosted, versioned, subscribable. Probably the single largest simplification ratio in the mapping.

**Labelers become annotation trees.** Third-party moderation is a tree of `(subject, label)` records you choose to mount; clients join it against content at render time. Reader-wins rendering makes label application natural rather than adversarial, and trust preferences live under `system:` where they belong.

"Something like Bluesky" therefore shrinks to: one schema tree, some index services that publish trees and host queries, and client scripts. The social network becomes *an app in the namespace* rather than a protocol with its own stack.

## What is irreducibly left

1. **Identity recovery and rotation.** Person profiles have a deliberately
   minimal self-certifying identity key, but atproto's fuller DID layer —
   rotation keys, recovery windows, PLC — remains real work Arbor has not done
   and is open problem #1. This is the piece of atproto worth importing
   wholesale rather than reinventing when the permanent single-key generation
   is replaced.
2. **The economics don't simplify.** Someone still crawls the world and hosts a planet-scale index. Arbor makes the *interfaces* nearly free; it does nothing about the *operational* weight, which is most of what running a relay actually is.
3. **Discovery and bootstrap.** Which trees exist? Which relays are honest? Directory services are still needed — the deferred "discovery indexes as mountable Arbor trees" stops being deferrable the day someone builds this.
4. **Derived-state trust.** An AppView's index is unverifiable aggregation — you trust the indexer, in both worlds. Arbor open problem #11 (upstream-hosted results are not client-verifiable the way objects are) is the same wound in different skin.
5. **Moderation policy** — social, not technical; no substrate change touches it.

## Before ubiquity: the bridge

None of this requires waiting for the premise. An atproto bridge fits the same place as a git bridge in the [portable-deployment direction](../../plans/roadmap.md#milestone-4--portable-deployment): expose a PDS repository as a read-only visited tree — both sides are signed Merkle structures, so the mapping is mechanical — and publish a public Arbor subtree's changes as atproto records so it appears in that network's feeds. The same pattern as the deploy crosslinks: meet the existing network where it lives instead of asking it to move.

## The point

atproto is what this design space looks like when built as a *protocol stack for one application shape*. Ubiquitous Arbor turns everything above identity and indexing into ordinary content. The symmetry with the Chromebook line in [intro.md](../../intro.md) is deliberate: just as Arbor supersedes the web stack from below rather than piling on top of it, it would reimplement the social network as *material* rather than as machinery.
