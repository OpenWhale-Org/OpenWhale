'use client'

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { createWhale, createWhaleGeometry, type Whale } from '../lib/whaleSculpt'
import { loadWhaleGeometry } from '../lib/whaleModel'

/**
 * Strategies as a pod: one whale per instance, swimming in open water.
 *
 * The same animal and the same lighting language as the site's dive scene —
 * rim light carries profit and loss (green up, red down), the body itself stays
 * dark so a grid of them reads as silhouettes rather than as noise. There is no
 * hero whale here: on the site one whale is the product, on this page every
 * whale is one of the operator's own instances.
 *
 * Camera: drag orbits, wheel dollies, arrow keys pan. Deliberately hand-rolled
 * rather than OrbitControls — this needs to share the pointer with hover
 * picking and click-to-select, and controls that swallow events fight that.
 */

export interface WhaleDatum {
  id: string
  name: string
  strategyId: string
  active: boolean
  /** Net PnL, when known. Drives the rim colour. */
  pnl?: number | undefined
  icon?: string | undefined
}

/** Orbit state, in the spherical terms the camera is rebuilt from each frame. */
interface Orbit { theta: number; phi: number; radius: number; target: THREE.Vector3 }

/* Brain placement, taken from the site rather than eyeballed.
   There BRAIN_C is (0, 5.2, -24.2) as a world offset from a whale drawn at
   GIANT_SCALE = 26, and the model's +X faces world -Z — so in the whale's own
   model space that is (24.2/26, 5.2/26, 0). Its size is 10.6 world units
   against a body 2.9 x 26 = 75.4 long, i.e. 14% of body length. Both are held
   as ratios here so they survive whatever scale a pod whale is drawn at. */
const BRAIN_AT = new THREE.Vector3(24.2 / 26, 5.2 / 26, 0)
const BRAIN_TO_BODY = 10.6 / (2.9 * 26)
/** Model-space body length, from the sculpt and matched by the GLB loader. */
const BODY_LENGTH = 2.9

/** Where the camera starts, and what Reset puts it back to. */
const HOME = { theta: 0.7, phi: 1.35, radius: 96 }

const RIM_UP = 0x3fbf6e
const RIM_UP_2 = 0x7fe0a4
const RIM_DOWN = 0xd85f6a
const RIM_DOWN_2 = 0xf09aa2
const RIM_FLAT = 0x8f7ae0
const RIM_FLAT_2 = 0xc9b8ff

/**
 * Where each whale sits.
 *
 * A golden-angle spiral on a sphere shell, not a grid: whales at right angles
 * to each other read as furniture, and a ring reads as a menu. Jitter comes
 * from the index rather than Math.random so a reload puts every instance back
 * where the operator last saw it.
 */
function layout(i: number, n: number): THREE.Vector3 {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  const a = golden * i
  const shell = 34 + (i % 3) * 7
  return new THREE.Vector3(Math.cos(a) * r * shell, y * shell * 0.42, Math.sin(a) * r * shell)
}

export function WhaleField({ instances, selectedId, onHover, onSelect }: {
  instances: WhaleDatum[]
  selectedId: string | null
  /** `screen` also carries the canvas size, so the caller can keep its card inside it. */
  onHover: (id: string | null, screen: { x: number; y: number; w: number; h: number } | null) => void
  onSelect: (id: string | null) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  /* The scene owns the camera, so Reset is published out of the effect rather
     than driven by a prop — a prop would have to change to fire, which means
     inventing a counter for "put it back where it already is". */
  const resetRef = useRef<() => void>(() => {})
  const [ready, setReady] = useState(false)
  // The render loop reads these through refs: it runs outside React, and
  // rebuilding the scene on every hover would defeat the point.
  const dataRef = useRef(instances)
  dataRef.current = instances
  const selRef = useRef(selectedId)
  selRef.current = selectedId
  const hoverCbRef = useRef(onHover)
  hoverCbRef.current = onHover
  const selectCbRef = useRef(onSelect)
  selectCbRef.current = onSelect

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(host.clientWidth, host.clientHeight)
    host.appendChild(renderer.domElement)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.touchAction = 'none'
    renderer.domElement.style.cursor = 'grab'

    const scene = new THREE.Scene()
    // Depth cue: distant whales dissolve into the water rather than shrinking
    // into legible little models, which is what sells this as an ocean.
    scene.fog = new THREE.FogExp2(0x080b16, 0.0075)

    const camera = new THREE.PerspectiveCamera(46, host.clientWidth / host.clientHeight, 0.5, 3000)
    const orbit: Orbit = { ...HOME, target: new THREE.Vector3(0, 0, 0) }
    /* Where the camera is being asked to go. While a whale is selected the
       frame eases toward it every frame; the rest of the time `want` simply
       tracks `orbit` so dragging stays direct with nothing to fight. */
    const want = { radius: orbit.radius, target: orbit.target.clone() }
    const applyCamera = () => {
      const { theta, phi, radius, target } = orbit
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.sin(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * Math.sin(phi) * Math.cos(theta),
      )
      camera.lookAt(target)
    }
    applyCamera()

    /* Motes in the water. Without them an orbit reads as the whales turning
       rather than the camera moving — there is no parallax against empty fog. */
    const motePos = new Float32Array(700 * 3)
    for (let i = 0; i < 700; i++) {
      const r = 90 + Math.random() * 320
      const th = Math.random() * Math.PI * 2
      const ph = Math.acos(2 * Math.random() - 1)
      motePos[i * 3] = r * Math.sin(ph) * Math.cos(th)
      motePos[i * 3 + 1] = r * Math.cos(ph) * 0.5
      motePos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th)
    }
    const moteGeo = new THREE.BufferGeometry()
    moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3))
    const moteMat = new THREE.PointsMaterial({
      color: 0x9db4ff, size: 1.5, sizeAttenuation: true,
      transparent: true, opacity: 0.5, depthWrite: false,
    })
    const motes = new THREE.Points(moteGeo, moteMat)
    scene.add(motes)

    scene.add(new THREE.AmbientLight(0x6d7bd6, 0.75))
    const key = new THREE.DirectionalLight(0xbfa9ff, 1.5)
    key.position.set(40, 70, 30)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0x4a6bd8, 0.7)
    fill.position.set(-50, -20, -40)
    scene.add(fill)

    /* ---- the pod ----
       The procedural sculpt renders immediately and the real model swaps in
       behind it, exactly as the site does. A slow network still gets a whale;
       it just gets the rougher one for a moment. */
    const geo = createWhaleGeometry()
    let modelGeo: THREE.BufferGeometry | null = null
    let dead = false
    interface Pod {
      w: Whale
      home: THREE.Vector3
      id: string
      hot: number
      sel: number
      phase: number
      bob: number
      /** Cruise loop: two incommensurate rates and how far it ranges. */
      driftA: number
      driftB: number
      range: number
      /** The way it faces. Set once — a pod that all points one way reads as a
          pod; one deriving heading from its path reads as debris. */
      heading: number
      /** Per-whale weight on the roll wobble, so the pod is not one metronome. */
      wobble: number
      baseScale: number
      up: boolean | null
    }
    const pod: Pod[] = []
    const build = () => {
      for (const p of pod) {
        scene.remove(p.w.root)
        ;(p.w.mesh.material as THREE.Material).dispose()
      }
      pod.length = 0
      const list = dataRef.current
      list.forEach((d, i) => {
        const w = createWhale(6.5 + (i % 3) * 1.1, modelGeo ?? geo)
        const mat = w.mesh.material as THREE.MeshPhysicalMaterial
        // Body pressed almost black so the rim does the talking, exactly as on
        // the site — a lit body at this density turns the field into porridge.
        mat.color.setScalar(0.12)
        mat.transparent = true
        const pnl = d.pnl
        const up = pnl === undefined ? null : pnl >= 0
        w.uniforms.uRim.value.set(up === null ? RIM_FLAT : up ? RIM_UP : RIM_DOWN)
        w.uniforms.uRim2.value.set(up === null ? RIM_FLAT_2 : up ? RIM_UP_2 : RIM_DOWN_2)
        // A stopped instance still swims, just barely: a motionless whale reads
        // as a broken render, not as "not running".
        w.uniforms.uAmp.value = d.active ? 0.11 : 0.035
        w.uniforms.uSpeed.value = (d.active ? 1.4 : 0.5) + (i % 4) * 0.09
        w.uniforms.uPhase.value = i * 1.7
        const home = layout(i, list.length)
        w.root.position.copy(home)
        w.mesh.userData.podIndex = i
        scene.add(w.root)
        pod.push({
          w, home, id: d.id, hot: 0, sel: 0, phase: i * 1.7,
          bob: 0.6 + (i % 5) * 0.21,
          // Slow enough to read as cruising rather than orbiting: a full loop
          // takes the better part of a minute, over a radius comparable to the
          // whale's own length.
          driftA: 0.085 + (i % 7) * 0.011,
          driftB: 0.071 + (i % 5) * 0.014,
          range: 11 + (i % 4) * 4,
          // Loosely a shoal: all within a quarter turn of each other.
          heading: -0.4 + ((i * 0.37) % 1) * 0.8,
          wobble: 0.5 + (i % 5) * 0.23,
          baseScale: 6.5 + (i % 3) * 1.1,
          up,
        })
      })
    }
    build()

    /* Swap in the real body once it lands. The wave envelope has to be
       re-derived from the new bounding box — the model is shorter in the tail
       than the sculpt, so the sculpt's envelope would sway the wrong half —
       and the amplitude is tripled because a short fluke needs an exaggerated
       stroke before the motion reads at all. */
    loadWhaleGeometry('/models/whale.glb')
      .then((real) => {
        if (dead) return
        real.computeBoundingBox()
        const bb = real.boundingBox!
        const span = bb.max.x - bb.min.x
        const envA = bb.min.x + span * 0.55
        const envB = bb.min.x + span * 0.02
        for (const p of pod) {
          p.w.mesh.geometry = real
          p.w.uniforms.uEnvA.value = envA
          p.w.uniforms.uEnvB.value = envB
          p.w.uniforms.uAmp.value = Math.min(0.2, p.w.uniforms.uAmp.value * 3)
          p.w.uniforms.uTailLift.value = 2.2
          // The fin gate in the shader is expressed in model-space thresholds
          // tuned against the sculpt. The GLB is a rounder body, so the same
          // gain reads weaker on it — lifted until the pectorals actually
          // stroke, and varied per whale so they are not in unison.
          p.w.uniforms.uFinFlap.value = 0.17 + (pod.indexOf(p) % 3) * 0.02
        }
        modelGeo = real
      })
      .catch(() => { /* the sculpt stays — never leave the view empty */ })

    /* The brain, shown only during a close-up: additive fresnel shell, the same
       material the site's compiler act uses. */
    const brainHost = new THREE.Group()
    brainHost.visible = false
    scene.add(brainHost)
    const brainUniforms = { uColor: { value: new THREE.Color('#a78bfa') }, uIntensity: { value: 0 } }
    const brainMat = new THREE.ShaderMaterial({
      uniforms: brainUniforms,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uIntensity;
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          // Guard the normalize: a zero-length normal yields NaN, and one NaN
          // pixel spreads through any blur into a black frame.
          vec3 n = vNormal / max(length(vNormal), 1e-4);
          vec3 v = vView / max(length(vView), 1e-4);
          float d = clamp(abs(dot(n, v)), 0.0, 1.0);
          float fr = pow(max(1.0 - d, 0.0), 1.6);
          gl_FragColor = vec4(uColor * (0.12 + 1.1 * fr) * uIntensity, 1.0);
        }`,
    })
    new GLTFLoader().load('/models/brain.glb', (gltf) => {
      if (dead) return
      const box = new THREE.Box3().setFromObject(gltf.scene)
      const size = box.getSize(new THREE.Vector3())
      const centre = box.getCenter(new THREE.Vector3())
      // Normalised to one unit here; the real size is set on the host, which
      // lives in the whale's model space.
      const k = 1 / Math.max(size.x, size.y, size.z)
      gltf.scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        // This GLB carries POSITION/TEXCOORD only; fresnel needs normals.
        if (!m.geometry.attributes.normal) m.geometry.computeVertexNormals()
        m.material = brainMat
        m.renderOrder = 5
        m.frustumCulled = false
      })
      gltf.scene.scale.setScalar(k)
      gltf.scene.position.copy(centre.multiplyScalar(-k))
      brainHost.add(gltf.scene)
    })

    /* Hover sonar: rings widening out of the whale's body centre.
       Flat rings turned to face the camera, NOT sphere shells — under a wide
       FOV a shell projects to an ellipse the further it sits from screen
       centre, and what this wants to read as is a plain circular ping. */
    const SONAR_N = 3
    const sonarGeo = new THREE.RingGeometry(0.988, 1, 96)
    const sonars = Array.from({ length: SONAR_N }, (_, i) => {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x8ef0b4, transparent: true, opacity: 0,
        depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      })
      const m = new THREE.Mesh(sonarGeo, mat)
      m.visible = false
      m.renderOrder = 6
      scene.add(m)
      return { m, mat, ph: i / SONAR_N } // three offset phases, so the ping never breaks
    })

    /* ---- pointer: orbit, pick, select ---- */
    const picker = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const pointer = { x: 0, y: 0, inside: false }
    let hovered = -1
    const drag = { on: false, x: 0, y: 0, moved: 0 }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      drag.on = true
      drag.x = e.clientX
      drag.y = e.clientY
      drag.moved = 0
      renderer.domElement.setPointerCapture(e.pointerId)
      renderer.domElement.style.cursor = 'grabbing'
    }
    const onPointerMove = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect()
      pointer.x = e.clientX - r.left
      pointer.y = e.clientY - r.top
      pointer.inside = true
      if (!drag.on) return
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      drag.x = e.clientX
      drag.y = e.clientY
      drag.moved += Math.abs(dx) + Math.abs(dy)
      orbit.theta -= dx * 0.005
      // Clamped short of the poles: at phi=0 the up vector degenerates and the
      // view snaps through itself.
      orbit.phi = Math.min(Math.PI - 0.12, Math.max(0.12, orbit.phi - dy * 0.005))
      // Orbiting during a close-up should turn AROUND the subject, not drift
      // off it, so only the angles move and the framing stands.
      applyCamera()
    }
    const onPointerUp = (e: PointerEvent) => {
      const wasDrag = drag.moved > 4
      drag.on = false
      renderer.domElement.style.cursor = 'grab'
      try { renderer.domElement.releasePointerCapture(e.pointerId) } catch { /* already gone */ }
      // A drag that ends over a whale is a camera move, not a selection.
      if (wasDrag) return
      selectCbRef.current(hovered >= 0 ? (pod[hovered]?.id ?? null) : null)
    }
    const onPointerLeave = () => {
      pointer.inside = false
      if (hovered !== -1) { hovered = -1; hoverCbRef.current(null, null) }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      orbit.radius = Math.min(320, Math.max(12, orbit.radius * (1 + Math.sign(e.deltaY) * 0.12)))
      want.radius = orbit.radius // the wheel wins over an in-flight close-up
      applyCamera()
    }

    /* Arrow keys pan the camera across the water, in the camera's own frame —
       panning in world axes means the keys stop matching the screen the moment
       you orbit. Held keys are integrated per frame, not per keydown repeat,
       so the glide is smooth and the OS repeat delay does not show. */
    const held = new Set<string>()
    const PAN_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
    const onKeyDown = (e: KeyboardEvent) => {
      if (!PAN_KEYS.has(e.key)) return
      // Only when the field has focus, or the arrow keys would hijack the page.
      if (!host.contains(document.activeElement) && document.activeElement !== document.body) return
      e.preventDefault()
      held.add(e.key)
    }
    const onKeyUp = (e: KeyboardEvent) => { held.delete(e.key) }

    const el = renderer.domElement
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointerleave', onPointerLeave)
    el.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    resetRef.current = () => {
      selectCbRef.current(null)
      orbit.theta = HOME.theta
      orbit.phi = HOME.phi
      orbit.radius = HOME.radius
      orbit.target.set(0, 0, 0)
      want.radius = HOME.radius
      want.target.set(0, 0, 0)
      applyCamera()
    }

    const resize = () => {
      if (!host.clientWidth || !host.clientHeight) return
      camera.aspect = host.clientWidth / host.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(host.clientWidth, host.clientHeight)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host)

    /* ---- frame ---- */
    const clock = new THREE.Clock()
    const right = new THREE.Vector3()
    const fwd = new THREE.Vector3()
    const bodyCentre = new THREE.Vector3()
    let brainFade = 0
    let brainParent: string | null = null
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(clock.getDelta(), 0.05)
      const t = clock.elapsedTime

      if (held.size) {
        camera.getWorldDirection(fwd)
        right.crossVectors(fwd, camera.up).normalize()
        // Pan speed scales with distance, so the drift feels the same whether
        // you are inside the pod or looking at all of it.
        const step = orbit.radius * 0.9 * dt
        const move = new THREE.Vector3()
        if (held.has('ArrowUp')) move.addScaledVector(fwd, step)
        if (held.has('ArrowDown')) move.addScaledVector(fwd, -step)
        if (held.has('ArrowLeft')) move.addScaledVector(right, -step)
        if (held.has('ArrowRight')) move.addScaledVector(right, step)
        // Flatten the forward component: arrow keys should slide the view, not
        // dive it — that is the wheel's job.
        move.y = 0
        orbit.target.add(move)
        want.target.copy(orbit.target)
        applyCamera()
      }

      if (pointer.inside && !drag.on) {
        ndc.set(
          (pointer.x / renderer.domElement.clientWidth) * 2 - 1,
          -(pointer.y / renderer.domElement.clientHeight) * 2 + 1,
        )
        picker.setFromCamera(ndc, camera)
        const hit = picker.intersectObjects(pod.map(p => p.w.mesh), false)[0]
        const now = hit ? (hit.object.userData.podIndex as number) : -1
        if (now !== hovered) {
          hovered = now
          el.style.cursor = now >= 0 ? 'pointer' : (drag.on ? 'grabbing' : 'grab')
          hoverCbRef.current(
            now >= 0 ? (pod[now]?.id ?? null) : null,
            now >= 0 ? { x: pointer.x, y: pointer.y, w: el.clientWidth, h: el.clientHeight } : null,
          )
        } else if (now >= 0) {
          hoverCbRef.current(pod[now]?.id ?? null, { x: pointer.x, y: pointer.y, w: el.clientWidth, h: el.clientHeight })
        }
      }

      for (let i = 0; i < pod.length; i++) {
        const p = pod[i]!
        const isHot = hovered === i
        const isSel = selRef.current === p.id
        // Eased rather than switched: a whale that snaps to bright on hover
        // reads as a bug, and the ring of them flickers as the pointer travels.
        p.hot += ((isHot ? 1 : 0) - p.hot) * Math.min(1, dt * 8)
        p.sel += ((isSel ? 1 : 0) - p.sel) * Math.min(1, dt * 8)
        const lift = Math.max(p.hot, p.sel)

        p.w.uniforms.uTime.value = t
        /* Heading is FIXED, and only wobbles.
           Deriving it from the path's velocity was wrong: the path is a closed
           loop, so the heading swept a full turn every cycle, and taking pitch
           from the vertical component sent whales nose-up the moment their
           horizontal speed passed through zero. They tumbled. The site does
           none of that — its pod holds a heading and adds three small sines,
           and the swimming reads from the BODY animation (tail and pectorals),
           not from the whale being flown around. Same here. */
        p.w.root.position.set(
          p.home.x + Math.sin(t * 0.27 + p.phase * 1.6) * p.range,
          p.home.y + Math.sin(t * 0.42 + p.phase) * p.bob,
          p.home.z + Math.sin(t * 0.2 + p.phase) * p.range * 0.7,
        )
        p.w.root.rotation.y = p.heading + Math.sin(t * 0.19 + p.phase) * 0.1
        p.w.root.rotation.x = Math.cos(t * 0.42 + p.phase) * 0.055
        p.w.root.rotation.z = Math.sin(t * 0.33 + p.phase * 0.7) * 0.13 * p.wobble
        p.w.root.scale.setScalar(p.baseScale * (1 + lift * 0.1))

        const dist = camera.position.distanceTo(p.w.root.position)
        // Visibility falls off with distance, and hovering parts the water in
        // front of the one you are pointing at.
        const clear = 1 - 0.55 * smooth(70, 240, dist)
        const mat = p.w.mesh.material as THREE.MeshPhysicalMaterial
        mat.opacity = clear + (1 - clear) * lift
        mat.color.setScalar(0.12 + lift * 0.16)
      }

      /* Close-up. The subject is framed LEFT of centre, which is done by
         pushing the look-at point to its right rather than by moving the
         camera — offsetting the camera would also swing the angle, and the
         angle is the operator's to set by dragging. */
      {
        const chosen = pod.find(x => x.id === selRef.current)
        if (chosen) {
          camera.getWorldDirection(fwd)
          right.crossVectors(fwd, camera.up).normalize()
          want.radius = chosen.baseScale * 4.2
          want.target.copy(chosen.w.root.position).addScaledVector(right, want.radius * 0.34)
        } else {
          want.radius = orbit.radius
          want.target.copy(orbit.target)
        }
        const k = 1 - Math.pow(0.001, dt) // frame-rate independent easing
        orbit.radius += (want.radius - orbit.radius) * k
        orbit.target.lerp(want.target, k)
        applyCamera()

        // The brain rides in the head, fading up with the close-up and only
        // then — a glowing skull inside every whale in a wide shot is noise.
        //
        // Parented to the whale's `orient` group rather than positioned in
        // world space: inside it the units ARE model units, so BRAIN_AT and
        // the size ratio apply directly, and the head keeps carrying the brain
        // through every turn and tail-beat without a frame of lag.
        const bt = chosen ? 1 : 0
        brainFade += (bt - brainFade) * Math.min(1, dt * 3)
        brainHost.visible = brainFade > 0.01
        if (chosen && brainParent !== chosen.id) {
          chosen.w.orient.add(brainHost)
          brainHost.position.copy(BRAIN_AT)
          brainHost.rotation.set(0, 0, 0)
          brainHost.scale.setScalar(BODY_LENGTH * BRAIN_TO_BODY)
          brainParent = chosen.id
        } else if (!chosen && brainParent !== null) {
          scene.add(brainHost) // detach, so a rebuilt pod cannot orphan it
          brainParent = null
        }
        brainUniforms.uIntensity.value = brainFade * (0.9 + 0.25 * Math.sin(t * 2.2))
      }

      {
        const p = hovered >= 0 ? pod[hovered] : null
        if (p) {
          p.w.mesh.updateWorldMatrix(true, false)
          const bb = p.w.mesh.geometry.boundingBox
          if (bb) {
            bb.getCenter(bodyCentre)
            bodyCentre.applyMatrix4(p.w.mesh.matrixWorld)
          } else bodyCentre.copy(p.w.root.position)
          const R = p.baseScale * 2
          for (const sn of sonars) {
            const u = (t * 0.5 + sn.ph) % 1
            sn.m.visible = true
            sn.m.position.copy(bodyCentre)
            sn.m.lookAt(camera.position) // always square to the lens -> a true circle
            sn.m.scale.setScalar(R * (0.12 + u * 0.95))
            sn.mat.color.set(p.up === false ? 0xffa2ad : p.up === null ? 0xc9b8ff : 0x8ef0b4)
            sn.mat.opacity = 0.85 * (1 - u) * (1 - u) * p.hot
          }
        } else {
          for (const sn of sonars) sn.m.visible = false
        }
      }

      motes.rotation.y = t * 0.006

      renderer.render(scene, camera)
    }
    tick()
    setReady(true)

    return () => {
      dead = true
      scene.add(brainHost) // off the whale before the pod is torn down
      cancelAnimationFrame(raf)
      ro.disconnect()
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointerleave', onPointerLeave)
      el.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      for (const p of pod) (p.w.mesh.material as THREE.Material).dispose()
      for (const sn of sonars) sn.mat.dispose()
      brainMat.dispose()
      modelGeo?.dispose()
      sonarGeo.dispose()
      moteGeo.dispose()
      moteMat.dispose()
      geo.dispose()
      renderer.dispose()
      el.remove()
    }
    // Rebuilt when the pod's shape changes. Hover and selection travel through
    // refs precisely so they do NOT land here and tear the scene down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instances.map(i => `${i.id}:${i.active}:${i.pnl ?? ''}`).join('|')])

  return (
    <div
      ref={hostRef}
      tabIndex={0}
      className="relative w-full rounded-lg overflow-hidden outline-none"
      style={{
        height: 'calc(100vh - 22rem)',
        minHeight: 420,
        background: 'radial-gradient(120% 90% at 50% 0%, #101736 0%, #070a14 62%, #05070f 100%)',
        border: '1px solid var(--border)',
      }}
    >
      {!ready && (
        <div className="absolute inset-0 grid place-items-center text-xs" style={{ color: 'var(--muted)' }}>
          Diving…
        </div>
      )}
      {/* Bottom-left, opposite the dossier, so it never sits under one. */}
      <button
        type="button"
        onClick={() => resetRef.current()}
        className="absolute left-3 bottom-3 z-10 h-8 px-3 rounded-md text-xs flex items-center gap-1.5"
        style={{
          background: 'color-mix(in srgb, var(--surface) 88%, transparent)',
          color: 'var(--foreground)',
          border: '1px solid var(--border)',
          backdropFilter: 'blur(8px)',
        }}
        title="Back to the opening view"
      >
        ⟲ Reset view
      </button>
    </div>
  )
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
