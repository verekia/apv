# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

apv is a single-page, client-only demo of **Adaptive Probe Volume (APV) global illumination** in Three.js
TSL / WebGPU. You drop in a model, tweak the bake parameters, bake baked-probe bounce lighting into a
sparse adaptive brick structure, then see it applied in real time with a debug view of the bricks and live
bake stats. It is meant to be read and reimplemented — a textbook implementation, not a production tool.

## Development Commands

```bash
bun install
bun dev            # portless apv next dev (Next 16, Turbopack)
bun run build      # static export (output: 'export')
bun run all        # format:check + lint + typecheck + warden — run before considering work done
bun run typecheck  # tsc --noEmit
bun run lint       # oxlint .
bun run format     # oxfmt . (auto-fix)
```

## Architecture

Next.js Pages Router, but really a vanilla-TS app: `pages/index.tsx` dynamically imports `MainView` with
`ssr: false`, and the logic lives in `src/`. The APV maths are split into bake-side and render-side modules
under `src/apv/`:

- **`src/apv/format.ts`** — storage layer: RGBM HDR packing, the `BrickVolume` byte layout
  (serialize/parse, gzip), and `sparseToDense` / `fillVolumeNearest`. Pure typed-array math, no renderer.
- **`src/apv/bake.ts`** — the CPU bake: surface sampling → a one-cell probe **shell**, a `three-mesh-bvh`
  over the triangles, and ray-traced 1-bounce irradiance per probe (sun + ambient + distance falloff).
  `gridResolution()` derives [nx,ny,nz] from the box + spacing.
- **`src/apv/bricks.ts`** — the adaptive brick builder: min/max + occupancy pyramid → top-down octree
  (keep a coarse brick where colour range ≤ `eps`, else subdivide) → pack into atlas + indirection.
  Also `enumerateBricks` / `brickStats` for the debug view and stats.
- **`src/apv/volume.ts`** — the runtime TSL: the two `Data3DTexture`s + uniforms, the `volumeIrradiance`
  sampler node (NEAREST indirection read + trilinear atlas read + RGBM decode), and `ApvLambertMaterial`
  (a `MeshLambertNodeMaterial` whose lighting model adds the GI as indirect diffuse light).
- **`src/apv-scene.ts`** — vanilla WebGPU viewport: GLTF load + material adoption, camera framing, render
  loop, and the debug overlays (bounding-box helper + per-brick wireframe `InstancedMesh`). `installModel`
  is shared by the file drop (`loadModelFromFile`) and the demo scene (`loadSceneObject`).
- **`src/presets.ts`** — the built-in procedural Cornell box demo scene + its recommended bake params,
  auto-loaded on start so there's always something to bake.
- **`src/MainView.tsx`** — the React UI (drop zone, parameters, stats, toggles); drives the scene via the
  imperative functions the scene/volume modules export.

Data flow: drop file → `loadModelFromFile` (swaps each mesh to `ApvLambertMaterial`, frames camera, returns
the exact model bounding box) → `bakeIrradiance` (sparse) → `buildBricks` (BrickVolume) → `applyVolume`
(uploads textures, enables GI) + `showBrickVolume` (debug wireframes) + `brickStats`.

## Conventions & gotchas

- **Bounding box is exactly the model's** (`Box3.setFromObject`) — no manual box inputs.
- **Warden** (`@verekia/warden`, run by `bun run all`) enforces shared config/versions. Keep
  `next`/`react`/`typescript`/`oxfmt`/`oxlint`/etc. at their pinned versions and keep the
  `format`/`lint`/`warden` scripts intact.
- **Formatting/lint**: oxfmt (no semicolons, single quotes, 120 cols, trailing commas) + oxlint.
  `tsconfig` has `noUnusedLocals`/`noUnusedParameters`.
- **TSL gotchas**: `BRDF_Lambert(...)` returns a loosely-typed node — narrow it (`as unknown as
  Node<'vec3'>`) before chaining operators, as `lambertBrdf` does. Node materials pick up
  `InstancedMesh` per-instance colours automatically (used by the brick wireframes).
- **Keep it minimal.** This is a learning demo; prefer clarity over features.

## Few comments, decisions

Comments explain non-obvious _why_, not _what_. Don't narrate the code.
