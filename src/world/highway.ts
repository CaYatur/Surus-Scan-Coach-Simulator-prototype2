import { angleDiff, randRange, type Rng } from '../core/math';
import type { MeshBuilder } from './meshBuilder';
import type { ColliderWorld } from './colliders';
import type { BuildCtx, PropInst } from './buildings';
import { ARM_VEC, CURB_H, DIRS, type Dir4, type RoadEdge, type RoadNetwork, type RoadNode } from './roadNetwork';
import { arcStripe, disc, edgeStripe, ep, polar, quadUp, ringSector, triUpUV, dashed, type Pt } from './roadGeometry';

export type RoadBuild = {
  road: MeshBuilder;
  marks: MeshBuilder;
  walk: MeshBuilder;
  curb: MeshBuilder;
  ctx: BuildCtx;
  colliders: ColliderWorld;
  lamps: PropInst[];
  rng: Rng;
  net: RoadNetwork;
};

const Y_MARK = 0.012;
const YELLOW = '#f0c330';

/** Concrete New-Jersey barrier segment (two stacked boxes) centred at (x,z) along heading h. */
function barrierSeg(b: MeshBuilder, x: number, z: number, len: number, h: number) {
  b.orientedBox(x, 0.18, z, 0.62, 0.36, len, h);
  b.orientedBox(x, 0.6, z, 0.26, 0.5, len, h);
}

/** Steel guardrail segment + one post. */
function railSeg(b: MeshBuilder, x: number, z: number, len: number, h: number) {
  b.orientedBox(x, 0.64, z, 0.1, 0.3, len, h);
}

function railPost(b: MeshBuilder, x: number, z: number, h: number) {
  b.orientedBox(x, 0.38, z, 0.12, 0.76, 0.12, h);
}

/** Highway edge extras: centre barrier, outer guardrails, median lamp posts, lane markings. */
export function buildHighwayEdge(B: RoadBuild, e: RoadEdge) {
  const { ctx, colliders } = B;
  const concrete = ctx.b.concrete;
  const metal = ctx.b.metal;
  const L = e.length;
  const h = e.heading;
  // Centre barrier (axis-aligned edges → single long boxes)
  concrete.setColor('#d7d4cc');
  const a = ep(e, 0, 0, 0);
  const bpt = ep(e, L, 0, 0);
  const cx = (a.x + bpt.x) / 2;
  const cz = (a.z + bpt.z) / 2;
  barrierSeg(concrete, cx, cz, L, h);
  const r0 = ep(e, 0, -0.31, 0);
  const r1 = ep(e, L, 0.31, 0);
  colliders.add({ kind: 'box', minX: Math.min(r0.x, r1.x), maxX: Math.max(r0.x, r1.x), minZ: Math.min(r0.z, r1.z), maxZ: Math.max(r0.z, r1.z), tag: 'barrier' });
  // Guardrails
  metal.setColor('#b6bdc2');
  const off = e.halfWidth + 0.45;
  for (const side of [-1, 1]) {
    const m = ep(e, L / 2, side * off, 0);
    railSeg(metal, m.x, m.z, L, h);
    for (let s = 2; s < L; s += 6) {
      const p = ep(e, s, side * (off + 0.12), 0);
      railPost(metal, p.x, p.z, h);
    }
    const g0 = ep(e, 0, side * (off - 0.1), 0);
    const g1 = ep(e, L, side * (off + 0.25), 0);
    colliders.add({ kind: 'box', minX: Math.min(g0.x, g1.x), maxX: Math.max(g0.x, g1.x), minZ: Math.min(g0.z, g1.z), maxZ: Math.max(g0.z, g1.z), tag: 'barrier' });
  }
  // Double-arm median lamps
  for (let s = 30; s < L - 20; s += 70) {
    const p = ep(e, s, 0, 0);
    B.lamps.push({ x: p.x, z: p.z, rot: Math.atan2(e.rx, e.rz), y: 0.85 });
    B.lamps.push({ x: p.x, z: p.z, rot: Math.atan2(-e.rx, -e.rz), y: 0.85 });
  }
}

/** Lane lines for a divided highway edge (called from the edge marking pass). */
export function highwayMarkings(b: MeshBuilder, e: RoadEdge) {
  const s = e.spec;
  const L = e.length;
  const half = s.median / 2;
  const outer = half + s.lanes * s.laneWidth;
  const W = 0.15;
  for (const side of [-1, 1]) {
    const lanes = side === 1 ? e.lanesFwd : e.lanesBwd;
    const solidLen = lanes[0] && isFinite(lanes[0].solidFromS) ? lanes[0].path.length - lanes[0].solidFromS : 0;
    // travel end of this carriageway: +1 → s = L, −1 → s = 0
    const solid: [number, number] = side === 1 ? [L - solidLen, L - 0.5] : [0.5, solidLen];
    const dash: [number, number] = side === 1 ? [4, L - solidLen] : [solidLen, L - 4];
    for (let i = 1; i < s.lanes; i++) {
      const l = side * (half + i * s.laneWidth);
      dashed(b, e, dash[0], dash[1], l, W, 4, 8, Y_MARK);
      if (solidLen > 0) edgeStripe(b, e, solid[0], solid[1], l - W / 2, l + W / 2, Y_MARK);
    }
    b.setColor(YELLOW);
    edgeStripe(b, e, 0, L, side * half - 0.08, side * half + 0.08, Y_MARK);
    b.setColor('#ffffff');
    edgeStripe(b, e, 0, L, side * outer - 0.1, side * outer + 0.1, Y_MARK);
    // shoulder chevrons near junction exits (hatched gore)
    if (solidLen > 0) {
      for (let k = 0; k < 6; k++) {
        const s0 = side === 1 ? L - 6 - k * 6 : 6 + k * 6;
        const p0 = ep(e, s0, side * (outer + 0.3), Y_MARK);
        const p1 = ep(e, s0 + side * 2.4, side * (outer + s.shoulder - 0.3), Y_MARK);
        const n = { x: (p1.x - p0.x) / 20, z: (p1.z - p0.z) / 20 };
        const o = { x: -n.z * 3, z: n.x * 3 };
        quadUp(b, { x: p0.x - o.x, y: Y_MARK, z: p0.z - o.z }, { x: p1.x - o.x, y: Y_MARK, z: p1.z - o.z }, { x: p1.x + o.x, y: Y_MARK, z: p1.z + o.z }, { x: p0.x + o.x, y: Y_MARK, z: p0.z + o.z });
      }
    }
  }
}

function armPoint(n: RoadNode, d: Dir4, r: number): { x: number; z: number } {
  const v = ARM_VEC[d];
  return { x: n.x + v[0] * r, z: n.z + v[1] * r };
}

/** Large-radius highway corner: asphalt ring sector, markings, barrier, guardrails, lamps, trees. */
export function buildBend(B: RoadBuild, n: RoadNode) {
  const arms = DIRS.filter((d) => n.arms[d]);
  if (arms.length !== 2) return;
  const e = n.arms[arms[0]]!;
  const s = e.spec;
  const R = n.radius;
  const hw = e.halfWidth;
  const p0 = armPoint(n, arms[0], R);
  const p1 = armPoint(n, arms[1], R);
  const a0 = Math.atan2(p0.z - n.cz, p0.x - n.cx);
  const a1 = Math.atan2(p1.z - n.cz, p1.x - n.cx);
  const sweep = angleDiff(a1, a0);
  ringSector(B.road, n.cx, n.cz, R - hw, R + hw, a0, sweep, 0, 1 / 6, 0.02);
  // Markings
  const half = s.median / 2;
  const outer = half + s.lanes * s.laneWidth;
  const m = B.marks;
  for (const sg of [-1, 1]) {
    m.setColor(YELLOW);
    arcStripe(m, n.cx, n.cz, R + sg * half, 0.16, a0, sweep, Y_MARK);
    m.setColor('#ffffff');
    arcStripe(m, n.cx, n.cz, R + sg * outer, 0.2, a0, sweep, Y_MARK);
    for (let i = 1; i < s.lanes; i++) arcStripe(m, n.cx, n.cz, R + sg * (half + i * s.laneWidth), 0.15, a0, sweep, Y_MARK, 4, 8);
  }
  // Barrier + guardrails as short chords along the arc
  const concrete = B.ctx.b.concrete;
  const metal = B.ctx.b.metal;
  const sgn = Math.sign(sweep);
  const segLen = 4;
  const drawRing = (r: number, fn: (x: number, z: number, len: number, h: number, i: number) => void) => {
    const len = Math.abs(sweep) * r;
    const nSeg = Math.max(1, Math.ceil(len / segLen));
    for (let i = 0; i < nSeg; i++) {
      const t0 = a0 + (sweep * i) / nSeg;
      const t1 = a0 + (sweep * (i + 1)) / nSeg;
      const q0 = polar(n.cx, n.cz, r, t0, 0);
      const q1 = polar(n.cx, n.cz, r, t1, 0);
      const h = Math.atan2(q1.x - q0.x, q1.z - q0.z);
      fn((q0.x + q1.x) / 2, (q0.z + q1.z) / 2, Math.hypot(q1.x - q0.x, q1.z - q0.z) + 0.05, h, i);
    }
  };
  concrete.setColor('#d7d4cc');
  drawRing(R, (x, z, len, h) => {
    barrierSeg(concrete, x, z, len, h);
    B.colliders.add({ kind: 'obb', x, z, hw: 0.31, hl: len / 2, heading: h, tag: 'barrier' });
  });
  metal.setColor('#b6bdc2');
  for (const sg of [-1, 1]) {
    drawRing(R + sg * (hw + 0.45), (x, z, len, h, i) => {
      railSeg(metal, x, z, len, h);
      if (i % 2 === 0) railPost(metal, x, z, h);
      B.colliders.add({ kind: 'obb', x, z, hw: 0.18, hl: len / 2, heading: h, tag: 'barrier' });
    });
  }
  // Median lamps
  const arcLen = Math.abs(sweep) * R;
  for (let d = 30; d < arcLen - 20; d += 70) {
    const t = a0 + (sgn * d) / R;
    const p = polar(n.cx, n.cz, R, t, 0);
    const ox = Math.cos(t);
    const oz = Math.sin(t);
    B.lamps.push({ x: p.x, z: p.z, rot: Math.atan2(ox, oz), y: 0.85 });
    B.lamps.push({ x: p.x, z: p.z, rot: Math.atan2(-ox, -oz), y: 0.85 });
  }
  // Trees inside the curve and in the outer corner of the box
  const rng = B.rng;
  for (let i = 0; i < 70; i++) {
    const t = a0 + sweep * rng();
    const inner = rng() < 0.5;
    const r = inner ? randRange(rng, 12, R - hw - 10) : randRange(rng, R + hw + 12, R * 1.38);
    const p = polar(n.cx, n.cz, r, t, 0);
    if (Math.abs(p.x - n.x) > n.hx - 2 || Math.abs(p.z - n.z) > n.hz - 2) continue;
    B.ctx.trees.push({ x: p.x, z: p.z, s: randRange(rng, 0.9, 1.6), kind: rng() < 0.6 ? 'pine' : 'round', rot: rng() * 6.28, y: 0 });
    B.colliders.add({ kind: 'circle', x: p.x, z: p.z, r: 0.45, tag: 'tree' });
  }
}

/** Roundabout: circulating carriageway, arm throats, raised corner islands, central island with monument. */
export function buildRoundabout(B: RoadBuild, n: RoadNode) {
  const H = n.hx;
  const Ro = n.ringOuter;
  const road = B.road;
  // Paved area: disc + throats toward each arm
  disc(road, n.x, n.z, Ro, 0, 72);
  for (const d of DIRS) {
    const e = n.arms[d];
    if (!e) continue;
    const v = ARM_VEC[d];
    const w = e.halfWidth;
    const px = -v[1];
    const pz = v[0];
    const P = (along: number, lat: number): Pt => ({ x: n.x + v[0] * along + px * lat, y: 0, z: n.z + v[1] * along + pz * lat });
    const inner = Math.sqrt(Math.max(0, Ro * Ro - w * w)) - 0.5;
    const q = [P(inner, -w), P(H, -w), P(H, w), P(inner, w)];
    quadUp(road, q[0], q[1], q[2], q[3], [q[0].x / 6, -q[0].z / 6, q[1].x / 6, -q[1].z / 6, q[2].x / 6, -q[2].z / 6, q[3].x / 6, -q[3].z / 6]);
  }
  // Raised corner fills between adjacent arms (fan from the box corner)
  const walk = B.walk;
  const curb = B.curb;
  walk.setColor('#ffffff');
  curb.setColor('#c9c6be');
  const pairs: [Dir4, Dir4][] = [
    ['N', 'E'],
    ['E', 'S'],
    ['S', 'W'],
    ['W', 'N'],
  ];
  const Y = CURB_H;
  for (const [dA, dB] of pairs) {
    const vA = ARM_VEC[dA];
    const vB = ARM_VEC[dB];
    const wA = n.arms[dA]?.halfWidth ?? 0;
    const wB = n.arms[dB]?.halfWidth ?? 0;
    const K: Pt = { x: n.x + (vA[0] + vB[0]) * H, y: Y, z: n.z + (vA[1] + vB[1]) * H };
    const P1: Pt = { x: n.x + vA[0] * H + vB[0] * wA, y: Y, z: n.z + vA[1] * H + vB[1] * wA };
    const P2: Pt = { x: n.x + vB[0] * H + vA[0] * wB, y: Y, z: n.z + vB[1] * H + vA[1] * wB };
    const tA = Math.sqrt(Math.max(0, Ro * Ro - wA * wA));
    const tB = Math.sqrt(Math.max(0, Ro * Ro - wB * wB));
    const Q1 = { x: n.x + vA[0] * tA + vB[0] * wA, z: n.z + vA[1] * tA + vB[1] * wA };
    const Q2 = { x: n.x + vB[0] * tB + vA[0] * wB, z: n.z + vB[1] * tB + vA[1] * wB };
    const aQ1 = Math.atan2(Q1.z - n.z, Q1.x - n.x);
    const aQ2 = Math.atan2(Q2.z - n.z, Q2.x - n.x);
    const sw = angleDiff(aQ2, aQ1);
    const arc: Pt[] = [];
    const nSeg = Math.max(2, Math.ceil(Math.abs(sw) / 0.08));
    for (let i = 0; i <= nSeg; i++) arc.push(polar(n.x, n.z, Ro, aQ1 + (sw * i) / nSeg, Y));
    const poly: Pt[] = [P1, ...arc, P2];
    for (let i = 0; i < poly.length - 1; i++) triUpUV(walk, K, poly[i], poly[i + 1], 0.5);
    // Curb faces toward the carriageway
    const wall = (a: Pt, b: Pt) => {
      curb.quad({ x: a.x, y: 0, z: a.z }, { x: b.x, y: 0, z: b.z }, { x: b.x, y: Y, z: b.z }, { x: a.x, y: Y, z: a.z });
      curb.quad({ x: b.x, y: 0, z: b.z }, { x: a.x, y: 0, z: a.z }, { x: a.x, y: Y, z: a.z }, { x: b.x, y: Y, z: b.z });
    };
    for (let i = 0; i < poly.length - 1; i++) wall(poly[i], poly[i + 1]);
  }
  // Central island: curb ring, grass, flower ring, monument with flag
  const ri = n.radius;
  const concrete = B.ctx.b.concrete;
  concrete.setColor('#d2cfc6');
  concrete.cylinder(n.x, n.z, 0, 0.3, ri, ri, 48, false);
  B.ctx.b.grass.setColor('#ffffff');
  disc(B.ctx.b.grass, n.x, n.z, ri - 0.05, 0.3, 48, 1 / 8);
  B.ctx.b.hedge.setColor('#ffffff');
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const p = polar(n.x, n.z, ri - 1.2, a, 0);
    B.ctx.b.hedge.orientedBox(p.x, 0.55, p.z, 0.9, 0.5, 0.9, -a);
  }
  const stone = B.ctx.b.stone;
  stone.setColor('#e3ddcf');
  stone.box(n.x - 1.6, n.x + 1.6, 0.3, 1.2, n.z - 1.6, n.z + 1.6);
  stone.box(n.x - 1.1, n.x + 1.1, 1.2, 2.0, n.z - 1.1, n.z + 1.1);
  stone.cylinder(n.x, n.z, 2.0, 7.5, 0.55, 0.25, 4);
  const metal = B.ctx.b.metal;
  metal.setColor('#c9ced3');
  const fx = n.x + 3.2;
  const fz = n.z + 3.2;
  metal.cylinder(fx, fz, 0.3, 11, 0.09, 0.06, 8);
  B.ctx.flagSpots.push({ x: fx + 0.05, z: fz, h: 10.9 });
  B.colliders.add({ kind: 'circle', x: n.x, z: n.z, r: ri, tag: 'barrier' });
  // Markings: outer edge line and a dashed guide around the island
  B.marks.setColor('#ffffff');
  arcStripe(B.marks, n.x, n.z, ri + 0.35, 0.14, 0, Math.PI * 2, Y_MARK);
  arcStripe(B.marks, n.x, n.z, n.ringR + 1.6, 0.12, 0, Math.PI * 2, Y_MARK, 2, 3);
}

/** Overhead direction sign gantry over one carriageway. */
export function buildGantry(B: RoadBuild, e: RoadEdge, sEdge: number, side: 1 | -1, lines: string[]) {
  const s = e.spec;
  const half = s.median / 2;
  const outer = e.halfWidth + 0.8;
  const metal = B.ctx.b.metal;
  metal.setColor('#8b949b');
  const pIn = ep(e, sEdge, side * 0.9, 0);
  const pOut = ep(e, sEdge, side * outer, 0);
  for (const p of [pIn, pOut]) {
    metal.cylinder(p.x, p.z, 0, 7.4, 0.2, 0.18, 10);
    B.colliders.add({ kind: 'circle', x: p.x, z: p.z, r: 0.3, tag: 'pole' });
  }
  const mid = ep(e, sEdge, side * (0.9 + outer) / 2, 0);
  const beamLen = outer - 0.9;
  const rot = Math.atan2(e.rx, e.rz);
  metal.orientedBox(mid.x, 7.1, mid.z, 0.25, 0.25, beamLen, rot);
  metal.orientedBox(mid.x, 6.3, mid.z, 0.18, 0.18, beamLen, rot);
  // boards face traffic travelling on this side
  const travelH = side === 1 ? e.heading : e.heading + Math.PI;
  const faceH = travelH + Math.PI;
  const w = Math.min(7.5, (s.lanes * s.laneWidth) / Math.max(1, lines.length) - 0.4);
  lines.forEach((text, i) => {
    const lat = side * (half + (s.lanes * s.laneWidth * (i + 0.5)) / lines.length);
    const p = ep(e, sEdge + (side === 1 ? -0.2 : 0.2), lat, 0);
    B.ctx.signBoards.push({ x: p.x, y: 6.1, z: p.z, rot: faceH, text, w, h: 2.2, bg: '#1d4fa0', fg: '#ffffff' });
  });
}

/** Free-standing board on two posts (town entry/exit, info). */
export function buildPostBoard(B: RoadBuild, x: number, z: number, faceH: number, text: string, w: number, h: number, bg: string, fg: string, baseY = 0) {
  const metal = B.ctx.b.metal;
  metal.setColor('#8b949b');
  const px = Math.cos(faceH) * (w / 2 - 0.3);
  const pz = -Math.sin(faceH) * (w / 2 - 0.3);
  for (const s of [-1, 1]) {
    metal.cylinder(x + px * s, z + pz * s, baseY, baseY + 1.5 + h, 0.06, 0.06, 6);
  }
  B.colliders.add({ kind: 'circle', x, z, r: 0.25, tag: 'pole' });
  B.ctx.signBoards.push({ x: x + Math.sin(faceH) * 0.06, y: baseY + 1.5 + h / 2, z: z + Math.cos(faceH) * 0.06, rot: faceH, text, w, h, bg, fg });
}

/** Where an axis-aligned edge crosses a rectangle boundary (edge-local s values). */
export function edgeRectCrossings(e: RoadEdge, r: { minX: number; maxX: number; minZ: number; maxZ: number }): number[] {
  const out: number[] = [];
  if (e.axis === 'ns') {
    if (e.x0 < r.minX || e.x0 > r.maxX) return out;
    for (const zb of [r.minZ, r.maxZ]) {
      const s = (zb - e.z0) * e.dz;
      if (s > 2 && s < e.length - 2) out.push(s);
    }
  } else {
    if (e.z0 < r.minZ || e.z0 > r.maxZ) return out;
    for (const xb of [r.minX, r.maxX]) {
      const s = (xb - e.x0) * e.dx;
      if (s > 2 && s < e.length - 2) out.push(s);
    }
  }
  return out;
}
