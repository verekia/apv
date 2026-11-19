// Storage layer for the adaptive probe volume: the on-disk/in-VRAM byte layout, the RGBM HDR packing, and
// the helpers that turn a sparse bake into the dense field the brick builder reads. Nothing here is
// renderer-specific — it is plain typed-array math, so it is the easiest place to start reading.

import { DataUtils } from 'three'

// World-space position of the CENTER of grid cell `i` along one axis: the box (min..min+size) is split into
// n equal cells and the probe sits at (i+0.5)/n — exactly where a LinearFilter 3D texture samples texel i,
// so the bake stores irradiance at the position the GPU later reads it (no half-texel drift). Shared by the
// bake and the runtime so their probe placement can never diverge.
export const axisPos = (min: number, size: number, n: number, i: number) => min + (size * (i + 0.5)) / n

// --- RGBM HDR packing ------------------------------------------------------------------------------
// Bounce light is HDR-ish (can exceed 1.0), but every hardware-filterable colour format on WebGPU is rgba8.
// RGBM packs an HDR colour into 4 bytes: rgb (3 bytes) plus a shared multiplier M (1 byte). M is per-texel,
// so a dim probe still uses the full 8-bit mantissa (its M just shrinks). RGBM also interpolates acceptably
// under hardware trilinear, which an indexed/palette format would not — that is why the atlas can be linearly
// filtered. decode: colour = rgb * M * RANGE.
export const RGBM_RANGE = 8

// Encode one linear colour into 4 bytes at out[o..o+3]. M is quantised up (ceil) so the stored rgb never
// exceeds 1 (no clipping); a black texel stays all-zero so it decodes to exactly 0.
export const encodeRgbm = (out: Uint8Array, o: number, r: number, g: number, b: number) => {
  const peak = Math.max(r, g, b)
  if (peak <= 0) {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0
    return
  }
  const m = Math.ceil(Math.min(1, peak / RGBM_RANGE) * 255) / 255
  const inv = 1 / (m * RGBM_RANGE)
  out[o] = Math.min(255, Math.round(r * inv * 255))
  out[o + 1] = Math.min(255, Math.round(g * inv * 255))
  out[o + 2] = Math.min(255, Math.round(b * inv * 255))
  out[o + 3] = Math.round(m * 255)
}

// --- Adaptive brick volume -------------------------------------------------------------------------
// GI is stored as a sparse, multi-resolution brick set rather than a dense grid. Every brick holds BRICK^3
// probes; a brick's LEVEL sets its world size (probe spacing = finest spacing * 2^level), so flat regions use
// a few coarse bricks and detailed regions (colour seams, the base of objects) use fine ones. Bricks are
// packed — each with a 1-texel apron so trilinear filtering stays correct across brick borders — into the
// atlas texture; the indirection texture maps a world cell to its brick's atlas slot + level.
export const BRICK = 4 // probes per brick edge (all levels)
export const BRICK_PAD = 1 // apron texels each side so hardware trilinear stays correct across brick borders
export const BRICK_PADDED = BRICK + BRICK_PAD * 2 // = 6

export type BrickVolume = {
  min: [number, number, number]
  size: [number, number, number]
  res: [number, number, number] // finest grid resolution
  indDims: [number, number, number] // indirection grid = ceil(res / BRICK)
  slotDims: [number, number, number] // brick-slot grid inside the atlas
  atlasDims: [number, number, number] // slotDims * BRICK_PADDED (texels)
  indirection: Uint8Array // indDims product * 4 (rgba8: slot x,y,z, a = level + 1; 0 = empty)
  atlas: Uint8Array // atlasDims product * 4 (RGBM)
}

// Dense grid the brick builder reads: rgb (raw Float16 bits) + a per-cell valid flag, both nx*ny*nz long.
// Reconstructed from the sparse bake; culled cells are 0 / valid=false until fillVolumeNearest floods them.
export type VolumeData = {
  min: [number, number, number]
  size: [number, number, number]
  res: [number, number, number]
  rgb: Uint16Array // 3 raw Float16 bits per cell (bounce colour), 0 for culled cells
  valid: boolean[] // true for kept probes, false for culled cells
}

// Sparse bake result: only the kept probes, as parallel arrays (idx = flat cell index, rgb = 3 floats each).
export type SparseVolume = {
  min: [number, number, number]
  size: [number, number, number]
  res: [number, number, number]
  idx: number[]
  rgb: number[]
}

const MAGIC = 0x41505631 // "APV1"

// The serialized file is committed/served gzip-compressed (the rgba8 atlas is mostly zeros and smooth runs,
// so gzip ~3x's it) and decompressed natively in the browser via CompressionStream — no dependency, no wasm.
type BytePair = ReadableWritablePair<Uint8Array, Uint8Array>

export const gzipBuffer = async (data: ArrayBuffer): Promise<ArrayBuffer> => {
  const body = new Response(data).body
  if (!body) return data
  return new Response(body.pipeThrough(new CompressionStream('gzip') as unknown as BytePair)).arrayBuffer()
}

export const gunzipStream = (body: ReadableStream<Uint8Array>): Promise<ArrayBuffer> =>
  new Response(body.pipeThrough(new DecompressionStream('gzip') as unknown as BytePair)).arrayBuffer()

// A tiny header (magic + dimensions), then the indirection bytes, then the atlas bytes. Those two byte
// arrays ARE the two GPU textures, uploaded verbatim — so VRAM ~= the uncompressed file size.
export const serializeBrickVolume = (v: BrickVolume): ArrayBuffer => {
  const headerBytes = 4 + 9 * 4 + 3 * 4 + 3 * 4 + 3 * 4 // magic + res/min/size + indDims + slotDims + atlasDims
  const buffer = new ArrayBuffer(headerBytes + v.indirection.byteLength + v.atlas.byteLength)
  const view = new DataView(buffer)
  let o = 0
  const u32 = (x: number) => {
    view.setUint32(o, x, true)
    o += 4
  }
  const f32 = (x: number) => {
    view.setFloat32(o, x, true)
    o += 4
  }
  u32(MAGIC)
  for (let i = 0; i < 3; i++) u32(v.res[i] ?? 0)
  for (let i = 0; i < 3; i++) f32(v.min[i] ?? 0)
  for (let i = 0; i < 3; i++) f32(v.size[i] ?? 0)
  for (let i = 0; i < 3; i++) u32(v.indDims[i] ?? 0)
  for (let i = 0; i < 3; i++) u32(v.slotDims[i] ?? 0)
  for (let i = 0; i < 3; i++) u32(v.atlasDims[i] ?? 0)
  new Uint8Array(buffer, o, v.indirection.byteLength).set(v.indirection)
  o += v.indirection.byteLength
  new Uint8Array(buffer, o, v.atlas.byteLength).set(v.atlas)
  return buffer
}

export const parseBrickVolume = (buffer: ArrayBuffer): BrickVolume | null => {
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== MAGIC) return null
  let o = 4
  const u32 = () => {
    const x = view.getUint32(o, true)
    o += 4
    return x
  }
  const f32 = () => {
    const x = view.getFloat32(o, true)
    o += 4
    return x
  }
  const res = [u32(), u32(), u32()] as [number, number, number]
  const min = [f32(), f32(), f32()] as [number, number, number]
  const size = [f32(), f32(), f32()] as [number, number, number]
  const indDims = [u32(), u32(), u32()] as [number, number, number]
  const slotDims = [u32(), u32(), u32()] as [number, number, number]
  const atlasDims = [u32(), u32(), u32()] as [number, number, number]
  const indCount = indDims[0] * indDims[1] * indDims[2] * 4
  const atlasCount = atlasDims[0] * atlasDims[1] * atlasDims[2] * 4
  const indirection = new Uint8Array(buffer.slice(o, o + indCount))
  o += indCount
  const atlas = new Uint8Array(buffer.slice(o, o + atlasCount))
  return { min, size, res, indDims, slotDims, atlasDims, indirection, atlas }
}

// Sparse bake -> dense VolumeData (the scatter the brick builder fills from).
export const sparseToDense = (data: SparseVolume): VolumeData => {
  const cells = data.res[0] * data.res[1] * data.res[2]
  const rgb = new Uint16Array(cells * 3)
  const valid: boolean[] = Array.from({ length: cells }, () => false)
  for (let e = 0; e < data.idx.length; e++) {
    const index = data.idx[e] ?? 0
    valid[index] = true
    for (let k = 0; k < 3; k++) rgb[index * 3 + k] = DataUtils.toHalfFloat(data.rgb[e * 3 + k] ?? 0)
  }
  return { min: data.min, size: data.size, res: data.res, rgb, valid }
}

// Multi-source BFS from the kept probes that copies each culled cell's nearest probe colour into it (a
// nearest-probe Voronoi flood), leaving the sparse data untouched. Returns a fresh dense half-float RGB array
// so a brick whose apron reaches past the kept shell still samples a sensible colour instead of fading to
// black between sparse cells.
export const fillVolumeNearest = (data: VolumeData): Uint16Array => {
  const [nx, ny, nz] = data.res
  const cells = nx * ny * nz
  const out = new Uint16Array(data.rgb)
  const dist = new Int32Array(cells).fill(-1)
  const queue: number[] = []
  for (let c = 0; c < cells; c++) {
    if (data.valid[c]) {
      dist[c] = 0
      queue.push(c)
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head]
    if (c === undefined) continue
    const cx = c % nx
    const cy = Math.floor(c / nx) % ny
    const cz = Math.floor(c / (nx * ny))
    const cb = c * 3
    const nextDist = (dist[c] ?? 0) + 1
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx
          const y = cy + dy
          const z = cz + dz
          if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) continue
          const nb = z * nx * ny + y * nx + x
          if (dist[nb] !== -1) continue
          dist[nb] = nextDist
          const nbb = nb * 3
          for (let k = 0; k < 3; k++) out[nbb + k] = out[cb + k] ?? 0
          queue.push(nb)
        }
      }
    }
  }
  return out
}
