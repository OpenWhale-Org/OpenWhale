/**
 * The whale GLB: load, normalise into the sculpt's coordinate system, then
 * paint vertex colours from the same body gradient.
 *
 * Model: Humpback Whale (c) MakerRandom, Sketchfab, CC Attribution. Skinned,
 * decimated and quantised offline. Taken from the OpenWhale site so the
 * dashboard and the marketing page show the same animal.
 *
 * The file's own orientation is nose -Z, back +Y. The sculpt's is nose +X,
 * back +Y, with the body spanning x in [-1.6, 1.3] — matching it here means
 * the swim shader, the camera work and every effect carry over untouched, and
 * the procedural whale stays a drop-in fallback when the fetch fails.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { hullColor } from "./whaleSculpt";

const NOSE_X = 1.3;
const LENGTH = 2.9;

const breathe = () =>
  new Promise<void>((res) =>
    "requestIdleCallback" in window
      ? (window as Window & { requestIdleCallback: (cb: () => void, o?: { timeout: number }) => number })
          .requestIdleCallback(() => res(), { timeout: 1500 })
      : setTimeout(res, 16),
  );

export async function loadWhaleGeometry(url: string): Promise<THREE.BufferGeometry> {
  const gltf = await new GLTFLoader().loadAsync(url);
  await breathe(); // Slice the heavy work up rather than blocking a frame
  gltf.scene.updateMatrixWorld(true);

  // A quantised GLB stores attributes as Int16. Decode to Float32 BEFORE any
  // matrix work: applyMatrix4 writes back in place, and writing floats into an
  // integer buffer overflows the model into shards of glass.
  const toFloat = (att: THREE.BufferAttribute) => {
    const out = new Float32Array(att.count * 3);
    for (let i = 0; i < att.count; i++)
      out.set([att.getX(i), att.getY(i), att.getZ(i)], i * 3);
    return new THREE.BufferAttribute(out, 3);
  };
  const parts: THREE.BufferGeometry[] = [];
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.clone();
    g.setAttribute("position", toFloat(g.getAttribute("position") as THREE.BufferAttribute));
    const nrm = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
    if (nrm) g.setAttribute("normal", toFloat(nrm));
    g.applyMatrix4(m.matrixWorld);
    // Drop flat props (a base plate, a backdrop): near-zero thickness on one
    // axis is not a whale
    g.computeBoundingBox();
    const bb0 = g.boundingBox!;
    const dims = [bb0.max.x - bb0.min.x, bb0.max.y - bb0.min.y, bb0.max.z - bb0.min.z];
    if (Math.min(...dims) / Math.max(...dims) < 0.02) return;
    // Keep only position/normal, or the merge fails on mismatched attributes
    for (const name of Object.keys(g.attributes))
      if (name !== "position" && name !== "normal") g.deleteAttribute(name);
    parts.push(g);
  });
  if (!parts.length) throw new Error("humpback: no meshes in " + url);
  const geo = parts.length === 1 ? parts[0] : mergeGeometries(parts);

  // Auto-orient: longest axis onto X, then compare how fat each end is (head
  // thick, tail thin) to decide whether it needs turning around
  geo.computeBoundingBox();
  {
    const bb = geo.boundingBox!;
    const dx = bb.max.x - bb.min.x, dy = bb.max.y - bb.min.y, dz = bb.max.z - bb.min.z;
    if (dz >= dx && dz >= dy) geo.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2));
    else if (dy > dx && dy > dz) geo.applyMatrix4(new THREE.Matrix4().makeRotationZ(-Math.PI / 2));
  }
  if (fatEndAtNegX(geo)) geo.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI));

  // Normalise: body length 2.9, nose at x=+1.3, centred vertically and laterally
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const s = LENGTH / (bb.max.x - bb.min.x);
  geo.applyMatrix4(new THREE.Matrix4().makeScale(s, s, s));
  geo.computeBoundingBox();
  {
    const bb1 = geo.boundingBox!;
    const H = bb1.max.y - bb1.min.y;
    if (H > 0.95) {
      const k = 0.95 / H; // A round body needs reining in by height too, or the
                          // head fills the frame
      geo.applyMatrix4(new THREE.Matrix4().makeScale(k, k, k));
      geo.computeBoundingBox();
    }
  }
  const b2 = geo.boundingBox!;
  geo.applyMatrix4(
    new THREE.Matrix4().makeTranslation(
      NOSE_X - b2.max.x,
      -(b2.min.y + b2.max.y) / 2,
      -(b2.min.z + b2.max.z) / 2,
    ),
  );

  await breathe();
  paintHull(geo);
  if (!geo.getAttribute("normal")) geo.computeVertexNormals();
  return geo;
}

/**
 * The head end is thicker than the tail end, so a fatter -X end means the nose
 * is pointing the wrong way. Measured as cross-sectional area (height x width)
 * per bin, each bin looking only at its own slice — which is what stops an
 * upswept fluke from fooling it.
 */
function fatEndAtNegX(geo: THREE.BufferGeometry): boolean {
  const pos = geo.getAttribute("position");
  geo.computeBoundingBox();
  const { min, max } = geo.boundingBox!;
  const span = max.x - min.x;
  const B = 20;
  const yMin = new Float32Array(B).fill(Infinity), yMax = new Float32Array(B).fill(-Infinity);
  const zMin = new Float32Array(B).fill(Infinity), zMax = new Float32Array(B).fill(-Infinity);
  for (let i = 0; i < pos.count; i++) {
    const b = Math.min(B - 1, Math.max(0, Math.floor(((pos.getX(i) - min.x) / span) * B)));
    const y = pos.getY(i), z = pos.getZ(i);
    if (y < yMin[b]) yMin[b] = y;
    if (y > yMax[b]) yMax[b] = y;
    if (z < zMin[b]) zMin[b] = z;
    if (z > zMax[b]) zMax[b] = z;
  }
  const area = (b: number) =>
    yMin[b] > yMax[b] ? 0 : (yMax[b] - yMin[b]) * (zMax[b] - zMin[b]);
  let lo = 0, hi = 0;
  for (let b = 0; b < 5; b++) lo += area(b);
  for (let b = B - 5; b < B; b++) hi += area(b);
  return lo > hi;
}

/**
 * Vertex colours from the sculpt's own gradient: dark along the back, bright
 * along the belly. The dorsal coefficient is normalised per slice, so a body
 * that changes height along its length still shades correctly.
 */
function paintHull(geo: THREE.BufferGeometry) {
  const pos = geo.getAttribute("position");
  const n = pos.count;
  const BINS = 72;
  geo.computeBoundingBox();
  const { min, max } = geo.boundingBox!;
  const span = max.x - min.x;
  const yMin = new Float32Array(BINS).fill(Infinity);
  const yMax = new Float32Array(BINS).fill(-Infinity);
  const bin = (x: number) =>
    Math.min(BINS - 1, Math.max(0, Math.floor(((x - min.x) / span) * BINS)));
  for (let i = 0; i < n; i++) {
    const b = bin(pos.getX(i));
    const y = pos.getY(i);
    if (y < yMin[b]) yMin[b] = y;
    if (y > yMax[b]) yMax[b] = y;
  }
  const colors = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const b = bin(pos.getX(i));
    const h = yMax[b] - yMin[b] || 1;
    const dorsal = ((pos.getY(i) - yMin[b]) / h) * 2 - 1; // -1 belly ... +1 back
    hullColor(pos.getX(i), dorsal, c);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}
