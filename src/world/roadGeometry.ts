import type { MeshBuilder } from './meshBuilder';
import type { RoadEdge } from './roadNetwork';

export type Pt = { x: number; y: number; z: number };

/** Emits an upward-facing quad regardless of point order. */
export function quadUp(b: MeshBuilder, p0: Pt, p1: Pt, p2: Pt, p3: Pt, uv?: [number, number, number, number, number, number, number, number]) {
  const ax = p1.x - p0.x;
  const az = p1.z - p0.z;
  const bx = p3.x - p0.x;
  const bz = p3.z - p0.z;
  const ny = az * bx - ax * bz;
  if (ny >= 0) b.quad(p0, p1, p2, p3, uv);
  else b.quad(p0, p3, p2, p1, uv ? [uv[0], uv[1], uv[6], uv[7], uv[4], uv[5], uv[2], uv[3]] : undefined);
}

export function triUp(b: MeshBuilder, p0: Pt, p1: Pt, p2: Pt) {
  const ny = (p1.z - p0.z) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.z - p0.z);
  if (ny >= 0) b.tri(p0, p1, p2);
  else b.tri(p0, p2, p1);
}

/** Upward triangle with world-space UVs (x/scale, −z/scale). */
export function triUpUV(b: MeshBuilder, p0: Pt, p1: Pt, p2: Pt, scale: number) {
  const uv = (p: Pt): [number, number] => [p.x * scale, -p.z * scale];
  const ny = (p1.z - p0.z) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.z - p0.z);
  const [a, c, d] = ny >= 0 ? [p0, p1, p2] : [p0, p2, p1];
  b.tri(a, c, d, [...uv(a), ...uv(c), ...uv(d)] as [number, number, number, number, number, number]);
}

/** Upward quad with world-space UVs. */
export function quadUpUV(b: MeshBuilder, p0: Pt, p1: Pt, p2: Pt, p3: Pt, scale: number) {
  const uv = (p: Pt): [number, number] => [p.x * scale, -p.z * scale];
  quadUp(b, p0, p1, p2, p3, [...uv(p0), ...uv(p1), ...uv(p2), ...uv(p3)] as [number, number, number, number, number, number, number, number]);
}

/** Edge-local → world helper: s along x0→x1, l along edge.right. */
export function ep(e: RoadEdge, s: number, l: number, y: number): Pt {
  return { x: e.x0 + e.dx * s + e.rx * l, y, z: e.z0 + e.dz * s + e.rz * l };
}

export function edgeStripe(b: MeshBuilder, e: RoadEdge, s0: number, s1: number, l0: number, l1: number, y: number) {
  quadUp(b, ep(e, s0, l0, y), ep(e, s1, l0, y), ep(e, s1, l1, y), ep(e, s0, l1, y));
}

export function dashed(b: MeshBuilder, e: RoadEdge, s0: number, s1: number, l: number, w: number, dash: number, gap: number, y: number) {
  for (let s = s0; s < s1; s += dash + gap) edgeStripe(b, e, s, Math.min(s + dash, s1), l - w / 2, l + w / 2, y);
}

/** Polar point around (cx,cz). */
export function polar(cx: number, cz: number, r: number, a: number, y: number): Pt {
  return { x: cx + Math.cos(a) * r, y, z: cz + Math.sin(a) * r };
}

/** Flat ring sector between radii r0..r1 and angles a0..a0+sweep (world UVs). */
export function ringSector(b: MeshBuilder, cx: number, cz: number, r0: number, r1: number, a0: number, sweep: number, y: number, uvScale = 1 / 6, step = 0.04) {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / step));
  for (let i = 0; i < n; i++) {
    const t0 = a0 + (sweep * i) / n;
    const t1 = a0 + (sweep * (i + 1)) / n;
    quadUpUV(b, polar(cx, cz, r0, t0, y), polar(cx, cz, r1, t0, y), polar(cx, cz, r1, t1, y), polar(cx, cz, r0, t1, y), uvScale);
  }
}

/** Dashed (or solid if gap = 0) stripe along an arc of radius r, width w. */
export function arcStripe(b: MeshBuilder, cx: number, cz: number, r: number, w: number, a0: number, sweep: number, y: number, dash = 0, gap = 0) {
  const len = Math.abs(sweep) * r;
  if (gap <= 0) {
    ringSector(b, cx, cz, r - w / 2, r + w / 2, a0, sweep, y, 1, Math.max(0.01, 3 / r));
    return;
  }
  const sgn = Math.sign(sweep);
  for (let s = 0; s < len; s += dash + gap) {
    const t0 = a0 + (sgn * s) / r;
    const d = Math.min(dash, len - s);
    ringSector(b, cx, cz, r - w / 2, r + w / 2, t0, (sgn * d) / r, y, 1, Math.max(0.01, 2 / r));
  }
}

/** Flat disc (triangle fan) with world UVs. */
export function disc(b: MeshBuilder, cx: number, cz: number, r: number, y: number, seg = 48, uvScale = 1 / 6) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    triUpUV(b, { x: cx, y, z: cz }, polar(cx, cz, r, a0, y), polar(cx, cz, r, a1, y), uvScale);
  }
}
