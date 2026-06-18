# APV

A minimal, **textbook implementation of Adaptive Probe Volumes (APV)** for global illumination in
Three.js TSL / WebGPU. Drop in a model, tweak the bake parameters, hit **Bake**, and see baked bounce
lighting applied in real time — with a toggle to draw the adaptive brick volume and live stats from the
bake.

It is deliberately small. The point is to read the code, understand how APV works end to end (bake →
storage → runtime sampling), and port it into your own project.

```bash
bun install
bun dev
```

Then open the app, drag a `.glb`/`.gltf` onto the page, and bake.

## What APV is

Global illumination here is **baked, light-probe-based bounce lighting** stored in a **sparse, adaptive
3D structure** instead of a dense grid.

- Each probe stores the **incoming indirect irradiance** at a point in space — "what colour and how much
  bounced light reaches here", independent of any surface. At runtime a surface reconstructs its bounce
  as `bounceLight = probeColour × surfaceAlbedo` (the diffuse lighting equation), so the same probe
  correctly lights a grey rock, a red wall, or anything that moves through that spot.
- A plain dense grid of probes costs memory proportional to **volume — O(n³)** — and most of it is empty
  air. APV keeps memory proportional to **surface detail** by storing probes in **bricks** of different
  sizes: tiny bricks where the bounce colour changes fast (seams, the base of objects), big cheap bricks
  where it is flat (a large uniform wall), and no bricks at all in empty space.

## How this repo is laid out

The render-side and bake-side maths are split so each is easy to read on its own:

- **`src/apv/format.ts`** — the storage layer: the RGBM HDR packing, the brick-volume byte layout
  (serialize/parse + gzip), and the helpers that turn a sparse bake into the dense field the builder
  reads. Pure typed-array math; start here.
- **`src/apv/bake.ts`** — the bake. Samples the model's surfaces into a one-cell **shell** of probe
  positions, builds a BVH (`three-mesh-bvh`) over the triangles, and ray-traces 1-bounce irradiance per
  probe (sun + ambient + a distance falloff so nearby surfaces dominate).
- **`src/apv/bricks.ts`** — the **adaptive** part: a min/max + occupancy pyramid over the baked field,
  walked top-down to keep a coarse brick wherever the colour is flat within `eps` and subdivide where it
  varies. Packs the chosen bricks into the atlas + indirection textures.
- **`src/apv/volume.ts`** — the runtime: uploads the two textures and samples them in a TSL node graph
  (one NEAREST index read + one trilinear atlas read + an RGBM decode), exposed as a Lambert material
  (`ApvLambertMaterial`) that adds the result as indirect light.
- **`src/apv-scene.ts`** — the WebGPU viewport: loads the model, renders it with the GI material, and
  draws the debug overlays (bounding box + brick wireframes).
- **`src/MainView.tsx`** — the UI (drop zone, parameters, stats, toggles).

## The two textures

Bricks live in two GPU textures, uploaded verbatim from the baked file:

- **Indirection** (small, **NEAREST**) — one texel per "base brick" cell; `rgb` = the atlas slot, `a` =
  level + 1 (0 = empty). It is an index, so it is sampled nearest (you can't blend indices).
- **Atlas** (**LINEAR / trilinear**) — every kept brick packed side by side, `BRICK³` probes each plus a
  1-texel **apron** so hardware trilinear filtering stays correct across brick borders. Probes are stored
  **RGBM** (rgb + a shared multiplier) so HDR bounce fits in 4 rgba8 bytes and still interpolates.

The runtime lookup is therefore just two texture reads and a little address math per fragment — see the
`volumeIrradiance` node in `src/apv/volume.ts`. It depends only on world position, so for low-poly meshes
you can wrap it in TSL's `varying()` to evaluate it per-vertex instead.

## Parameters

Bake-time (require re-baking):

| knob               | what it does                                                           |
| ------------------ | ---------------------------------------------------------------------- |
| `Probe spacing`    | finest probe spacing in world units — the most detail a brick can have |
| `Distance falloff` | how local the bounce is — smaller = sharper colour bleed at seams      |
| `Coarsen ε`        | brick coarsening tolerance — higher = smaller atlas, less detail       |
| `Max level`        | biggest a single brick may get in flat areas (spacing × 2^level)       |

Runtime (live, no re-bake): **Apply GI** and **GI intensity**.

The bake **bounding box is exactly the model's bounding box** — there are no manual box tweaks. Probes are
only placed in a thin shell hugging the surfaces inside it.

## Inspecting the bake

- **Show volumes** draws one wireframe box per brick. **By level** colours them by size (red = finest →
  blue = coarsest) to reveal the adaptive subdivision; **By irradiance** colours them by the baked bounce
  so you can see the stored field itself.
- The **Bake result** panel reports the grid resolution, probe count, brick count, atlas dimensions,
  resident VRAM, and gzipped file size. **Download** writes the volume as a small `.apv.gz` file (the
  bytes are the two textures + a tiny header).

## Notes

- Bounce albedo is taken as one representative colour per mesh: the material base colour times the average
  of its base-colour texture. APV stores incoming light independently of the receiver, so a single
  dominant colour per surface is enough to drive the bounce.
- This is a learning demo, not a production tool: single-material-per-mesh, no Draco/meshopt decoders, and
  the bake runs on the main thread.

## License

[MIT](LICENSE)
