# Apps 014: client plugins

**Why and when:** later, after [Apps 015](../soon/apps-015-the-view-language.md) and
alongside [Apps 011](../soon/apps-011-widgets-in-story.md). Joe, 2026-11-11: the plugins
that matter most run on clients and make Beetle apps faster and more flexible. Beetle has
no general-purpose code ([Beetle](../../docs/overstory-spec/1.5-beetle.md)); real code
extends what a view can read and draw, never mixed into a `.beetle` file. This plan is the
client half. Plugins that run on both sides are [Apps 016](apps-016-pure-plugins.md), and
host-only ones are [Apps 017](apps-017-host-plugins.md).

## Status

**SKETCH · no timing.** Split from the old "USL plugins" sketch on 2026-11-11. Nothing is
decided beyond the rule below. Open: TypeScript in JavaScriptCore first (Story gets JSC for
Apps 011) or Wasm from the start.

## The rule

A client plugin runs only on the viewer's device and writes only state tables (`session`
and `my` tables, `state`, `keep`), which never leave the device
([Beetle §3.9](../../docs/overstory-spec/1.5-beetle.md#39-state)). Nothing it computes
reaches shared rows except through a mutation the viewer's action calls. So a host never
runs one and never needs to trust one.

## Two kinds

### 1. Sources: live rows in state tables

A source owns the rows of a state table and changes them as fast as it likes. Views that
read the table redraw without a request.

```
session table Ball = source physics.world(gravity: 9.8)
session table Tick = source clock(every: 16ms)
session table Tilt = source device.motion()
```

Physics, game AI, pathfinding, timers, sensors and audio levels are the source's job,
written in a real language. A source declares what it touches (sensors, frame rate), and
that declaration is what consent shows.

### 2. Elements: new element types

A plugin adds an element type drawn natively from its attributes: `<Board>`, `<Chart>`,
`<Map>`, a canvas. Its gestures come back as ordinary actions (`onMove={set(…)}`,
`onDrop={moveCard(…)}`), so writes still go through `set` and mutations. Apps 011's
vocabulary is the built-in set; this lets a plugin add to it.

## Open questions

- Packaging and loading: how a `.beetle` file uses a plugin (`use "plugins/physics.ts"`?),
  and how Story and the HTML renderer load and sandbox it.
- What a source may read: probably its declared inputs and the rows the view already has.
- Fallback where a client can't run a plugin (another renderer, an old Story).

## Completion

When a part is decided, it moves into the spec and a build plan. Delete this sketch when
nothing undecided is left in it.
