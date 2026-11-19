// The bake: a CPU-only pass (no GPU capture) that turns a loaded model into a sparse set of light probes.
// For every probe we shoot rays over a sphere against a BVH of the model's surfaces; each ray that hits a
// surface contributes that surface's albedo * incoming light * distance falloff, and the average is the
// probe's stored colour (its incoming indirect irradiance). Probes are only placed in a one-cell shell
// hugging the surfaces, so the field is sparse from the start — that sparsity is what the brick builder packs.

import { BufferAttribute, BufferGeometry, Color, DoubleSide, Matrix3, Ray, SRGBColorSpace, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'

import { axisPos } from './format'
import type { SparseVolume } from './format'

import type { BufferAttribute as TBufferAttribute, Box3, Material, Mesh, Object3D, Texture } from 'three'

export type BakeParams = {
  spacing: number // world-units between probes at the finest level (smaller = denser)
  falloff: number // distance-falloff half-distance (smaller = more local, sharper colour bleed)
  sunDir?: Vector3 // direction a surface points to reach the sun (world space)
  ambient?: number // flat fill so shadowed surfaces still bounce some light
  rayCount?: number // sphere directions integrated per probe
  rayDist?: number // max bounce distance — keeps GI local and the bake fast
}

const DEFAULT_SUN = new Vector3(0.5, 0.8, 0.3).normalize()
const DEFAULT_AMBIENT = 0.4
const DEFAULT_RAY_COUNT = 128
const DEFAULT_RAY_DIST = 40
const SHADOW_DIST = 250
const SHADOW_BIAS = 0.05
const SHELL_SAMPLE_SPACING_RATIO = 0.5 // surface sample spacing relative to the grid cell size
const SHELL_MAX_SUBDIV = 32 // cap per-triangle barycentric subdivision so huge triangles stay bounded

const round = (v: number) => Math.round(v * 1e4) / 1e4

type Sampleable = Mesh & { isInstancedMesh?: boolean }

const isBakeMesh = (o: Object3D): o is Sampleable => {
  const m = o as Sampleable
  return m.isMesh === true && m.isInstancedMesh !== true && m.visible && !!m.geometry?.attributes.position
}

// One representative linear-space albedo per mesh: the material base colour, multiplied by the average of its
// base-colour texture if it has one. APV stores incoming light independent of the receiver, so a single
// dominant colour per surface is enough to drive the bounce (a green wall bounces green, a red one red).
const textureAverage = new WeakMap<Texture, Color>()
const averageTexture = (tex: Texture): Color => {
  const cached = textureAverage.get(tex)
  if (cached) return cached
  const out = new Color(1, 1, 1)
  const image = tex.image as CanvasImageSource & { width?: number; height?: number }
  if (image?.width && image?.height) {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 16
      canvas.height = 16
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx) {
        ctx.drawImage(image, 0, 0, 16, 16)
        const { data } = ctx.getImageData(0, 0, 16, 16)
        let r = 0
        let g = 0
        let b = 0
        const n = data.length / 4
        for (let i = 0; i < data.length; i += 4) {
          r += (data[i] ?? 0) / 255
          g += (data[i + 1] ?? 0) / 255
          b += (data[i + 2] ?? 0) / 255
        }
        out.setRGB(r / n, g / n, b / n, SRGBColorSpace) // texel bytes are sRGB → convert to working space
      }
    } catch {
      // tainted/undrawable image — fall back to white so the material colour alone drives the albedo
    }
  }
  textureAverage.set(tex, out)
  return out
}

const meshAlbedo = (mesh: Sampleable): Color => {
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
    | (Material & { color?: Color; map?: Texture | null })
    | undefined
  const albedo = material?.color ? material.color.clone() : new Color(1, 1, 1)
  if (material?.map) albedo.multiply(averageTexture(material.map))
  return albedo
}

type World = { bvh: MeshBVH; colorAttr: TBufferAttribute; points: number[]; normals: number[] }

// Build a single world-space BVH over every bakeable triangle, tagging each vertex with its mesh's albedo
// (so a ray hit reads the colour via its vertex index — robust to the index reordering MeshBVH does). In the
// same pass, barycentric-sample each triangle into world-space points + outward normals for the probe shell.
const buildWorld = (root: Object3D, sampleSpacing: number): World => {
  const positions: number[] = []
  const colors: number[] = []
  const points: number[] = []
  const normals: number[] = []
  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  const ab = new Vector3()
  const ac = new Vector3()
  const n = new Vector3()
  const authored = new Vector3()
  const tmp = new Vector3()
  const normalMatrix = new Matrix3()

  root.updateWorldMatrix(true, true)
  root.traverse(o => {
    if (!isBakeMesh(o)) return
    const pos = o.geometry.attributes.position
    const normal = o.geometry.attributes.normal
    const index = o.geometry.index
    const albedo = meshAlbedo(o)
    const mw = o.matrixWorld
    normalMatrix.getNormalMatrix(mw)
    const triCount = (index ? index.count : pos.count) / 3
    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
      a.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0)).applyMatrix4(mw)
      b.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1)).applyMatrix4(mw)
      c.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2)).applyMatrix4(mw)
      for (const v of [a, b, c]) {
        positions.push(v.x, v.y, v.z)
        colors.push(albedo.r, albedo.g, albedo.b)
      }
      ab.subVectors(b, a)
      ac.subVectors(c, a)
      n.crossVectors(ab, ac)
      const len = n.length()
      if (len === 0) continue
      n.divideScalar(len)
      if (normal) {
        // Orient the geometric normal to agree with the authored (shading) normal so the shell steps outward.
        authored.set(normal.getX(i0), normal.getY(i0), normal.getZ(i0)).applyNormalMatrix(normalMatrix)
        if (authored.lengthSq() > 0 && n.dot(authored) < 0) n.negate()
      }
      const maxEdge = Math.max(ab.length(), ac.length(), b.distanceTo(c))
      const sub = Math.min(SHELL_MAX_SUBDIV, Math.max(1, Math.ceil(maxEdge / sampleSpacing)))
      for (let i = 0; i <= sub; i++) {
        for (let j = 0; j <= sub - i; j++) {
          const u = i / sub
          const w = j / sub
          tmp.copy(a).addScaledVector(ab, u).addScaledVector(ac, w)
          points.push(tmp.x, tmp.y, tmp.z)
          normals.push(n.x, n.y, n.z)
        }
      }
    }
  })

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  return { bvh: new MeshBVH(geometry), colorAttr: geometry.attributes.color as TBufferAttribute, points, normals }
}

// The one-cell-thick envelope of grid cells just OUTSIDE the surfaces: each surface sample is stepped one
// cell along its outward normal (in index space, so the step is exactly one cell on the dominant axis) and
// that cell is marked occupied. Probes therefore sit in open air hugging the surface, not buried in it, and
// the configured box clips anything that steps out of bounds.
const shellCells = (
  points: number[],
  normals: number[],
  min: Vector3,
  size: Vector3,
  res: [number, number, number],
): Set<number> => {
  const [nx, ny, nz] = res
  const csx = Math.max(size.x / nx, 1e-3)
  const csy = Math.max(size.y / ny, 1e-3)
  const csz = Math.max(size.z / nz, 1e-3)
  const cells = new Set<number>()
  for (let k = 0; k < points.length; k += 3) {
    let dx = (normals[k] ?? 0) / csx
    let dy = (normals[k + 1] ?? 0) / csy
    let dz = (normals[k + 2] ?? 0) / csz
    const m = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) || 1
    dx /= m
    dy /= m
    dz /= m
    const ix = Math.round(((points[k] ?? 0) - min.x) / csx - 0.5 + dx)
    const iy = Math.round(((points[k + 1] ?? 0) - min.y) / csy - 0.5 + dy)
    const iz = Math.round(((points[k + 2] ?? 0) - min.z) / csz - 0.5 + dz)
    if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) continue
    cells.add((iz * ny + iy) * nx + ix)
  }
  return cells
}

// Uniform directions over the full sphere (Fibonacci lattice) — the rays each probe integrates.
const sphereDirs = (count: number): Vector3[] => {
  const dirs: Vector3[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    dirs.push(new Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r))
  }
  return dirs
}

// Grid resolution [nx, ny, nz] from the box and a single probe spacing: each axis gets round(extent/spacing)
// cells, at least 2.
export const gridResolution = (bounds: Box3, spacing: number): [number, number, number] => {
  const s = Math.max(0.05, spacing)
  const size = bounds.getSize(new Vector3())
  const axis = (extent: number) => Math.max(2, Math.round(extent / s))
  return [axis(size.x), axis(size.y), axis(size.z)]
}

// Ray-traced 1-bounce irradiance bake. For each shell probe, integrate the incoming bounce: cast rays over
// the sphere, and for each that hits a surface within rayDist add albedo * (sun*N*L*shadow + ambient),
// weighted by 1 / (1 + (d/falloff)^2) so nearby surfaces dominate. Sky misses add nothing. The average over
// all rays is the probe's stored colour.
export const bakeIrradiance = async (
  model: Object3D,
  bounds: Box3,
  params: BakeParams,
  onProgress?: (done: number, total: number) => void,
): Promise<SparseVolume> => {
  const min = bounds.min.clone()
  const size = bounds.getSize(new Vector3())
  const [nx, ny, nz] = gridResolution(bounds, params.spacing)
  const sunDir = params.sunDir ?? DEFAULT_SUN
  const ambient = params.ambient ?? DEFAULT_AMBIENT
  const rayCount = params.rayCount ?? DEFAULT_RAY_COUNT
  const rayDist = params.rayDist ?? DEFAULT_RAY_DIST
  const falloff = Math.max(0.1, params.falloff)

  const cellSize = Math.min(size.x / nx, size.y / ny, size.z / nz)
  const { bvh, colorAttr, points, normals } = buildWorld(model, Math.max(cellSize * SHELL_SAMPLE_SPACING_RATIO, 1e-3))
  const cells = [...shellCells(points, normals, min, size, [nx, ny, nz])]
  const dirs = sphereDirs(rayCount)

  const ray = new Ray()
  const normal = new Vector3()
  const idx: number[] = []
  const rgb: number[] = []

  for (let p = 0; p < cells.length; p++) {
    const flat = cells[p] ?? 0
    const ix = flat % nx
    const iy = Math.floor(flat / nx) % ny
    const iz = Math.floor(flat / (nx * ny))
    const ox = axisPos(min.x, size.x, nx, ix)
    const oy = axisPos(min.y, size.y, ny, iy)
    const oz = axisPos(min.z, size.z, nz, iz)

    let r = 0
    let g = 0
    let bch = 0
    for (const d of dirs) {
      ray.origin.set(ox, oy, oz)
      ray.direction.copy(d)
      const hit = bvh.raycastFirst(ray, DoubleSide, 0, rayDist)
      if (!hit?.face) continue
      normal.copy(hit.face.normal)
      if (normal.dot(d) > 0) normal.negate() // face the probe

      let received = ambient
      const ndotl = normal.dot(sunDir)
      if (ndotl > 0) {
        ray.origin.copy(hit.point).addScaledVector(normal, SHADOW_BIAS)
        ray.direction.copy(sunDir)
        if (!bvh.raycastFirst(ray, DoubleSide, 0, SHADOW_DIST)) received += ndotl
      }
      received /= 1 + (hit.distance / falloff) ** 2 // closer surfaces dominate → local colour bleed

      const a = hit.face.a // all 3 verts of a triangle share the mesh albedo, so reading one is enough
      r += colorAttr.getX(a) * received
      g += colorAttr.getY(a) * received
      bch += colorAttr.getZ(a) * received
    }

    idx.push(flat)
    rgb.push(round(r / rayCount), round(g / rayCount), round(bch / rayCount))

    if (p % 64 === 0) {
      onProgress?.(p, cells.length)
      await new Promise(res => setTimeout(res, 0))
    }
  }
  onProgress?.(cells.length, cells.length)

  return { min: [min.x, min.y, min.z], size: [size.x, size.y, size.z], res: [nx, ny, nz], idx, rgb }
}
