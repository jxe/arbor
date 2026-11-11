# Apps 014: USL plugins

**Why and when:** later. Joe, 2026-11-11: instead of extending UVL, real code
extends the *data*: plugins for USL types, derived and real-time data, and two-way string and
date work, in a real programming language, but never mixed into a `.view` file or standing
in for one. This came after views and mutations moved to the declarative language
([Apps 015](../soon/apps-015-the-view-language.md)); everything a `.view` file can't express
is meant to land here.

## Status

**SKETCH · no timing.** After Apps 015. Nothing here is decided beyond the split itself.

## The sketch (from the thread, 2026-11-11)

Real code extends the *data*, not UVL. A plugin is a TypeScript (or Wasm) module
that USL imports; `.view` and declared mutations only ever see richer types, relations, derived
fields and models. Four kinds, from purest to most effectful:

### 1. Types: values with their own operations

```ts
// plugins/duration.ts
export const Duration = valueType({
  base: "number",                       // stored as seconds
  parse: (s: string) => …,              // "1h 20m" → 4800
  format: (n: number) => …,             // 4800 → "1h 20m"
  fields: { minutes: n => n / 60, hours: n => n / 3600 },
})
```
```usl
use "./plugins/duration.ts"
model Practice { …, length: Duration? }
```
In a view: `{p.length}` shows "1h 20m", `where={p.length.minutes < 30}` filters, a `TextField` bound to it
parses what people type. Dates, money, emails and slugs work the same way.

### 2. Relations: Prolog-like, usable in any direction

A plugin declares a relation and which arguments it can solve for (its *modes*). In a view or
mutation it is just a fact, and it binds whatever is free.

```ts
// plugins/text.ts
export const slug = relation<[title: string, slug: string]>({
  modes: {
    "in,out": (title) => [kebab(title)],          // title → slug
    "out,in": (slug) => [unkebab(slug)],          // slug → a title, for a URL lookup
  },
})
export const dateParts = relation<[date: Date, year: number, month: number, day: number]>({
  modes: { "in,out,out,out": …, "out,in,in,in": … },
})
```
```
<PracticeCard practice={p} for={p in Practice} where={slug(p.name, urlSlug)} />
<Section title={y} for={p in Practice, y in years} where={dateParts(p.created, y, m, d)} />
```
The planner treats a relation like an index with known access paths (Datalog's foreign predicates,
Soufflé functors). A mode it lacks is a compile error, not a slow scan.

### 3. Derived fields and models: computed from rows, maintained by the host

```usl
model Practice {
  …
  readingTime: Duration = derive readingTime(about)          // a pure function of the row
}
model PracticeMatch = derive search.rank(Practice, fields: [name, about])   // a derived model
```
Pure and deterministic, so the host (or Story) can cache, index and maintain them incrementally,
and views can filter and sort on them like stored fields: `orderBy={m.score desc}`.

### 4. Sources: live data a plugin feeds in

```usl
session model Tick = source clock(every: 16ms)                  // a row that changes every frame
personal session model Ball = source physics.world(gravity: 9.8) // a physics engine owns these rows
model Weather = source http.poll("https://…", every: 10min)      // needs a declared network grant
```
A view just reads `Ball` and draws circles. The plugin steps the simulation, so collisions, AI or
pathfinding are its job, written in a real language. Sources are the one kind with effects.
They declare what they touch (clock rate, network hosts), and that declaration is what consent shows.

### Why this split

- `.view` stays pure: every read is still a plan, including reads that go through relations and derived fields.
- Real code lives where it has a clear contract: value in and value out (types, relations, derivations), or rows out (sources).
  It is never interleaved with markup or with authority-bearing mutations.
- One place for the escape hatch. Formatting, two-way parsing, ranking, physics and external data
  all become data that views and mutations already know how to use.
- Plugins are shareable. A `Date` or `search` plugin serves every app, the way USL types do now.

### Open questions

- **Where plugins run.** Pure kinds should run identically on host and device (JSC in Story, the sidecar on the host), or as Wasm in both.
- **Determinism.** It has to be guaranteed, not trusted, for anything the planner caches or merges rely on.
- **Mutations calling services** (send an email). That's probably a fifth kind, *sinks*, run after acceptance.
  It's the mirror image of a source.

## Completion

When a part is decided, it moves into the spec (schema language and apps and views) and a
build plan. Delete this sketch when nothing undecided is left in it.
