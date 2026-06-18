// Built-in demo scene so people without a model can try the bake immediately. The classic Cornell box is
// the canonical GI test: a white room with one red and one green wall, plus two white blocks. With GI off
// the blocks and floor are flatly lit; with GI on they pick up red on the left and green on the right — the
// colour bleed APV exists to capture.

import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three'

export type ScenePreset = {
  id: string
  label: string
  build: () => Group
  params: { spacing: number; falloff: number; eps: number; maxLevel: number }
}

const WHITE = 0xcacaca
const RED = 0xb52a2a
const GREEN = 0x2a8c2a

const box = (w: number, h: number, d: number, color: number) =>
  new Mesh(new BoxGeometry(w, h, d), new MeshStandardMaterial({ color }))

// Room interior spans x,z ∈ [-1, 1] and y ∈ [0, 2]; the front (z = +1) is left open so the camera sees in.
const buildCornellBox = (): Group => {
  const g = new Group()
  const t = 0.04 // wall thickness

  const floor = box(2, t, 2, WHITE)
  floor.position.set(0, 0, 0)
  const ceiling = box(2, t, 2, WHITE)
  ceiling.position.set(0, 2, 0)
  const back = box(2, 2, t, WHITE)
  back.position.set(0, 1, -1)
  const left = box(t, 2, 2, RED)
  left.position.set(-1, 1, 0)
  const right = box(t, 2, 2, GREEN)
  right.position.set(1, 1, 0)

  const tall = box(0.6, 1.2, 0.6, WHITE)
  tall.position.set(-0.33, 0.6, -0.3)
  tall.rotation.y = 0.3
  const short = box(0.6, 0.6, 0.6, WHITE)
  short.position.set(0.38, 0.3, 0.32)
  short.rotation.y = -0.3

  g.add(floor, ceiling, back, left, right, tall, short)
  return g
}

export const PRESETS: ScenePreset[] = [
  {
    id: 'cornell',
    label: 'Cornell box',
    build: buildCornellBox,
    params: { spacing: 0.1, falloff: 1.5, eps: 0.15, maxLevel: 3 },
  },
]
