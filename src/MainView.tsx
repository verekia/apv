import { useEffect, useRef, useState } from 'react'

import { bakeIrradiance, gridResolution } from './apv/bake'
import { brickStats, buildBricks } from './apv/bricks'
import { gzipBuffer, serializeBrickVolume } from './apv/format'
import type { BrickVolume } from './apv/format'
import { applyVolume, setGiEnabled, setGiIntensity } from './apv/volume'
import {
  getLoadedModel,
  getModelBox,
  initScene,
  loadModelFromFile,
  loadSceneObject,
  setBoxVisible,
  setVolumesVisible,
  showBrickVolume,
} from './apv-scene'
import type { ModelInfo, VolumeMode } from './apv-scene'
import { PRESETS } from './presets'
import type { ScenePreset } from './presets'

type BakeConfig = { spacing: number; falloff: number; eps: number; maxLevel: number }
type Stats = { probes: number; bricks: number; atlas: string; kb: number; gzip: number; grid: string }

const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2))

export const MainView = () => {
  const viewportRef = useRef<HTMLDivElement>(null)
  const lastVolume = useRef<BrickVolume | null>(null)

  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [model, setModel] = useState<ModelInfo | null>(null)
  const [cfg, setCfg] = useState<BakeConfig>({ spacing: 1, falloff: 6, eps: 0.2, maxLevel: 3 })
  const [status, setStatus] = useState('Load the demo scene, or drop a .glb / .gltf model.')
  const [baking, setBaking] = useState(false)
  const [stats, setStats] = useState<Stats | null>(null)

  const [giOn, setGiOn] = useState(true)
  const [giIntensity, setGiInt] = useState(1)
  const [volumesOn, setVolumesOn] = useState(false)
  const [volumeMode, setVolumeMode] = useState<VolumeMode>('level')
  const [boxOn, setBoxOn] = useState(true)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!viewportRef.current) return
    initScene(viewportRef.current)
      .then(() => {
        setReady(true)
        if (PRESETS[0]) loadPreset(PRESETS[0]) // start with the demo scene so there's always something to bake
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'WebGPU is not available in this browser.'))
  }, [])

  // Reset GI/stats for a freshly loaded model and seed the bake config from its size (overridable per preset).
  const afterLoad = (info: ModelInfo, overrides?: Partial<BakeConfig>) => {
    const maxDim = Math.max(...info.size)
    setCfg({
      spacing: overrides?.spacing ?? Math.max(0.05, Math.round((maxDim / 24) * 100) / 100),
      falloff: overrides?.falloff ?? Math.max(0.1, Math.round((maxDim / 6) * 100) / 100),
      eps: overrides?.eps ?? 0.2,
      maxLevel: overrides?.maxLevel ?? 3,
    })
    setStats(null)
    lastVolume.current = null
    setGiEnabled(false)
    setModel(info)
    setBoxVisible(boxOn)
  }

  const loadPreset = (preset: ScenePreset) => {
    const info = loadSceneObject(preset.build())
    afterLoad(info, preset.params)
    setStatus(`Loaded ${preset.label} — bake to see the GI.`)
  }

  const onFile = async (file: File) => {
    if (!/\.(glb|gltf)$/i.test(file.name)) {
      setStatus(`Unsupported file: ${file.name}`)
      return
    }
    setStatus(`Loading ${file.name}…`)
    try {
      const info = await loadModelFromFile(file)
      afterLoad(info)
      setStatus(`Loaded ${file.name} — ${info.meshes} meshes, ${info.triangles.toLocaleString()} triangles.`)
    } catch (e) {
      setStatus(`Failed to load: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) void onFile(file)
  }

  const runBake = async () => {
    const model3d = getLoadedModel()
    if (!model3d || baking) return
    setBaking(true)
    const box = getModelBox()
    const [nx, ny, nz] = gridResolution(box, cfg.spacing)
    setStatus(`Baking… 0 / ? probes`)
    try {
      const sparse = await bakeIrradiance(model3d, box, { spacing: cfg.spacing, falloff: cfg.falloff }, (done, total) =>
        setStatus(`Baking… ${done} / ${total} probes`),
      )
      setStatus('Building bricks…')
      await new Promise(r => setTimeout(r, 0))
      const brick = buildBricks(sparse, { eps: cfg.eps, maxLevel: cfg.maxLevel })
      lastVolume.current = brick
      applyVolume(brick)
      setGiEnabled(giOn)
      setGiIntensity(giIntensity)
      showBrickVolume(brick, volumeMode, volumesOn)

      const st = brickStats(brick)
      const raw = await gzipBuffer(serializeBrickVolume(brick))
      setStats({
        probes: sparse.idx.length,
        bricks: st.bricks,
        atlas: st.atlasDims.join('×'),
        kb: Math.round(st.bytes / 1024),
        gzip: Math.round(raw.byteLength / 1024),
        grid: `${nx}×${ny}×${nz}`,
      })
      setStatus('Bake complete.')
    } catch (e) {
      setStatus(`Bake failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBaking(false)
    }
  }

  const download = async () => {
    if (!lastVolume.current) return
    const raw = await gzipBuffer(serializeBrickVolume(lastVolume.current))
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/octet-stream' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'volume.apv.gz'
    a.click()
    URL.revokeObjectURL(url)
  }

  const toggleGi = (on: boolean) => {
    setGiOn(on)
    setGiEnabled(on)
  }
  const changeIntensity = (v: number) => {
    setGiInt(v)
    setGiIntensity(v)
  }
  const toggleVolumes = (on: boolean) => {
    setVolumesOn(on)
    setVolumesVisible(on)
  }
  const changeVolumeMode = (mode: VolumeMode) => {
    setVolumeMode(mode)
    if (lastVolume.current) showBrickVolume(lastVolume.current, mode, volumesOn)
  }
  const toggleBox = (on: boolean) => {
    setBoxOn(on)
    setBoxVisible(on)
  }

  const num = (key: keyof BakeConfig, label: string, step: number, min: number) => (
    <label className="row">
      <span>{label}</span>
      <input
        type="number"
        value={cfg[key]}
        step={step}
        min={min}
        onChange={e => setCfg(p => ({ ...p, [key]: Number(e.target.value) }))}
      />
    </label>
  )

  return (
    <div
      className="app"
      onDragOver={e => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <aside className="panel">
        <h1>APV</h1>
        <p className="sub">Adaptive Probe Volume GI for Three.js TSL — bake, render, inspect.</p>

        <section>
          <h2>Model</h2>
          {PRESETS.map(p => (
            <button key={p.id} disabled={!ready} onClick={() => loadPreset(p)}>
              Load {p.label}
            </button>
          ))}
          <label className="file-btn">
            …or choose .glb / .gltf
            <input
              type="file"
              accept=".glb,.gltf"
              hidden
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) void onFile(f)
              }}
            />
          </label>
          {model && (
            <dl className="stats">
              <dt>Bounding box</dt>
              <dd>
                {fmt(model.size[0])} × {fmt(model.size[1])} × {fmt(model.size[2])}
              </dd>
              <dt>Meshes / tris</dt>
              <dd>
                {model.meshes} / {model.triangles.toLocaleString()}
              </dd>
            </dl>
          )}
        </section>

        <section>
          <h2>Bake parameters</h2>
          {num('spacing', 'Probe spacing', 0.05, 0.05)}
          {num('falloff', 'Distance falloff', 0.1, 0.1)}
          {num('eps', 'Coarsen ε', 0.01, 0)}
          {num('maxLevel', 'Max level', 1, 0)}
          <button className="primary" disabled={!ready || !model || baking} onClick={() => void runBake()}>
            {baking ? 'Baking…' : 'Bake GI'}
          </button>
          <p className="status">{status}</p>
        </section>

        {stats && (
          <section>
            <h2>Bake result</h2>
            <dl className="stats">
              <dt>Grid</dt>
              <dd>{stats.grid}</dd>
              <dt>Probes</dt>
              <dd>{stats.probes.toLocaleString()}</dd>
              <dt>Bricks</dt>
              <dd>{stats.bricks.toLocaleString()}</dd>
              <dt>Atlas</dt>
              <dd>{stats.atlas}</dd>
              <dt>VRAM</dt>
              <dd>{stats.kb} KB</dd>
              <dt>File (gzip)</dt>
              <dd>{stats.gzip} KB</dd>
            </dl>
            <button onClick={() => void download()}>Download volume.apv.gz</button>
          </section>
        )}

        <section>
          <h2>Render</h2>
          <label className="row check">
            <input type="checkbox" checked={giOn} onChange={e => toggleGi(e.target.checked)} />
            <span>Apply GI</span>
          </label>
          <label className="row">
            <span>GI intensity</span>
            <input
              type="range"
              min={0}
              max={4}
              step={0.05}
              value={giIntensity}
              onChange={e => changeIntensity(Number(e.target.value))}
            />
            <span className="val">{giIntensity.toFixed(2)}</span>
          </label>
          <label className="row check">
            <input type="checkbox" checked={volumesOn} onChange={e => toggleVolumes(e.target.checked)} />
            <span>Show volumes</span>
          </label>
          <label className="row">
            <span>Volume colour</span>
            <select value={volumeMode} onChange={e => changeVolumeMode(e.target.value as VolumeMode)}>
              <option value="level">By level</option>
              <option value="irradiance">By irradiance</option>
            </select>
          </label>
          <label className="row check">
            <input type="checkbox" checked={boxOn} onChange={e => toggleBox(e.target.checked)} />
            <span>Show bounding box</span>
          </label>
        </section>

        <footer>
          <a href="https://github.com/verekia/apv" target="_blank" rel="noreferrer">
            Source & docs
          </a>
        </footer>
      </aside>

      <main className="viewport" ref={viewportRef}>
        {error && <div className="overlay error">{error}</div>}
        {!error && !model && (
          <div className={`overlay drop ${dragging ? 'active' : ''}`}>Drop a .glb / .gltf model</div>
        )}
      </main>
    </div>
  )
}
