// The WebGPU viewport: load a dropped model, render it with the APV Lambert material so it picks up baked GI,
// and draw the debug overlays (the bake bounding box and the adaptive brick wireframes). This file is the
// "render the result" half of the demo; the bake/runtime maths live in src/apv/.

import {
  AmbientLight,
  Box3,
  Box3Helper,
  BoxGeometry,
  Color,
  DirectionalLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshBasicNodeMaterial, WebGPURenderer } from 'three/webgpu'

import { enumerateBricks, LEVEL_COLORS } from './apv/bricks'
import type { BrickVolume } from './apv/format'
import { ApvLambertMaterial } from './apv/volume'

import type { Material, Object3D, Texture } from 'three'

export type VolumeMode = 'level' | 'irradiance'
export type ModelInfo = { box: Box3; triangles: number; meshes: number; size: [number, number, number] }

const BRICK_BOOST = 2 // unlit wireframe reads dark; lift the irradiance colour toward the lit look

let renderer: WebGPURenderer | null = null
let scene: Scene
let camera: PerspectiveCamera
let controls: OrbitControls
let model: Object3D | null = null
let boxHelper: Box3Helper | null = null
let bricksMesh: InstancedMesh | null = null
const modelBox = new Box3()

// Swap a loaded mesh's material for an ApvLambertMaterial, carrying over the bits that matter for both the
// look and the bake (base colour, base-colour texture, vertex colours). The bake reads albedo back off these.
const adoptMaterial = (source: Material): ApvLambertMaterial => {
  const src = source as Material & { color?: Color; map?: Texture | null; vertexColors?: boolean }
  const m = new ApvLambertMaterial()
  if (src.color) m.color.copy(src.color)
  if (src.map) m.map = src.map
  m.vertexColors = src.vertexColors ?? false
  m.transparent = src.transparent
  m.opacity = src.opacity
  m.side = src.side
  return m
}

const frameCamera = () => {
  const center = modelBox.getCenter(new Vector3())
  const size = modelBox.getSize(new Vector3())
  const d = Math.max(size.x, size.y, size.z, 1)
  camera.position.set(center.x + d * 0.9, center.y + d * 0.7, center.z + d * 1.2)
  camera.near = d / 100
  camera.far = d * 20
  camera.updateProjectionMatrix()
  controls.target.copy(center)
  controls.update()
}

export const loadModelFromFile = async (file: File): Promise<ModelInfo> => {
  const buffer = await file.arrayBuffer()
  const loader = new GLTFLoader()
  const isText = /\.gltf$/i.test(file.name)
  const gltf = await new Promise<{ scene: Object3D }>((resolve, reject) => {
    loader.parse(isText ? new TextDecoder().decode(buffer) : buffer, '', resolve, reject)
  })

  if (model) {
    scene.remove(model)
    model.traverse(o => {
      const mesh = o as Mesh
      if (mesh.isMesh) mesh.geometry?.dispose()
    })
  }

  model = gltf.scene
  let triangles = 0
  let meshes = 0
  model.traverse(o => {
    const mesh = o as Mesh & { isMesh?: boolean }
    if (mesh.isMesh !== true || !mesh.geometry) return
    meshes++
    const pos = mesh.geometry.attributes.position
    const index = mesh.geometry.index
    triangles += (index ? index.count : pos ? pos.count : 0) / 3
    mesh.material = Array.isArray(mesh.material) ? adoptMaterial(mesh.material[0]!) : adoptMaterial(mesh.material)
  })
  scene.add(model)

  modelBox.setFromObject(model)
  const size = modelBox.getSize(new Vector3())

  if (boxHelper) {
    boxHelper.box.copy(modelBox)
    boxHelper.updateMatrixWorld(true)
  }
  clearBricks()
  frameCamera()

  return { box: modelBox.clone(), triangles, meshes, size: [size.x, size.y, size.z] }
}

export const getLoadedModel = () => model
export const getModelBox = () => modelBox.clone()

const clearBricks = () => {
  if (!bricksMesh) return
  scene.remove(bricksMesh)
  bricksMesh.geometry.dispose()
  ;(bricksMesh.material as Material).dispose()
  bricksMesh = null
}

// Build (or rebuild) the per-brick wireframe overlay from a freshly baked volume. One wireframe box per brick;
// `level` colours by brick size (red = finest) to show the adaptive subdivision, `irradiance` colours by the
// brick's baked bounce so the stored field itself is visible.
export const showBrickVolume = (volume: BrickVolume, mode: VolumeMode, visible: boolean) => {
  clearBricks()
  const bricks = enumerateBricks(volume)
  const geometry = new BoxGeometry(1, 1, 1)
  const material = new MeshBasicNodeMaterial()
  material.wireframe = true
  material.transparent = true
  material.opacity = 0.5
  const instanced = new InstancedMesh(geometry, material, bricks.length)
  instanced.frustumCulled = false
  const m = new Matrix4()
  const c = new Color()
  bricks.forEach((b, i) => {
    m.makeScale(b.size[0], b.size[1], b.size[2])
    m.setPosition(b.center[0], b.center[1], b.center[2])
    instanced.setMatrixAt(i, m)
    if (mode === 'level') {
      const col = LEVEL_COLORS[Math.min(b.level, LEVEL_COLORS.length - 1)]!
      c.setRGB(col[0], col[1], col[2])
    } else {
      c.setRGB(b.color[0] * BRICK_BOOST, b.color[1] * BRICK_BOOST, b.color[2] * BRICK_BOOST)
    }
    instanced.setColorAt(i, c)
  })
  instanced.instanceMatrix.needsUpdate = true
  if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true
  instanced.visible = visible
  scene.add(instanced)
  bricksMesh = instanced
}

export const setVolumesVisible = (on: boolean) => {
  if (bricksMesh) bricksMesh.visible = on
}

export const setBoxVisible = (on: boolean) => {
  if (boxHelper) boxHelper.visible = on
}

export const initScene = async (container: HTMLElement) => {
  if (renderer) return

  renderer = new WebGPURenderer({ antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setClearColor(0x15171c, 1)
  container.appendChild(renderer.domElement)

  scene = new Scene()
  camera = new PerspectiveCamera(50, 1, 0.1, 1000)
  camera.position.set(4, 3, 5)

  scene.add(new AmbientLight(0xffffff, 0.35))
  const sun = new DirectionalLight(0xffffff, 2.2)
  sun.position.set(0.5, 0.8, 0.3) // same direction the bake integrates the sun from
  scene.add(sun)

  boxHelper = new Box3Helper(new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)), new Color(0xffee00))
  boxHelper.visible = false
  scene.add(boxHelper)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true

  const resize = () => {
    if (!renderer) return
    const w = container.clientWidth
    const h = container.clientHeight
    if (w === 0 || h === 0) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  new ResizeObserver(resize).observe(container)

  await renderer.init()
  resize()
  renderer.setAnimationLoop(() => {
    if (!renderer) return
    controls.update()
    renderer.render(scene, camera)
  })
}
