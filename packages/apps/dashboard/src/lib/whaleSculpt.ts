/**
 * The whale, built in code rather than loaded as a model.
 *
 * Lifted from the OpenWhale site's dive scene (app/_journey/whaleSculpt.ts), so
 * the strategies view and the marketing page show the same animal. Procedural
 * on purpose: no .glb to ship, fetch or version, and one shared BufferGeometry
 * serves however many instances the operator has.
 *
 * Two halves: the geometry (hull sections lofted along the body, plus fluke and
 * pectorals), and a MeshPhysicalMaterial whose vertex shader carries a
 * travelling wave so each whale swims on its own phase.
 */

import * as THREE from "three";

export const SCULPT_MODULE_ID = "whale-body";

/* ------------------------------------------------------------------ palette */

// Sampled from the reference: near-black rostrum, deep indigo back,
// bright violet belly / fins / fluke.
const C_HEAD = new THREE.Color("#08060f");
const C_BACK = new THREE.Color("#221650");
const C_BELLY = new THREE.Color("#43307a");
const C_FIN = new THREE.Color("#33255f");
const C_FIN_TIP = new THREE.Color("#5d48a8");

/* ------------------------------------------------------------------- maths */

function sstep(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** Catmull-Rom sample of an ordered scalar track, u in [0,1] over the track. */
function track(values: number[], u: number) {
  const n = values.length - 1;
  const f = Math.min(1, Math.max(0, u)) * n;
  let i = Math.floor(f);
  if (i > n - 1) i = n - 1;
  const t = f - i;
  return catmull(
    values[Math.max(i - 1, 0)],
    values[i],
    values[i + 1],
    values[Math.min(i + 2, n)],
    t,
  );
}

/* ----------------------------------------------------------- mesh assembler */

class SurfaceBuilder {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  vertex(x: number, y: number, z: number, c: THREE.Color) {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    return i;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  /** a,b,c,d must wind counter-clockwise as seen from outside. */
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }

  finish() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/* ------------------------------------------------------------ hull sections */

// Ordered elliptical cross-sections, nose (+X) to peduncle (-X).
// ryTop / ryBot are split so the belly can stay fuller than the back,
// which is what makes the reference read as a rorqual rather than a tube.
type Section = { x: number; ryTop: number; ryBot: number; rz: number; cy: number };

const SECTIONS: Section[] = [
  { x: 1.245, ryTop: 0.028, ryBot: 0.028, rz: 0.026, cy: 0.0 },
  { x: 1.235, ryTop: 0.062, ryBot: 0.061, rz: 0.058, cy: -0.004 },
  { x: 1.205, ryTop: 0.108, ryBot: 0.11, rz: 0.1, cy: -0.01 },
  { x: 1.15, ryTop: 0.165, ryBot: 0.172, rz: 0.152, cy: -0.02 },
  { x: 1.06, ryTop: 0.225, ryBot: 0.25, rz: 0.208, cy: -0.032 },
  { x: 0.92, ryTop: 0.282, ryBot: 0.33, rz: 0.258, cy: -0.044 },
  { x: 0.74, ryTop: 0.318, ryBot: 0.398, rz: 0.292, cy: -0.052 },
  { x: 0.54, ryTop: 0.33, ryBot: 0.435, rz: 0.305, cy: -0.05 },
  { x: 0.32, ryTop: 0.328, ryBot: 0.418, rz: 0.302, cy: -0.038 },
  { x: 0.08, ryTop: 0.305, ryBot: 0.358, rz: 0.28, cy: -0.018 },
  { x: -0.17, ryTop: 0.262, ryBot: 0.284, rz: 0.238, cy: 0.0 },
  { x: -0.42, ryTop: 0.228, ryBot: 0.232, rz: 0.206, cy: 0.012 },
  { x: -0.68, ryTop: 0.186, ryBot: 0.176, rz: 0.158, cy: 0.024 },
  { x: -0.92, ryTop: 0.142, ryBot: 0.124, rz: 0.11, cy: 0.034 },
  { x: -1.14, ryTop: 0.1, ryBot: 0.082, rz: 0.066, cy: 0.04 },
  { x: -1.33, ryTop: 0.068, ryBot: 0.054, rz: 0.04, cy: 0.043 },
  { x: -1.48, ryTop: 0.048, ryBot: 0.038, rz: 0.026, cy: 0.044 },
  { x: -1.56, ryTop: 0.038, ryBot: 0.03, rz: 0.02, cy: 0.044 },
];

const T_X = SECTIONS.map((s) => s.x);
const T_RT = SECTIONS.map((s) => s.ryTop);
const T_RB = SECTIONS.map((s) => s.ryBot);
const T_RZ = SECTIONS.map((s) => s.rz);
const T_CY = SECTIONS.map((s) => s.cy);

/**
 * Two-tone body gradient. `dorsal` is cos(theta): +1 at the spine, -1 at the belly.
 * The split line climbs toward the tail, matching the reference, where the violet
 * underside wraps up onto the peduncle while the rostrum stays nearly black.
 */
export function hullColor(x: number, dorsal: number, out: THREE.Color) {
  const split = -0.1 + 0.52 * sstep(-0.35, -1.4, x);
  const t = sstep(split - 0.07, split + 0.11, dorsal);
  out.copy(C_BELLY).lerp(C_BACK, t);
  // The rostrum reads near-black in the reference, but only above the split line.
  out.lerp(C_HEAD, sstep(0.05, 1.1, x) * t);
  return out;
}

/* ------------------------------------------------------------------- pieces */

const RINGS = 160;
const RADIAL = 46;

function buildHull(b: SurfaceBuilder) {
  const grid: number[][] = [];
  const c = new THREE.Color();

  for (let r = 0; r <= RINGS; r++) {
    const u = r / RINGS;
    const x = track(T_X, u);
    const rt = track(T_RT, u);
    const rb = track(T_RB, u);
    const rz = track(T_RZ, u);
    const cy = track(T_CY, u);

    const ring: number[] = [];
    for (let j = 0; j < RADIAL; j++) {
      const th = (j / RADIAL) * Math.PI * 2;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      const ry = rb + (rt - rb) * ((cs + 1) * 0.5);
      ring.push(b.vertex(x, cy + ry * cs, rz * sn, hullColor(x, cs, c)));
    }
    grid.push(ring);
  }

  for (let r = 0; r < RINGS; r++) {
    for (let j = 0; j < RADIAL; j++) {
      const j2 = (j + 1) % RADIAL;
      b.quad(grid[r][j], grid[r + 1][j], grid[r + 1][j2], grid[r][j2]);
    }
  }

  // Caps: nose apex points +X, peduncle apex points -X.
  const nose = b.vertex(T_X[0] + 0.012, T_CY[0], 0, hullColor(1.25, 0.6, c));
  for (let j = 0; j < RADIAL; j++) {
    b.tri(nose, grid[0][j], grid[0][(j + 1) % RADIAL]);
  }
  const last = SECTIONS.length - 1;
  const tail = b.vertex(T_X[last] - 0.012, T_CY[last], 0, hullColor(-1.6, 0, c));
  for (let j = 0; j < RADIAL; j++) {
    b.tri(tail, grid[RINGS][(j + 1) % RADIAL], grid[RINGS][j]);
  }
}

const FLUKE_STATIONS = 64;
const FLUKE_CHORD = 18;

function buildFluke(b: SurfaceBuilder) {
  const c = new THREE.Color();
  const loops: number[][] = [];

  for (let i = 0; i <= FLUKE_STATIONS; i++) {
    const s = (i / FLUKE_STATIONS) * 2 - 1; // -1 = port tip, +1 = starboard tip
    const a = Math.abs(s);
    const z = Math.sign(s) * 0.58 * Math.pow(a, 0.85);
    const lead = -1.38 - 0.45 * Math.pow(a, 1.35); // Root chord reaches forward, growing out of the peduncle
    const trail = -1.6 - 0.3 * Math.pow(a, 0.75); // centre notch at a = 0
    const lift = 0.044 + 0.1 * a * a; // tips sweep up
    const half = 0.038 * Math.pow(1 - a, 0.62);

    const loop: number[] = [];
    for (let k = 0; k < FLUKE_CHORD * 2; k++) {
      const up = k <= FLUKE_CHORD;
      const v = up ? k / FLUKE_CHORD : (FLUKE_CHORD * 2 - k) / FLUKE_CHORD;
      const x = lead + (trail - lead) * v;
      const tk = half * Math.pow(Math.sin(Math.PI * v), 0.75);
      const rootBlend = Math.min(1, a / 0.26); // Root sinks into the back colour; only the spread transitions to fin colour
      c.copy(C_BACK).lerp(C_FIN, 0.2 + 0.8 * rootBlend).lerp(C_FIN_TIP, a * 0.75);
      loop.push(b.vertex(x, lift + (up ? tk : -tk), z, c));
    }
    loops.push(loop);
  }

  const n = FLUKE_CHORD * 2;
  for (let i = 0; i < FLUKE_STATIONS; i++) {
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      b.quad(loops[i][k], loops[i][k2], loops[i + 1][k2], loops[i + 1][k]);
    }
  }
}

const FIN_STATIONS = 30;
const FIN_CHORD = 14;

function buildPectoral(b: SurfaceBuilder, side: 1 | -1) {
  const c = new THREE.Color();
  const loops: number[][] = [];

  for (let i = 0; i <= FIN_STATIONS; i++) {
    const u = i / FIN_STATIONS;
    const cx = 0.36 - 0.56 * Math.pow(u, 1.1);
    const cy = -0.24 - 0.16 * u - 0.08 * u * u;
    const cz = side * (0.2 + 0.365 * u); // Root is buried in the body and emerges gradually where it breaks the surface
    const chord = 0.34 * (1 - 0.78 * u);
    const lead = cx + chord * 0.45;
    const trail = cx - chord * 0.55;
    const half = 0.036 * Math.pow(1 - u, 0.62);

    const loop: number[] = [];
    for (let k = 0; k < FIN_CHORD * 2; k++) {
      const up = k <= FIN_CHORD;
      const v = up ? k / FIN_CHORD : (FIN_CHORD * 2 - k) / FIN_CHORD;
      const x = lead + (trail - lead) * v;
      const tk = half * Math.pow(Math.sin(Math.PI * v), 0.75); // Rounder edge, to kill the blade-edge highlight
      const rootBlend = Math.min(1, u / 0.28); // Root colour sinks into the body; it only brightens once clear of it
      c.copy(C_BELLY).lerp(C_FIN, 0.25 + 0.75 * rootBlend).lerp(C_FIN_TIP, u * 0.6);
      loop.push(b.vertex(x, cy + (up ? tk : -tk), cz, c));
    }
    loops.push(loop);
  }

  const n = FIN_CHORD * 2;
  for (let i = 0; i < FIN_STATIONS; i++) {
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      if (side > 0) {
        b.quad(loops[i][k], loops[i][k2], loops[i + 1][k2], loops[i + 1][k]);
      } else {
        b.quad(loops[i][k], loops[i + 1][k], loops[i + 1][k2], loops[i][k2]);
      }
    }
  }
}

/**
 * One welded geometry: hull + fluke + both pectorals, model forward = +X.
 * Not memoised on purpose — the caller owns the lifetime, so a scene can share
 * one instance across a pod and dispose it exactly once on unmount.
 */
export const HULL_RINGS = RINGS;
export const HULL_RADIAL = RADIAL;

export function createWhaleGeometry() {
  const b = new SurfaceBuilder();
  buildHull(b);
  buildFluke(b);
  buildPectoral(b, 1);
  buildPectoral(b, -1);
  return b.finish();
}

/* ----------------------------------------------------------------- material */

export type WhaleUniforms = {
  uTime: { value: number };
  uPhase: { value: number };
  uEnvA: { value: number };
  uEnvB: { value: number };
  uTailLift: { value: number };
  uFinFlap: { value: number };
  uAmp: { value: number };
  uSpeed: { value: number };
  uRim: { value: THREE.Color };
  uRim2: { value: THREE.Color };
};

const SWIM_GLSL = /* glsl */ `
  uniform float uTime;
  uniform float uPhase;
  uniform float uAmp;
  uniform float uSpeed;
  uniform float uEnvA; // Envelope start (head end — no sway)
  uniform float uEnvB; // Envelope end (fluke tip — full sway)

  float sstepD(float e0, float e1, float x) {
    float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
  }

  uniform float uTailLift; // Fluke-curl gain: the higher up the tail (larger y), the harder it swings. 0 = off
  uniform float uFinFlap;  // Pectoral stroke gain (only the part extending out from the flank takes this)

  // The gain's y ramp has to be smooth: max(0,y) has a kink at the midline, and
  // a discontinuity in the rate of displacement cuts a straight highlight down the flank
  float tailRamp(float y) {
    float s = clamp((y + 0.22) / 0.55, 0.0, 1.0);
    return y * s * s * (3.0 - 2.0 * s);
  }

  // Cetaceans undulate dorso-ventrally, so the travelling wave displaces Y.
  // -0.5 bias: the model's tail already rests upswept, so the sway centre is pushed
  // down — the upstroke stops at +0.5 and the downstroke reaches -1.5
  // Pectorals: the part reaching out from the flank strokes along, lagging the body
  // slightly in phase — it reads as waving
  float finWave(float x, float y, float z) {
    // The flank is widest at about |z|=0.30 and the pectorals only reach 0.5. The
    // hinge has to sit further in than that: keying on |z| alone dips inside the
    // body width and drags the whole side of the belly along (which is what made
    // two separate stretches of the body appear to move). The low term is the
    // real gate: only geometry below the belly line takes it, so the flank above
    // the belly line is untouched.
    float side = smoothstep(0.24, 0.38, abs(z)); // hinge pulled inside the body width
    float fore = smoothstep(-0.05, 0.35, x);       // pectorals live on the front half
    float low  = smoothstep(-0.11, -0.23, y);      // and strictly below the belly line
    return uFinFlap * side * fore * low
      * sin(2.05 * x + uSpeed * uTime + uPhase - 0.9);
  }

  float whaleWave(float x, float y) {
    float env = pow(sstepD(uEnvA, uEnvB, x), 1.7) * (1.0 + tailRamp(y) * uTailLift);
    // x0.5 overall: the bias already holds the sway below the resting upsweep; this
    // reins the downstroke depth in a little further
    return uAmp * env * (sin(2.05 * x + uSpeed * uTime + uPhase) - 2.0) * 0.5;
  }
`;

/** Fresh material + its own uniform block, so every whale can swim out of phase. */
export function createWhaleMaterial() {
  const uniforms: WhaleUniforms = {
    uTime: { value: 0 },
    uPhase: { value: 0 },
    uEnvA: { value: 0.9 },
    uEnvB: { value: -1.6 },
    uTailLift: { value: 0 },
    uFinFlap: { value: 0.11 },
    uAmp: { value: 0.12 },
    uSpeed: { value: 1.7 },
    uRim: { value: new THREE.Color("#9a7bff") },
    uRim2: { value: new THREE.Color("#c9b8ff") },
  };

  const mat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.4,
    metalness: 0.05,
    clearcoat: 0.35,           // wet-looking water sheen
    clearcoatRoughness: 0.6,
    sheen: 0.6,                // velvety rim light, violet
    sheenColor: new THREE.Color("#b9a6ff"),
    sheenRoughness: 0.8,
    iridescence: 0.28,         // thin-film iridescence: a pearl shift with viewing angle
    iridescenceIOR: 1.25,
    side: THREE.FrontSide,
  });

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${SWIM_GLSL}`)

      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>
         float wDeriv = 0.42 * (whaleWave(position.x + 0.01, position.y) - whaleWave(position.x - 0.01, position.y)) / 0.02;
         objectNormal = normalize(vec3(objectNormal.x - wDeriv * objectNormal.y, objectNormal.y, objectNormal.z));`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         transformed.y += whaleWave(position.x, position.y)
                        + finWave(position.x, position.y, position.z);`,
      );

    // Two-tone flowing rim: violet<->cyan drifting slowly with angle and time, with a
    // second tighter glow layered on the narrow edge
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uRim;\nuniform vec3 uRim2;\nuniform float uTime;")
      .replace(
        "#include <opaque_fragment>",
        `float ndv = clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0);
         float rim = pow(1.0 - ndv, 3.0);
         float rimTight = pow(1.0 - ndv, 6.0);
         vec3 iri = mix(uRim, uRim2, 0.5 + 0.5 * sin(uTime * 0.6 + rim * 8.0));
         outgoingLight += iri * rim * 1.2 + uRim * rimTight * 0.6;
         #include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => "whale-swim";

  return { material: mat, uniforms };
}

/* -------------------------------------------------------------- action rig */

export type Whale = {
  /** World node: position + heading (YXZ euler: pitch, yaw, roll). */
  root: THREE.Group;
  /** Model-space node, rotated so the +X model forward faces -Z world forward. */
  orient: THREE.Group;
  mesh: THREE.Mesh;
  uniforms: WhaleUniforms;
};

export function createWhale(scale = 1, shared?: THREE.BufferGeometry): Whale {
  const geometry = shared ?? createWhaleGeometry();
  const { material, uniforms } = createWhaleMaterial();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  const orient = new THREE.Group();
  orient.rotation.y = Math.PI / 2; // model +X  ->  world -Z
  orient.add(mesh);

  const root = new THREE.Group();
  root.rotation.order = "YXZ";
  root.scale.setScalar(scale);
  root.add(orient);

  return { root, orient, mesh, uniforms };
}
