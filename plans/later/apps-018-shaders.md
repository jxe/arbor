# Apps 018: shaders

**Why and when:** later, with the `Canvas` element of
[Apps 014](apps-014-client-plugins.md). Joe, 2026-11-11: per-pixel drawing (ripples, glows,
blurs, procedural textures) should fold into Beetle. A shader is the purest code there is
(pixels and values in, a color out, no writes, sandboxed on the GPU), so it is a value an
element draws with, not a plugin kind.

## Status

**SKETCH · no timing.** Proposed to Joe 2026-11-11; he asked for it as its own plan.

## The shape

```
use "shaders/ripple.wgsl" (ripple)

<Canvas>
  <Rect for={b in Ball} width={400} height={300}
    effect={ripple(center: [b.x, b.y], strength: score / 10)} />
</Canvas>
```

- **Uniforms are Beetle values.** Rows, state and session tables feed a shader like any
  attribute, and it redraws when they change.
- **Time.** The renderer gives shaders, and only shaders, a frame time. Views still have no
  clock: nothing a shader computes flows back into data.
- **Three slots**, as SwiftUI (`colorEffect`, `distortionEffect`, `layerEffect`) and the web
  both offer: `fill` (a color per pixel), `distort` (move pixels) and `effect` (sample the
  layer beneath: blur, glow, ripple). `Canvas3D` adds a material slot later.
- **One language, translated per platform.** WGSL: it compiles to Metal for Story and runs
  natively in WebGPU for the HTML renderer.
- **No consent.** A shader reads only what it is given and writes nothing.

## Open questions

- Which uniform types (numbers, vectors, colors, images) and how Beetle values map to them.
- Whether shaders apply outside `Canvas`, to any element.
- Limits: compile time, instruction counts, a fallback when a device can't compile one.

## Completion

When decided, it moves into the spec and a build plan. Delete this sketch when nothing
undecided is left in it.
