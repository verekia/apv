// The runtime side: upload the two baked textures, then sample them in a TSL node graph to reconstruct each
// surface's bounce light. The lookup is two texture reads — one NEAREST index fetch into the indirection
// grid (which brick covers this point, at what level), one LINEAR/trilinear fetch into the atlas (the probe
// colour) — followed by an RGBM decode. The result is added as indirect diffuse light in a Lambert material.

import {
  ClampToEdgeWrapping,
  Data3DTexture,
  LinearFilter,
  NearestFilter,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
} from 'three'
import { BRDF_Lambert, diffuseColor, float, positionWorld, texture3D, uniform } from 'three/tsl'
import { MeshLambertNodeMaterial, PhongLightingModel } from 'three/webgpu'

import type { Node } from 'three/webgpu'

import { BRICK, BRICK_PAD, BRICK_PADDED, RGBM_RANGE } from './format'
import type { BrickVolume } from './format'

const SIZE_EPS = 1e-3 // floor for grid extents so a degenerate (flat) bake box can't divide by zero
const EDGE_FADE = 0.05 // normalized band over which GI fades to 0 just outside the bake box

const configureTexture = (t: Data3DTexture, nearest: boolean) => {
  t.format = RGBAFormat
  t.type = UnsignedByteType
  t.minFilter = nearest ? NearestFilter : LinearFilter
  t.magFilter = nearest ? NearestFilter : LinearFilter
  t.generateMipmaps = false // no mip chain → VRAM is exactly width*height*depth*4 bytes
  t.wrapS = ClampToEdgeWrapping
  t.wrapT = ClampToEdgeWrapping
  t.wrapR = ClampToEdgeWrapping
  t.needsUpdate = true
  return t
}

const placeholder = (nearest: boolean) => configureTexture(new Data3DTexture(new Uint8Array(4), 1, 1, 1), nearest)

// The indirection grid maps a world cell → its brick's atlas slot + level (NEAREST: it's an index, you can't
// blend indices); the atlas holds the RGBM probes (LINEAR, so the GPU does trilinear between probes for free).
const atlasNode = texture3D(placeholder(false))
const indNode = texture3D(placeholder(true))

const uMin = uniform(new Vector3())
const uSize = uniform(new Vector3(1, 1, 1))
const uRes = uniform(new Vector3(1, 1, 1)) // finest grid resolution
const uIndDims = uniform(new Vector3(1, 1, 1)) // indirection grid resolution (= ceil(res / BRICK))
const uAtlasDims = uniform(new Vector3(1, 1, 1)) // atlas texel dimensions
const uIntensity = uniform(1)
const uEnabled = uniform(0)

type Vec3Node = typeof diffuseColor.rgb

// BRDF_Lambert's return type is too loose for the chainable node operators, so narrow it like the rest of TSL.
const lambertBrdf = (albedo: Vec3Node) => BRDF_Lambert({ diffuseColor: albedo }) as unknown as Node<'vec3'>

// The baked-GI contribution for a surface with this albedo: find the covering brick, read + decode its probe,
// fade at the box edge, scale by intensity, then reflect off the surface (× albedo via the Lambert BRDF).
const volumeIrradiance = (albedo: Vec3Node) => {
  const box = positionWorld.sub(uMin).div(uSize) // [0,1] across the bake box
  // p = continuous FINEST probe coords (probe i centred at integer i). The indirection grid (one texel per
  // BRICK^3 block) gives the covering brick's atlas slot + level.
  const p = box.mul(uRes).sub(0.5)
  const baseBrick = p.div(BRICK).floor().max(0).min(uIndDims.sub(1))
  const ind = indNode.sample(baseBrick.add(0.5).div(uIndDims))
  const lvlPlus1 = ind.a.mul(255).add(0.5).floor()
  const valid = lvlPlus1.min(1) // 0 = empty cell → no GI; ≥1 → 1
  const level = lvlPlus1.sub(1).max(0)
  const span = float(2).pow(level) // base bricks per axis this brick covers (= 2^level)
  const slot = ind.rgb.mul(255).add(0.5).floor()
  // Brick origin (in finest cells), then local probe coords within it at the brick's own spacing.
  const originCell = baseBrick.div(span).floor().mul(span).mul(BRICK)
  const q = p.sub(originCell).add(0.5).div(span).sub(0.5)
  // Atlas texel = slot block + 1-texel apron + local probe; +0.5 hits the texel centre for trilinear.
  const atlasTexel = slot.mul(BRICK_PADDED).add(BRICK_PAD).add(q)
  const sample = atlasNode.sample(atlasTexel.add(0.5).div(uAtlasDims))
  const irr = sample.rgb.mul(sample.a).mul(RGBM_RANGE).mul(valid).max(0) // RGBM decode, gated by validity
  // Fade GI to 0 just outside the box so out-of-box surfaces fall back to plain ambient + sun.
  const outside = box.sub(box.clamp(0, 1)).abs()
  const edge = float(1).sub(outside.x.max(outside.y).max(outside.z).div(EDGE_FADE).clamp(0, 1))
  const gi = irr.mul(uIntensity).mul(uEnabled).mul(edge)
  // Reflect the incoming bounce off the surface — the diffuse lighting equation, light × albedo.
  return gi.mul(lambertBrdf(albedo))
  // Note: this whole subgraph depends only on world position + the baked probes, never on screen-space data,
  // so for low-poly meshes you can wrap the line above in TSL's varying() to run it per-vertex instead of
  // per-fragment (one of APV's key wins). It's left per-fragment here so it stays correct on dense models too.
}

// Plain Lambert that also receives the baked GI as indirect light. GI is indirect by definition, so it is
// added only in indirect() — it never modulates the direct sun term.
class ApvLambertLightingModel extends PhongLightingModel {
  constructor() {
    super(false) // no specular — same as standard Lambert
  }

  indirect(builder: any) {
    const { ambientOcclusion, irradiance, reflectedLight } = builder.context
    reflectedLight.indirectDiffuse.addAssign(irradiance.mul(lambertBrdf(diffuseColor.rgb)))
    reflectedLight.indirectDiffuse.addAssign(volumeIrradiance(diffuseColor.rgb))
    reflectedLight.indirectDiffuse.mulAssign(ambientOcclusion)
  }
}

const lightingModel = new ApvLambertLightingModel()

export class ApvLambertMaterial extends MeshLambertNodeMaterial {
  setupLightingModel() {
    return lightingModel
  }
}

const buildData3D = (dims: [number, number, number], bytes: Uint8Array, nearest: boolean) =>
  configureTexture(new Data3DTexture(bytes, dims[0], dims[1], dims[2]), nearest)

let current: BrickVolume | null = null

// Swap both nodes to freshly built textures (the only reliable way to change their dimensions) and point the
// uniforms at the new volume. The retired textures are disposed on the next call so they are out of any
// in-flight GPU submit.
let pendingDispose: Data3DTexture[] = []

export const applyVolume = (v: BrickVolume) => {
  const retired = [atlasNode.value, indNode.value] as Data3DTexture[]
  for (const t of pendingDispose) t.dispose()
  pendingDispose = retired
  atlasNode.value = buildData3D(v.atlasDims, v.atlas, false)
  indNode.value = buildData3D(v.indDims, v.indirection, true)
  current = v
  uMin.value.set(v.min[0], v.min[1], v.min[2])
  uSize.value.set(Math.max(v.size[0], SIZE_EPS), Math.max(v.size[1], SIZE_EPS), Math.max(v.size[2], SIZE_EPS))
  uRes.value.set(v.res[0], v.res[1], v.res[2])
  uIndDims.value.set(v.indDims[0], v.indDims[1], v.indDims[2])
  uAtlasDims.value.set(v.atlasDims[0], v.atlasDims[1], v.atlasDims[2])
  uEnabled.value = 1
}

export const getVolume = () => current

export const setGiEnabled = (on: boolean) => {
  uEnabled.value = on ? 1 : 0
}

export const setGiIntensity = (value: number) => {
  uIntensity.value = value
}
