// src/segmentPreview3D.js
//
// Interactive 3D reconstruction of an axial-shaft segment list — the
// shared renderer both the Designer confirm overlay and the Fabricate
// job detail modal call into (see SHAFT_3D_PREVIEW_ROADMAP.md). Reads
// the exact same `segments[]` shape reconstructAxialSegments() and
// segmentEditor.js already use — no new data model.
//
// Controls mirror Onshape: left-drag orbit, right-drag pan, scroll
// zoom, one-finger drag orbit / two-finger pinch zoom on touch — all
// unified through the Pointer Events API. A built-in reset-view button
// re-fits the camera and clears any orbit/pan.
//
// Callout labels: each segment gets an anchor point (attached as a
// child of the mesh group at build time, in buildShaftGroup) sitting
// just outside its outer radius. Every render frame, each anchor's
// current WORLD position is projected through the camera into 2D
// screen space and a small floating HTML label is repositioned there —
// this is a hand-rolled version of what three.js's CSS2DRenderer
// add-on does, kept in-house rather than pulling in another
// three/examples/jsm subpath for a handful of labels. Because the
// anchors are parented to the same group the meshes are, they inherit
// every orbit/rotation/reset automatically — no separate label-tracking
// logic needed for interaction, only for the screen-space projection.
//
// Requires the `three` package (add to package.json — not yet a
// dependency of this project). Any reasonably current version works.

import * as THREE from 'three'

const COLORS = {
  round:   0x378ADD,
  hex:     0xEF9F27,
  square:  0x639922,
  prism:   0x639922,
  unknown: 0xE24B4A,
  bore:    0xF7C1C1,
}

function segmentRadius(seg) {
  if (seg.type === 'round') return (seg.diameter || 0) / 2
  if (seg.type === 'hex')   return (seg.acrossFlats || 0) / 2 / Math.cos(Math.PI / 6)
  return Math.SQRT2 * (seg.width || 0) / 2   // bounding radius for square/prism/unknown
}

function meshForSegment(seg) {
  const len = seg.length || 0
  const color = COLORS[seg.type] ?? COLORS.unknown
  const hasBore = seg.innerDiameter != null
  let geo

  if (seg.type === 'round') {
    const r = (seg.diameter || 0) / 2
    geo = new THREE.CylinderGeometry(r, r, len, 32)
  } else if (seg.type === 'hex') {
    const rCirc = (seg.acrossFlats || 0) / 2 / Math.cos(Math.PI / 6)
    geo = new THREE.CylinderGeometry(rCirc, rCirc, len, 6)
  } else if (seg.type === 'square' || seg.type === 'prism') {
    const w = seg.width || 0
    geo = new THREE.BoxGeometry(w, len, w)
  } else {
    geo = new THREE.CylinderGeometry(0.05, 0.05, len, 8)
  }

  const material = new THREE.MeshStandardMaterial({
    color, roughness: 0.55, metalness: 0.15,
    transparent: hasBore,
    opacity: hasBore ? 0.5 : 1,
    depthWrite: !hasBore,
  })
  return new THREE.Mesh(geo, material)
}

function boreMesh(seg) {
  if (seg.innerDiameter == null) return null
  const r = seg.innerDiameter / 2
  const geo = new THREE.CylinderGeometry(r, r, (seg.length || 0) * 1.08, 20)
  const mat = new THREE.MeshBasicMaterial({ color: COLORS.bore })
  return new THREE.Mesh(geo, mat)
}

/** Short callout text for one segment — index + type + key dimension(s),
 *  matching the abbreviations the 2D preview / spec summary already use
 *  elsewhere, so the same shaft reads consistently across views. */
function segmentLabelText(seg, index) {
  const len = seg.length != null ? seg.length.toFixed(3) : '?'
  const bore = seg.innerDiameter != null ? ` · ID ${seg.innerDiameter.toFixed(3)}"` : ''

  if (seg.type === 'round') {
    const dia = seg.diameter != null ? seg.diameter.toFixed(3) : '?'
    return `#${index + 1} · ⌀${dia}" × ${len}"${bore}`
  }
  if (seg.type === 'hex') {
    const af = seg.acrossFlats != null ? seg.acrossFlats.toFixed(3) : '?'
    return `#${index + 1} · Hex ${af}" AF × ${len}"${bore}`
  }
  if (seg.type === 'square' || seg.type === 'prism') {
    const w = seg.width != null ? seg.width.toFixed(3) : '?'
    return `#${index + 1} · ${w}" sq × ${len}"`
  }
  return `#${index + 1} · ${seg.type} × ${len}" (unrecognized)`
}

/**
 * Builds one Group containing every segment mesh (+ illustrative
 * bores), stacked along the Y axis by cumulative length and centered
 * on the group's own origin. Pure — no DOM, no renderer.
 *
 * Also attaches `group.userData.labelAnchors`: one { segment, index,
 * object3D } entry per segment, where `object3D` is an invisible child
 * Object3D positioned just outside the segment's outer radius. Callers
 * that only want the mesh (buildShaftGroup used standalone) can ignore
 * this; createRig's label layer below is what actually reads it.
 */
export function buildShaftGroup(segments) {
  const group = new THREE.Group()
  group.userData.labelAnchors = []
  if (!segments || !segments.length) return group

  const totalLength = segments.reduce((s, seg) => s + (seg.length || 0), 0)
  let cursor = -totalLength / 2

  segments.forEach((seg, index) => {
    const len = seg.length || 0
    const mesh = meshForSegment(seg)
    mesh.position.y = cursor + len / 2
    group.add(mesh)

    const bore = boreMesh(seg)
    if (bore) { bore.position.y = cursor + len / 2; group.add(bore) }

    // Invisible anchor, offset outward from the segment's own radius so
    // the label sits just off the surface rather than overlapping it.
    const r = segmentRadius(seg)
    const anchor = new THREE.Object3D()
    anchor.position.set(r * 1.15 + 0.03, cursor + len / 2, 0)
    group.add(anchor)
    group.userData.labelAnchors.push({ segment: seg, index, object3D: anchor })

    cursor += len
  })

  group.rotation.z = Math.PI / 2
  return group
}

export function maxSegmentRadius(segments) {
  return Math.max(0.05, ...(segments || []).map(segmentRadius))
}

export function totalSegmentLength(segments) {
  return (segments || []).reduce((s, seg) => s + (seg.length || 0), 0)
}

const MIN_DISTANCE_SCALE = 0.35
const MAX_DISTANCE_SCALE = 3.5
function clampDistanceScale(v) {
  return Math.min(MAX_DISTANCE_SCALE, Math.max(MIN_DISTANCE_SCALE, v))
}

// ── Reset-view button ──────────────────────────────────────────────
function createResetButton(containerEl, onClick) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.title = 'Reset view'
  btn.setAttribute('aria-label', 'Reset view')
  btn.textContent = '⟲'
  Object.assign(btn.style, {
    position: 'absolute', top: '8px', right: '8px', zIndex: '3',
    width: '28px', height: '28px', borderRadius: '999px',
    border: '0.5px solid rgba(255,255,255,0.25)',
    background: 'rgba(0,0,0,0.45)', color: '#fafaf9',
    fontSize: '15px', lineHeight: '1', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '0', userSelect: 'none',
  })
  btn.addEventListener('pointerdown', e => e.stopPropagation())
  btn.addEventListener('click', onClick)
  containerEl.appendChild(btn)
  return btn
}

// ── Callout label layer ─────────────────────────────────────────────
// One `<div>` per current segment, floating over the canvas. Rebuilt
// whenever the mesh group changes (new/edited segments); repositioned
// every render frame by projecting each anchor's world position
// through the camera. `pointer-events: none` on the whole layer so
// labels never intercept orbit/pan/pinch gestures aimed at the canvas
// underneath them.
function createLabelLayer(containerEl) {
  const layer = document.createElement('div')
  Object.assign(layer.style, {
    position: 'absolute', inset: '0', zIndex: '1',
    pointerEvents: 'none', overflow: 'hidden',
  })
  containerEl.appendChild(layer)

  let entries = []   // [{ anchorObject3D, el }]
  const worldPos = new THREE.Vector3()

  function setAnchors(labelAnchors) {
    entries.forEach(e => e.el.remove())
    entries = (labelAnchors || []).map(({ segment, index, object3D }) => {
      const el = document.createElement('div')
      el.textContent = segmentLabelText(segment, index)
      Object.assign(el.style, {
        position: 'absolute', transform: 'translate(-50%, -50%)',
        background: 'rgba(28,28,26,0.88)', color: '#fafaf9',
        border: `1px solid #${(COLORS[segment.type] ?? COLORS.unknown).toString(16).padStart(6, '0')}`,
        borderRadius: '5px', padding: '2px 6px',
        fontSize: '10.5px', fontFamily: 'inherit', whiteSpace: 'nowrap',
        pointerEvents: 'none',
      })
      layer.appendChild(el)
      return { anchorObject3D: object3D, el }
    })
  }

  function update(camera, containerEl) {
    const w = containerEl.clientWidth, h = containerEl.clientHeight
    if (!w || !h) return
    for (const { anchorObject3D, el } of entries) {
      anchorObject3D.getWorldPosition(worldPos)
      const ndc = worldPos.clone().project(camera)
      // Behind the camera, or projected way off to the side — hide
      // rather than let it fly across the canvas.
      if (ndc.z > 1 || ndc.z < -1) { el.style.display = 'none'; continue }
      el.style.display = ''
      el.style.left = `${(ndc.x * 0.5 + 0.5) * w}px`
      el.style.top  = `${(-ndc.y * 0.5 + 0.5) * h}px`
    }
  }

  function destroy() { entries.forEach(e => e.el.remove()); layer.remove() }

  return { setAnchors, update, destroy }
}

// ── Scene rig — one per container, reused across re-renders ──────────
const rigsByContainer = new WeakMap()

function createRig(containerEl) {
  const w = containerEl.clientWidth || 320
  const h = containerEl.clientHeight || 220

  if (getComputedStyle(containerEl).position === 'static') {
    containerEl.style.position = 'relative'
  }

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(35, w / h, 0.01, 200)
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setSize(w, h)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  containerEl.innerHTML = ''
  containerEl.appendChild(renderer.domElement)

  containerEl.style.touchAction = 'none'
  containerEl.style.userSelect = 'none'
  containerEl.addEventListener('contextmenu', e => e.preventDefault())

  scene.add(new THREE.AmbientLight(0x888888, 0.7))
  const key = new THREE.DirectionalLight(0xffffff, 0.9)
  key.position.set(3, 4, 5)
  scene.add(key)

  let group = new THREE.Group()
  scene.add(group)

  const labelLayer = createLabelLayer(containerEl)

  const viewDir = new THREE.Vector3(0.7, 0.5, 0.9).normalize()
  const target = new THREE.Vector3(0, 0, 0)
  let baseDistance = 3
  let distanceScale = 1
  let lastRadius = 1
  let lastLength = 1

  function positionCamera() {
    const d = baseDistance * distanceScale
    camera.position.copy(target).addScaledVector(viewDir, d)
    camera.lookAt(target)
  }

  function frame(radius, length) {
    lastRadius = radius
    lastLength = length
    baseDistance = Math.max(radius * 3.2, length * 1.4, 1.2)
    distanceScale = 1
    target.set(0, 0, 0)
    positionCamera()
  }

  function resetView() {
    group.rotation.x = 0
    group.rotation.y = 0
    frame(lastRadius, lastLength)
  }

  const resetBtn = createResetButton(containerEl, resetView)

  // ── Pointer tracking (mouse + touch, unified) ───────────────────
  const active = new Map()
  let mode = null
  let lastX = 0, lastY = 0
  let pinchStartDist = 0
  let pinchStartScale = 1

  function pointDistance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return
    containerEl.setPointerCapture?.(e.pointerId)
    active.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (active.size === 1) {
      mode = (e.pointerType === 'mouse' && e.button === 2) ? 'pan' : 'rotate'
      lastX = e.clientX; lastY = e.clientY
    } else if (active.size === 2) {
      mode = 'pinch'
      const pts = [...active.values()]
      pinchStartDist = pointDistance(pts[0], pts[1])
      pinchStartScale = distanceScale
    }
  }

  function onPointerMove(e) {
    if (!active.has(e.pointerId)) return
    active.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (mode === 'rotate' && active.size === 1) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY
      group.rotation.y += dx * 0.008
      group.rotation.x += dy * 0.008
      lastX = e.clientX; lastY = e.clientY
    } else if (mode === 'pan' && active.size === 1) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY
      const panSpeed = baseDistance * distanceScale * 0.0018
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
      const up    = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
      target.addScaledVector(right, -dx * panSpeed)
      target.addScaledVector(up,     dy * panSpeed)
      positionCamera()
      lastX = e.clientX; lastY = e.clientY
    } else if (mode === 'pinch' && active.size === 2) {
      const pts = [...active.values()]
      const dist = pointDistance(pts[0], pts[1])
      if (dist > 0 && pinchStartDist > 0) {
        distanceScale = clampDistanceScale(pinchStartScale * (pinchStartDist / dist))
        positionCamera()
      }
    }
  }

  function endPointer(e) {
    active.delete(e.pointerId)
    containerEl.releasePointerCapture?.(e.pointerId)
    if (active.size === 0) {
      mode = null
    } else if (active.size === 1) {
      const [p] = [...active.values()]
      mode = 'rotate'
      lastX = p.x; lastY = p.y
    }
  }

  function onWheel(e) {
    e.preventDefault()
    distanceScale = clampDistanceScale(distanceScale * (1 + e.deltaY * 0.001))
    positionCamera()
  }

  containerEl.addEventListener('pointerdown', onPointerDown)
  containerEl.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', endPointer)
  window.addEventListener('pointercancel', endPointer)
  containerEl.addEventListener('wheel', onWheel, { passive: false })

  let rafId = null
  function loop() {
    renderer.render(scene, camera)
    labelLayer.update(camera, containerEl)
    rafId = requestAnimationFrame(loop)
  }
  loop()

  function destroy() {
    cancelAnimationFrame(rafId)
    containerEl.removeEventListener('pointerdown', onPointerDown)
    containerEl.removeEventListener('pointermove', onPointerMove)
    containerEl.removeEventListener('wheel', onWheel)
    window.removeEventListener('pointerup', endPointer)
    window.removeEventListener('pointercancel', endPointer)
    resetBtn.remove()
    labelLayer.destroy()
    renderer.dispose()
  }

  return {
    setGroup(newGroup) {
      scene.remove(group)
      group = newGroup
      scene.add(group)
      labelLayer.setAnchors(group.userData.labelAnchors)
    },
    frame,
    resize() {
      const w2 = containerEl.clientWidth, h2 = containerEl.clientHeight
      if (!w2 || !h2) return
      camera.aspect = w2 / h2
      camera.updateProjectionMatrix()
      renderer.setSize(w2, h2)
    },
    destroy,
  }
}

/**
 * Renders (or re-renders) a shaft's segment list into `containerEl` as
 * an interactive 3D view with per-segment callout labels. Safe to call
 * repeatedly on the same element — reuses the existing renderer/camera/
 * controls/label layer and just swaps the mesh group + label set, so
 * calling this on every segmentEditor.js edit is cheap (shafts top out
 * around 5 segments in practice).
 */
export function renderSegmentPreview3D(containerEl, segments) {
  if (!containerEl) return

  let rig = rigsByContainer.get(containerEl)
  if (!rig) {
    rig = createRig(containerEl)
    rigsByContainer.set(containerEl, rig)
  }

  const group = buildShaftGroup(segments || [])
  rig.setGroup(group)
  rig.frame(maxSegmentRadius(segments), totalSegmentLength(segments))
}

/** Call whenever a preview container is about to stop being used — the
 *  confirm overlay closing, or the Fabricate job detail modal
 *  re-rendering/closing. IMPORTANT: each rig runs its own
 *  requestAnimationFrame loop that does NOT stop on its own just
 *  because the element is removed from the DOM — a caller that
 *  replaces a container's innerHTML (as both current call sites do, on
 *  every re-render) without calling this first leaks one running
 *  render loop (and now also one set of label DOM nodes) per prior
 *  open. */
export function disposeSegmentPreview3D(containerEl) {
  const rig = rigsByContainer.get(containerEl)
  if (!rig) return
  rig.destroy()
  rigsByContainer.delete(containerEl)
}