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
// Callout labels: STATIC, stacked in a fixed vertical column along the
// container's right edge — their position never depends on the camera,
// so they can never crowd or overlap regardless of viewing angle. What
// DOES move is a thin SVG leader line + arrowhead from each label to
// its segment's current on-screen position: every render frame, the
// segment's anchor (an invisible Object3D parented into the mesh group
// at build time, in buildShaftGroup) gets projected through the camera
// into 2D, and that's the line's moving endpoint. A segment currently
// facing away from the camera just fades its line/label rather than
// letting it fly across the screen — this is a hand-rolled version of
// what three.js's CSS2DRenderer add-on does for the projection math,
// kept in-house rather than pulling in another three/examples/jsm
// subpath for a handful of labels.
//
// Requires the `three` package (add to package.json — not yet a
// dependency of this project). Any reasonably current version works.

import * as THREE from 'three'

const SVG_NS = 'http://www.w3.org/2000/svg'

const COLORS = {
  round:   0x378ADD,
  hex:     0xEF9F27,
  square:  0x639922,
  prism:   0x639922,
  unknown: 0xE24B4A,
  bore:    0xF7C1C1,
}

function colorHex(t) { return '#' + (COLORS[t] ?? COLORS.unknown).toString(16).padStart(6, '0') }

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

/** Short callout text for one segment — index + type + key dimension(s). */
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
 * Object3D positioned just outside the segment's outer radius —
 * inherits every orbit/pan/reset transform for free since it's a real
 * child of the same group the meshes are in.
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
    position: 'absolute', top: '8px', right: '8px', zIndex: '4',
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

// ── Callout layer: static label stack + dynamic SVG leader lines ────
// Labels live in a plain HTML column, each pinned to a fixed vertical
// slot (evenly spaced down the container, right-aligned) that never
// changes no matter how the camera moves — this is what actually fixes
// the crowding, since label position is now completely decoupled from
// segment screen position. Only the connecting line's far endpoint
// (the segment's projected anchor) is recomputed every frame.
function createCalloutLayer(containerEl) {
  const listEl = document.createElement('div')
  Object.assign(listEl.style, {
    position: 'absolute', inset: '0', zIndex: '2', pointerEvents: 'none',
  })
  containerEl.appendChild(listEl)

  const svg = document.createElementNS(SVG_NS, 'svg')
  Object.assign(svg.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%',
    zIndex: '1', pointerEvents: 'none',
  })
  containerEl.appendChild(svg)

  // One reusable arrowhead marker, pointing along the line toward the
  // segment (the moving end), oriented automatically per-line.
  const defs = document.createElementNS(SVG_NS, 'defs')
  const marker = document.createElementNS(SVG_NS, 'marker')
  marker.setAttribute('id', 'segPreviewArrow')
  marker.setAttribute('viewBox', '0 0 8 8')
  marker.setAttribute('refX', '7')
  marker.setAttribute('refY', '4')
  marker.setAttribute('markerWidth', '6')
  marker.setAttribute('markerHeight', '6')
  marker.setAttribute('orient', 'auto-start-reverse')
  const arrowPath = document.createElementNS(SVG_NS, 'path')
  arrowPath.setAttribute('d', 'M0,0 L8,4 L0,8 Z')
  arrowPath.setAttribute('fill', 'rgba(250,250,249,0.6)')
  marker.appendChild(arrowPath)
  defs.appendChild(marker)
  svg.appendChild(defs)

  let entries = []   // [{ anchorObject3D, el, line }]
  const worldPos = new THREE.Vector3()

  function setAnchors(labelAnchors) {
    entries.forEach(e => { e.el.remove(); e.line.remove() })
    const n = (labelAnchors || []).length

    entries = (labelAnchors || []).map(({ segment, index, object3D }, i) => {
      const el = document.createElement('div')
      el.textContent = segmentLabelText(segment, index)
      Object.assign(el.style, {
        position: 'absolute', right: '8px',
        top: `${((i + 1) / (n + 1)) * 100}%`,
        transform: 'translateY(-50%)',
        background: 'rgba(28,28,26,0.9)', color: '#fafaf9',
        border: `1px solid ${colorHex(segment.type)}`,
        borderRadius: '5px', padding: '2px 6px',
        fontSize: '10.5px', fontFamily: 'inherit', whiteSpace: 'nowrap',
        transition: 'opacity 0.15s',
      })
      listEl.appendChild(el)

      const line = document.createElementNS(SVG_NS, 'line')
      line.setAttribute('stroke', 'rgba(250,250,249,0.5)')
      line.setAttribute('stroke-width', '1')
      line.setAttribute('marker-end', 'url(#segPreviewArrow)')
      line.style.transition = 'opacity 0.15s'
      svg.appendChild(line)

      return { anchorObject3D: object3D, el, line }
    })
  }

  /** Called every render frame. Projects each segment's anchor into
   *  screen space and redraws its leader line from the (fixed) label
   *  position to that (moving) point. */
  function update(camera) {
    for (const { anchorObject3D, el, line } of entries) {
      anchorObject3D.getWorldPosition(worldPos)
      const ndc = worldPos.clone().project(camera)
      const facingCamera = ndc.z >= -1 && ndc.z <= 1

      const containerRect = { w: containerEl.clientWidth, h: containerEl.clientHeight }
      const ax = (ndc.x * 0.5 + 0.5) * containerRect.w
      const ay = (-ndc.y * 0.5 + 0.5) * containerRect.h

      el.style.opacity = facingCamera ? '1' : '0.35'
      line.style.opacity = facingCamera ? '1' : '0'

      // Leader line starts at the label's own left edge, vertically
      // centered — offsetLeft/offsetTop are safe here since the label
      // is absolutely positioned via fixed top/right, not measured
      // relative to the moving 3D content.
      line.setAttribute('x1', el.offsetLeft)
      line.setAttribute('y1', el.offsetTop + el.offsetHeight / 2)
      line.setAttribute('x2', ax)
      line.setAttribute('y2', ay)
    }
  }

  function destroy() {
    entries.forEach(e => { e.el.remove(); e.line.remove() })
    listEl.remove()
    svg.remove()
  }

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

  const calloutLayer = createCalloutLayer(containerEl)

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
    calloutLayer.update(camera)
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
    calloutLayer.destroy()
    renderer.dispose()
  }

  return {
    setGroup(newGroup) {
      scene.remove(group)
      group = newGroup
      scene.add(group)
      calloutLayer.setAnchors(group.userData.labelAnchors)
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
 * an interactive 3D view with static per-segment callout labels and
 * dynamic leader lines. Safe to call repeatedly on the same element —
 * reuses the existing renderer/camera/controls/callout layer and just
 * swaps the mesh group + labels, so calling this on every
 * segmentEditor.js edit is cheap (shafts top out around 5 segments in
 * practice).
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
 *  render loop (and its label/leader-line DOM nodes) per prior open. */
export function disposeSegmentPreview3D(containerEl) {
  const rig = rigsByContainer.get(containerEl)
  if (!rig) return
  rig.destroy()
  rigsByContainer.delete(containerEl)
}