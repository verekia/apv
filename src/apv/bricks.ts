// The adaptive part of "adaptive probe volume". A sparse bake comes in as a dense field; this builds a
// min/max + occupancy pyramid over it, then walks top-down keeping a coarse brick wherever the bounce colour
// is flat within `eps` and subdividing into 8 children where it varies. The chosen leaf bricks are packed
// into the atlas (RGBM, with a 1-texel apron) and the indirection grid is filled so every base cell points at
// its brick + level. Result: fine detail at colour seams, big cheap bricks across flat regions.

import { DataUtils } from 'three'

import { BRICK, BRICK_PAD, BRICK_PADDED, encodeRgbm, fillVolumeNearest, RGBM_RANGE, sparseToDense } from './format'
import type { BrickVolume, SparseVolume } from './format'

export type BrickOptions = {
  eps?: number // max bounce colour range within a block that still allows coarsening it (0..1, linear)
  maxLevel?: number // coarsest level; probe spacing = finest * 2^level
}

const DEFAULT_EPS = 0.2
const DEFAULT_MAX_LEVEL = 3

// Per-block min/max of the bounce + whether it covers any shell cell, one entry per brick at a given level.
type Pyramid = { dims: [number, number, number]; min: Float32Array; max: Float32Array; occ: Uint8Array }

export const buildBricks = (sparse: SparseVolume, options: BrickOptions = {}): BrickVolume => {
  const eps = options.eps ?? DEFAULT_EPS
  const maxLevel = Math.max(0, options.maxLevel ?? DEFAULT_MAX_LEVEL)
  const dense = sparseToDense(sparse)
  const filled = fillVolumeNearest(dense)
  const [nx, ny, nz] = dense.res
  const decode = (i: number) => DataUtils.fromHalfFloat(filled[i] ?? 0)

  // --- base pyramid level 0 (one entry per BRICK^3 block of finest cells) ---
  const bx0 = Math.ceil(nx / BRICK)
  const by0 = Math.ceil(ny / BRICK)
  const bz0 = Math.ceil(nz / BRICK)
  const base: Pyramid = {
    dims: [bx0, by0, bz0],
    min: new Float32Array(bx0 * by0 * bz0 * 3).fill(Infinity),
    max: new Float32Array(bx0 * by0 * bz0 * 3).fill(-Infinity),
    occ: new Uint8Array(bx0 * by0 * bz0),
  }
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const c = (z * ny + y) * nx + x
        const b = (Math.floor(z / BRICK) * by0 + Math.floor(y / BRICK)) * bx0 + Math.floor(x / BRICK)
        if (dense.valid[c]) base.occ[b] = 1
        const cb = c * 3
        const bb = b * 3
        for (let k = 0; k < 3; k++) {
          const v = decode(cb + k)
          if (v < (base.min[bb + k] ?? Infinity)) base.min[bb + k] = v
          if (v > (base.max[bb + k] ?? -Infinity)) base.max[bb + k] = v
        }
      }
    }
  }

  // Dilate occupancy by one base brick so sampling just off a surface still lands inside a brick.
  const occ0 = new Uint8Array(base.occ)
  const at = (a: Uint8Array, x: number, y: number, z: number) =>
    x < 0 || x >= bx0 || y < 0 || y >= by0 || z < 0 || z >= bz0 ? 0 : (a[(z * by0 + y) * bx0 + x] ?? 0)
  for (let z = 0; z < bz0; z++) {
    for (let y = 0; y < by0; y++) {
      for (let x = 0; x < bx0; x++) {
        if (occ0[(z * by0 + y) * bx0 + x]) continue
        let near = 0
        for (let dz = -1; dz <= 1 && !near; dz++)
          for (let dy = -1; dy <= 1 && !near; dy++)
            for (let dx = -1; dx <= 1 && !near; dx++) if (at(occ0, x + dx, y + dy, z + dz)) near = 1
        if (near) base.occ[(z * by0 + y) * bx0 + x] = 1
      }
    }
  }

  // --- coarser pyramid levels (combine 2^3 children) ---
  const pyramids: Pyramid[] = [base]
  for (let l = 1; l <= maxLevel; l++) {
    const prev = pyramids[l - 1]!
    const [px, py, pz] = prev.dims
    const dx = Math.ceil(px / 2)
    const dy = Math.ceil(py / 2)
    const dz = Math.ceil(pz / 2)
    const p: Pyramid = {
      dims: [dx, dy, dz],
      min: new Float32Array(dx * dy * dz * 3).fill(Infinity),
      max: new Float32Array(dx * dy * dz * 3).fill(-Infinity),
      occ: new Uint8Array(dx * dy * dz),
    }
    for (let z = 0; z < dz; z++) {
      for (let y = 0; y < dy; y++) {
        for (let x = 0; x < dx; x++) {
          const o = (z * dy + y) * dx + x
          for (let cz = 0; cz < 2; cz++) {
            for (let cy = 0; cy < 2; cy++) {
              for (let cx = 0; cx < 2; cx++) {
                const sx = x * 2 + cx
                const sy = y * 2 + cy
                const sz = z * 2 + cz
                if (sx >= px || sy >= py || sz >= pz) continue
                const c = (sz * py + sy) * px + sx
                if (prev.occ[c]) p.occ[o] = 1
                for (let k = 0; k < 3; k++) {
                  p.min[o * 3 + k] = Math.min(p.min[o * 3 + k] ?? Infinity, prev.min[c * 3 + k] ?? Infinity)
                  p.max[o * 3 + k] = Math.max(p.max[o * 3 + k] ?? -Infinity, prev.max[c * 3 + k] ?? -Infinity)
                }
              }
            }
          }
        }
      }
    }
    pyramids.push(p)
  }

  // --- pick leaves: descend from the coarsest level, keep a brick where the block is flat within eps ---
  type Leaf = { level: number; ix: number; iy: number; iz: number }
  const leaves: Leaf[] = []
  const flat = (p: Pyramid, o: number) => {
    let range = 0
    for (let k = 0; k < 3; k++) range = Math.max(range, (p.max[o * 3 + k] ?? 0) - (p.min[o * 3 + k] ?? 0))
    return range <= eps
  }
  const visit = (level: number, ix: number, iy: number, iz: number) => {
    const p = pyramids[level]!
    const [dx, dy] = p.dims
    const o = (iz * dy + iy) * dx + ix
    if (!p.occ[o]) return
    if (level === 0 || flat(p, o)) {
      leaves.push({ level, ix, iy, iz })
      return
    }
    const child = pyramids[level - 1]!
    for (let cz = 0; cz < 2; cz++)
      for (let cy = 0; cy < 2; cy++)
        for (let cx = 0; cx < 2; cx++) {
          const nxc = ix * 2 + cx
          const nyc = iy * 2 + cy
          const nzc = iz * 2 + cz
          if (nxc < child.dims[0] && nyc < child.dims[1] && nzc < child.dims[2]) visit(level - 1, nxc, nyc, nzc)
        }
  }
  const top = pyramids[maxLevel]!
  for (let z = 0; z < top.dims[2]; z++)
    for (let y = 0; y < top.dims[1]; y++) for (let x = 0; x < top.dims[0]; x++) visit(maxLevel, x, y, z)

  // --- assign atlas slots (roughly cubic slot grid) ---
  const k = leaves.length
  const gx = Math.max(1, Math.ceil(Math.cbrt(k)))
  const gy = Math.max(1, Math.ceil(Math.sqrt(k / gx)))
  const gz = Math.max(1, Math.ceil(k / (gx * gy)))
  const slotDims: [number, number, number] = [gx, gy, gz]
  const atlasDims: [number, number, number] = [gx * BRICK_PADDED, gy * BRICK_PADDED, gz * BRICK_PADDED]
  const [ax, ay] = atlasDims
  const atlas = new Uint8Array(atlasDims[0] * atlasDims[1] * atlasDims[2] * 4)
  const indirection = new Uint8Array(bx0 * by0 * bz0 * 4)

  // Trilinear read of the filled field at a continuous finest-cell coordinate (used to resample each probe +
  // apron texel of a coarse brick from the finest grid).
  const sampleTriple = (fx: number, fy: number, fz: number, out: [number, number, number]) => {
    const cx = Math.min(nx - 1, Math.max(0, fx))
    const cy = Math.min(ny - 1, Math.max(0, fy))
    const cz = Math.min(nz - 1, Math.max(0, fz))
    const x0 = Math.floor(cx)
    const y0 = Math.floor(cy)
    const z0 = Math.floor(cz)
    const x1 = Math.min(nx - 1, x0 + 1)
    const y1 = Math.min(ny - 1, y0 + 1)
    const z1 = Math.min(nz - 1, z0 + 1)
    const tx = cx - x0
    const ty = cy - y0
    const tz = cz - z0
    for (let c = 0; c < 3; c++) {
      const idx = (xx: number, yy: number, zz: number) => ((zz * ny + yy) * nx + xx) * 3 + c
      const c00 = decode(idx(x0, y0, z0)) * (1 - tx) + decode(idx(x1, y0, z0)) * tx
      const c10 = decode(idx(x0, y1, z0)) * (1 - tx) + decode(idx(x1, y1, z0)) * tx
      const c01 = decode(idx(x0, y0, z1)) * (1 - tx) + decode(idx(x1, y0, z1)) * tx
      const c11 = decode(idx(x0, y1, z1)) * (1 - tx) + decode(idx(x1, y1, z1)) * tx
      const c0 = c00 * (1 - ty) + c10 * ty
      const c1 = c01 * (1 - ty) + c11 * ty
      out[c] = c0 * (1 - tz) + c1 * tz
    }
  }

  const triple: [number, number, number] = [0, 0, 0]
  for (let s = 0; s < k; s++) {
    const leaf = leaves[s]!
    const span = 1 << leaf.level // base bricks per axis this leaf covers
    const originCellX = leaf.ix * span * BRICK
    const originCellY = leaf.iy * span * BRICK
    const originCellZ = leaf.iz * span * BRICK
    const sx = s % gx
    const sy = Math.floor(s / gx) % gy
    const sz = Math.floor(s / (gx * gy))
    // atlas region [sx*PADDED .. +PADDED); interior probe q = (atlas local) - PAD, q in -1..BRICK
    for (let lz = 0; lz < BRICK_PADDED; lz++) {
      for (let ly = 0; ly < BRICK_PADDED; ly++) {
        for (let lx = 0; lx < BRICK_PADDED; lx++) {
          const qx = lx - BRICK_PAD
          const qy = ly - BRICK_PAD
          const qz = lz - BRICK_PAD
          const fx = originCellX + (qx + 0.5) * span - 0.5
          const fy = originCellY + (qy + 0.5) * span - 0.5
          const fz = originCellZ + (qz + 0.5) * span - 0.5
          sampleTriple(fx, fy, fz, triple)
          const ax0 = sx * BRICK_PADDED + lx
          const ay0 = sy * BRICK_PADDED + ly
          const az0 = sz * BRICK_PADDED + lz
          const o = ((az0 * ay + ay0) * ax + ax0) * 4
          encodeRgbm(atlas, o, triple[0], triple[1], triple[2])
        }
      }
    }
    // indirection: every base brick under this leaf points to its slot + level
    for (let z = 0; z < span; z++) {
      for (let y = 0; y < span; y++) {
        for (let x = 0; x < span; x++) {
          const bbx = leaf.ix * span + x
          const bby = leaf.iy * span + y
          const bbz = leaf.iz * span + z
          if (bbx >= bx0 || bby >= by0 || bbz >= bz0) continue
          const o = ((bbz * by0 + bby) * bx0 + bbx) * 4
          indirection[o] = sx
          indirection[o + 1] = sy
          indirection[o + 2] = sz
          indirection[o + 3] = leaf.level + 1 // 0 = empty
        }
      }
    }
  }

  return {
    min: dense.min,
    size: dense.size,
    res: dense.res,
    indDims: [bx0, by0, bz0],
    slotDims,
    atlasDims,
    indirection,
    atlas,
  }
}

// Per-level wireframe colours for the debug brick view (0 = finest). Red → orange → yellow → green → cyan.
export const LEVEL_COLORS: [number, number, number][] = [
  [1, 0.2, 0.2],
  [1, 0.6, 0.1],
  [1, 1, 0.2],
  [0.3, 1, 0.3],
  [0.3, 0.8, 1],
  [0.7, 0.4, 1],
]

const cellWorld = (i: number, n: number, lo: number, sz: number) => lo + (sz * i) / n

export type BrickInstance = {
  center: [number, number, number]
  size: [number, number, number]
  level: number
  color: [number, number, number] // decoded centre-probe irradiance (for the irradiance view)
}

// Walk the indirection grid and emit one entry per unique brick (deduped by atlas slot), with its world box,
// level, and decoded centre-probe colour. Drives the debug brick wireframe.
export const enumerateBricks = (v: BrickVolume): BrickInstance[] => {
  const [bx, by, bz] = v.indDims
  const [nx, ny, nz] = v.res
  const [ax, ay] = v.atlasDims
  const seen = new Set<number>()
  const out: BrickInstance[] = []
  for (let z = 0; z < bz; z++) {
    for (let y = 0; y < by; y++) {
      for (let x = 0; x < bx; x++) {
        const o = ((z * by + y) * bx + x) * 4
        const lvlPlus1 = v.indirection[o + 3] ?? 0
        if (lvlPlus1 === 0) continue
        const sx = v.indirection[o] ?? 0
        const sy = v.indirection[o + 1] ?? 0
        const sz = v.indirection[o + 2] ?? 0
        const slot = (sz * v.slotDims[1] + sy) * v.slotDims[0] + sx
        if (seen.has(slot)) continue
        seen.add(slot)
        const level = lvlPlus1 - 1
        const span = 1 << level
        const ox = Math.floor(x / span) * span
        const oy = Math.floor(y / span) * span
        const oz = Math.floor(z / span) * span
        const wx0 = cellWorld(ox * BRICK, nx, v.min[0], v.size[0])
        const wy0 = cellWorld(oy * BRICK, ny, v.min[1], v.size[1])
        const wz0 = cellWorld(oz * BRICK, nz, v.min[2], v.size[2])
        const wx1 = cellWorld((ox + span) * BRICK, nx, v.min[0], v.size[0])
        const wy1 = cellWorld((oy + span) * BRICK, ny, v.min[1], v.size[1])
        const wz1 = cellWorld((oz + span) * BRICK, nz, v.min[2], v.size[2])
        const px = sx * BRICK_PADDED + BRICK_PAD + (BRICK >> 1)
        const py = sy * BRICK_PADDED + BRICK_PAD + (BRICK >> 1)
        const pz = sz * BRICK_PADDED + BRICK_PAD + (BRICK >> 1)
        const ai = ((pz * ay + py) * ax + px) * 4
        const m = ((v.atlas[ai + 3] ?? 0) / 255) * RGBM_RANGE
        out.push({
          center: [(wx0 + wx1) / 2, (wy0 + wy1) / 2, (wz0 + wz1) / 2],
          size: [wx1 - wx0, wy1 - wy0, wz1 - wz0],
          level,
          color: [
            ((v.atlas[ai] ?? 0) / 255) * m,
            ((v.atlas[ai + 1] ?? 0) / 255) * m,
            ((v.atlas[ai + 2] ?? 0) / 255) * m,
          ],
        })
      }
    }
  }
  return out
}

// Human-readable stats for the bake status line. `bricks` = unique bricks in the atlas (deduped by slot).
export const brickStats = (v: BrickVolume) => {
  const slots = new Set<number>()
  for (let i = 0; i < v.indirection.length; i += 4) {
    if (!v.indirection[i + 3]) continue
    slots.add(
      ((v.indirection[i + 2] ?? 0) * v.slotDims[1] + (v.indirection[i + 1] ?? 0)) * v.slotDims[0] +
        (v.indirection[i] ?? 0),
    )
  }
  const bytes = v.atlas.byteLength + v.indirection.byteLength
  return { bricks: slots.size, bytes, atlasDims: v.atlasDims }
}
