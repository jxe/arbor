# Apps 016: pure plugins

**Why and when:** later, after [Apps 014](apps-014-client-plugins.md). Split from the old
"USL plugins" sketch (Joe, 2026-11-11). Pure plugins extend the data with values, relations
and derived fields. They run identically on host and device: on the host they join a
view's plan, and on the client they cover the part of a view that reads state. A search
box held in `state` can rank rows the client already has only if the ranking runs there.

## Status

**SKETCH · no timing.** Determinism must be guaranteed, not trusted, for anything a plan
caches or a merge relies on, which may mean Wasm.

Joe, 2026-11-11: value types matter most; common ones (dates, relative times, numbers,
durations) should be Beetle built-ins, so plugins carry only the long tail. Search is not a
plugin: when it is needed, Beetle should support what SQLite (FTS5) and Postgres
(`tsvector`, trigram indexes) already do (see [candidates](../candidates.md)). Two-way
relations are parked: no case yet that a stored field or a built-in doesn't cover.

## Kinds, most important first

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

`{p.length}` shows "1h 20m", `where={p.length.minutes < 30}` filters, and a text field
bound to it parses what people type. Dates, money, emails and slugs work the same way.

### 2. Derived fields, for what expressions can't compute

```
table Practice:
  readingTime  Duration = derive readingTime(about)
```

Pure and deterministic, so the host or a client can cache, index and maintain them
incrementally, and views filter and sort on them like stored fields.

### Parked: relations usable in any direction

A plugin declares a relation and which arguments it can solve for (its modes). In a view
or mutation it is a condition that binds whatever is free:

```
<PracticeCard p={p} for={p in Practice} where={slug(p.name, urlSlug)} />
```

The planner treats a relation like an index with known access paths (Datalog's foreign
predicates). A mode it lacks is a check error, not a slow scan.

## Completion

When a part is decided, it moves into the spec and a build plan. Delete this sketch when
nothing undecided is left in it.
