# Apps 014: client plugins

**Why and when:** later, after [Apps 015](../soon/apps-015-the-view-language.md) and
alongside [Apps 011](../soon/apps-011-widgets-in-story.md). Joe, 2026-11-11: the plugins
that matter most run on clients and make Beetle apps faster and more flexible: games,
simulations, anything that changes every frame. Beetle has no general-purpose code
([Beetle](../../docs/overstory-spec/1.5-beetle.md)); real code is never mixed into a
`.beetle` file. Plugins that run on both sides are [Apps 016](apps-016-pure-plugins.md),
and host-only ones are [Apps 017](apps-017-host-plugins.md).

## Status

**SKETCH · no timing.** Direction agreed with Joe on 2026-11-11 (below). Open: TypeScript
in JavaScriptCore first (Story gets JSC for Apps 011) or Wasm from the start, and the
questions at the end.

## The shape

Games call it entity-component-system, and Beetle already has most of it:

- **Session tables are the world.** A plugin's state is rows of `session` tables
  ([Beetle §3.9](../../docs/overstory-spec/1.5-beetle.md#39-state)), which never leave the
  device. Every part of the view can read them, like any rows.
- **Beetle views draw it.** Plugins never draw. A built-in `Canvas` element (and later
  `Canvas3D`) takes shapes as children, drawn from rows like any element:
  `<Circle for={b in Ball} x={b.x} y={b.y} r={4} />`.
- **A client plugin is a mutation written in code.** It reads what it is given and writes
  only session tables. It is called as an action, so the event lines views already have
  drive it ([Beetle §3.10](../../docs/overstory-spec/1.5-beetle.md#310-actions-forms-and-events)):

  ```
  use "plugins/physics.ts" (step, launch)

  session table Ball:
    x   Number
    y   Number
    vx  Number
    vy  Number

  view():
    every 16ms → step(Ball, Paddle)
    on key "space" → launch(Ball)
    <Canvas width={400} height={300}>
      <Circle for={b in Ball} x={b.x} y={b.y} r={4} />
    </Canvas>
  ```

- **Anything lasting goes through ordinary actions.** Saving to a `my` table or writing
  shared rows is a Beetle mutation, which a plugin may call like any action (a score, a
  checkpoint), at human rates. A plugin itself never writes `my` or shared tables, so
  per-frame writes never sync and a host never runs or trusts plugin code.

Physics, game AI, pathfinding and procedural animation all fit: they are code over rows
that a view draws.

## Open questions

- **Writing `my` tables.** Joe 2026-11-11 meant session; whether a plugin may ever write a
  `my` table directly (a checkpoint without a mutation) is open.
- **What a plugin sees.** Probably the tables and values its call passes, plus a frame
  time; no network, no other tables.
- **Sensors and device input** (motion, microphone level): plugin-fed session tables, or
  built-in event lines like `on key`?
- **Canvas vocabulary**: which shapes, text, images and transforms; how hit-testing turns a
  tap on a shape into an action (`<Circle onTap={…}>`).
- **Packaging and loading**: how `use "plugins/physics.ts"` resolves, and how Story and the
  HTML renderer sandbox it; what a client that can't run it shows.

## Completion

When a part is decided, it moves into the spec and a build plan. Delete this sketch when
nothing undecided is left in it.
