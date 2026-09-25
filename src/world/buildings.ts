import * as THREE from 'three';
import { pick, randInt, randRange, type Rng } from '../core/math';
import type { Rect } from './mapDefs';
import type { Block, Dir4 } from './roadNetwork';
import { CURB_H } from './roadNetwork';
import { MeshBuilder } from './meshBuilder';
import type { ColliderWorld } from './colliders';

export type MatKey =
  | 'apartment'
  | 'office'
  | 'brick'
  | 'modern'
  | 'storefront'
  | 'house'
  | 'industrial'
  | 'school'
  | 'roof'
  | 'tileRoof'
  | 'concrete'
  | 'paver'
  | 'grass'
  | 'trim'
  | 'metal'
  | 'glass'
  | 'stone'
  | 'dome'
  | 'water'
  | 'hedge'
  | 'asphaltLot'
  | 'field';

export type TreeKind = 'round' | 'cypress' | 'pine';
export type TreeInst = { x: number; z: number; s: number; kind: TreeKind; rot: number; y?: number };
export type PropInst = { x: number; z: number; rot: number; y?: number };

export type BuildCtx = {
  rng: Rng;
  b: Record<MatKey, MeshBuilder>;
  colliders: ColliderWorld;
  trees: TreeInst[];
  benches: PropInst[];
  parkLamps: PropInst[];
  bins: PropInst[];
  cones: PropInst[];
  specials: THREE.Object3D[];
  flagSpots: { x: number; z: number; h: number }[];
  signBoards: { x: number; y: number; z: number; rot: number; text: string; w: number; h: number; bg: string; fg: string }[];
  parkingBays: { x: number; z: number; heading: number; w: number; l: number }[];
};

const Y0 = CURB_H; // block ground level

const PLASTER = ['#efe6d6', '#f3dcc0', '#e9d2b6', '#dfe5ea', '#f2efe8', '#e8d9c4', '#f1e3c8', '#d9e2d3', '#ecd6d0', '#e4e4e4', '#f5e9d0'];
const BRICK_TINT = ['#ffffff', '#f2e0d8', '#e8d0c8', '#ffe9dd'];
const OFFICE_TINT = ['#ffffff', '#dfefff', '#e8f4f0', '#f4efe6', '#e2e8f7'];
const HOUSE_TINT = ['#fffaf0', '#fbe7cf', '#f4efe0', '#e7efe4', '#fff1e6', '#f6e1d6'];

type FacadeKey = 'apartment' | 'office' | 'brick' | 'modern' | 'house' | 'industrial' | 'school';

const FACADE_TILE = 12.8;

function addSolid(ctx: BuildCtx, minX: number, maxX: number, minZ: number, maxZ: number) {
  ctx.colliders.add({ kind: 'box', minX, maxX, minZ, maxZ, tag: 'building' });
}

/** Rooftop clutter: water tanks, AC units, stair housing, antennas. */
function rooftop(ctx: BuildCtx, minX: number, maxX: number, minZ: number, maxZ: number, y: number, dense = 1) {
  const { rng, b } = ctx;
  const w = maxX - minX;
  const d = maxZ - minZ;
  // parapet
  b.trim.setColor('#b9b4aa');
  const p = 0.25;
  b.trim.box(minX, maxX, y, y + 0.9, minZ, minZ + p);
  b.trim.box(minX, maxX, y, y + 0.9, maxZ - p, maxZ);
  b.trim.box(minX, minX + p, y, y + 0.9, minZ + p, maxZ - p);
  b.trim.box(maxX - p, maxX, y, y + 0.9, minZ + p, maxZ - p);
  if (w < 6 || d < 6) return;
  // stair / lift housing
  const hx = minX + w * randRange(rng, 0.3, 0.6);
  const hz = minZ + d * randRange(rng, 0.3, 0.6);
  b.trim.setColor('#cfc9bf');
  b.trim.box(hx - 1.6, hx + 1.6, y, y + 2.8, hz - 1.4, hz + 1.4);
  const n = Math.floor(randRange(rng, 1, 4) * dense);
  for (let i = 0; i < n; i++) {
    const x = randRange(rng, minX + 1.5, maxX - 1.5);
    const z = randRange(rng, minZ + 1.5, maxZ - 1.5);
    if (rng() < 0.5) {
      // water tank (very common on Turkish rooftops)
      b.metal.setColor(rng() < 0.5 ? '#d8dde2' : '#9aa6b0');
      b.metal.cylinder(x, z, y, y + 1.3, 0.55, 0.55, 10);
      b.metal.setColor('#5a6068');
      b.metal.box(x - 0.6, x + 0.6, y, y + 0.35, z - 0.7, z + 0.7);
    } else {
      b.metal.setColor('#c4c8cc');
      b.metal.box(x - 0.7, x + 0.7, y, y + 0.9, z - 0.45, z + 0.45);
    }
  }
  if (rng() < 0.4) {
    const x = randRange(rng, minX + 1, maxX - 1);
    const z = randRange(rng, minZ + 1, maxZ - 1);
    b.metal.setColor('#6c737a');
    b.metal.cylinder(x, z, y, y + 4 + rng() * 3, 0.05, 0.04, 5, false);
  }
}

/** Hipped tile roof over a rectangle. */
function hipRoof(ctx: BuildCtx, minX: number, maxX: number, minZ: number, maxZ: number, y: number, pitch = 0.45) {
  const b = ctx.b.tileRoof;
  b.setColor('#ffffff');
  const o = 0.5; // eave overhang
  minX -= o;
  maxX += o;
  minZ -= o;
  maxZ += o;
  const w = maxX - minX;
  const d = maxZ - minZ;
  const h = Math.min(w, d) * pitch * 0.5;
  const top = y + h;
  const inset = Math.min(w, d) / 2;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const s = 0.25; // uv scale
  if (w >= d) {
    const r0 = { x: minX + inset, y: top, z: cz };
    const r1 = { x: maxX - inset, y: top, z: cz };
    b.quad({ x: minX, y, z: maxZ }, { x: maxX, y, z: maxZ }, r1, r0, [0, 0, w * s, 0, (w - inset) * s, d * s * 0.5, inset * s, d * s * 0.5]);
    b.quad({ x: maxX, y, z: minZ }, { x: minX, y, z: minZ }, r0, r1, [0, 0, w * s, 0, (w - inset) * s, d * s * 0.5, inset * s, d * s * 0.5]);
    b.tri({ x: maxX, y, z: maxZ }, { x: maxX, y, z: minZ }, r1, [0, 0, d * s, 0, d * s * 0.5, inset * s]);
    b.tri({ x: minX, y, z: minZ }, { x: minX, y, z: maxZ }, r0, [0, 0, d * s, 0, d * s * 0.5, inset * s]);
  } else {
    const r0 = { x: cx, y: top, z: minZ + inset };
    const r1 = { x: cx, y: top, z: maxZ - inset };
    b.quad({ x: maxX, y, z: maxZ }, { x: maxX, y, z: minZ }, r0, r1, [0, 0, d * s, 0, (d - inset) * s, w * s * 0.5, inset * s, w * s * 0.5]);
    b.quad({ x: minX, y, z: minZ }, { x: minX, y, z: maxZ }, r1, r0, [0, 0, d * s, 0, (d - inset) * s, w * s * 0.5, inset * s, w * s * 0.5]);
    b.tri({ x: minX, y, z: maxZ }, { x: maxX, y, z: maxZ }, r1, [0, 0, w * s, 0, w * s * 0.5, inset * s]);
    b.tri({ x: maxX, y, z: minZ }, { x: minX, y, z: minZ }, r0, [0, 0, w * s, 0, w * s * 0.5, inset * s]);
  }
  // eave underside strip
  ctx.b.trim.setColor('#8a8178');
  ctx.b.trim.box(minX + o, maxX - o, y - 0.25, y, minZ + o, maxZ - o, { top: false });
}

function facadeBox(
  ctx: BuildCtx,
  key: FacadeKey,
  tint: string,
  minX: number,
  maxX: number,
  y0: number,
  y1: number,
  minZ: number,
  maxZ: number
) {
  const b = ctx.b[key];
  b.setColor(tint);
  b.box(minX, maxX, y0, y1, minZ, maxZ, { tileU: FACADE_TILE, tileV: FACADE_TILE, top: false, vOffset: -y0 / FACADE_TILE });
}

function storefront(ctx: BuildCtx, minX: number, maxX: number, minZ: number, maxZ: number, h = 4.4) {
  const b = ctx.b.storefront;
  b.setColor('#ffffff');
  b.box(minX, maxX, Y0, Y0 + h, minZ, maxZ, { tileU: 12.8, tileV: h, top: false, vOffset: -Y0 / h });
  // awning band
  ctx.b.trim.setColor(pick(ctx.rng, ['#7b2d26', '#27496d', '#3d5a3a', '#6b4f2a', '#444444']));
  const o = 0.9;
  ctx.b.trim.box(minX - o, maxX + o, Y0 + h - 0.1, Y0 + h + 0.25, minZ - o, maxZ + o);
}

function balconies(ctx: BuildCtx, face: Dir4, minX: number, maxX: number, minZ: number, maxZ: number, floors: number, baseY: number, fh: number) {
  const { b, rng } = ctx;
  const along = face === 'N' || face === 'S' ? maxX - minX : maxZ - minZ;
  const nb = Math.floor(along / 6.4);
  if (nb < 1) return;
  const depth = 1.25;
  const rail = rng() < 0.5 ? '#f4f4f2' : '#6f7a82';
  for (let f = 1; f < floors; f++) {
    const y = baseY + f * fh;
    for (let i = 0; i < nb; i++) {
      if ((i + f) % 2 === 1 && rng() < 0.6) continue;
      const c = (i + 0.5) * (along / nb);
      const hw = 1.5;
      let x0: number, x1: number, z0: number, z1: number;
      if (face === 'N') [x0, x1, z0, z1] = [minX + c - hw, minX + c + hw, minZ - depth, minZ];
      else if (face === 'S') [x0, x1, z0, z1] = [minX + c - hw, minX + c + hw, maxZ, maxZ + depth];
      else if (face === 'W') [x0, x1, z0, z1] = [minX - depth, minX, minZ + c - hw, minZ + c + hw];
      else [x0, x1, z0, z1] = [maxX, maxX + depth, minZ + c - hw, minZ + c + hw];
      b.trim.setColor('#e7e3dc');
      b.trim.box(x0, x1, y - 0.18, y, z0, z1, { bottom: true });
      b.metal.setColor(rail);
      // front railing panel
      if (face === 'N') b.metal.box(x0, x1, y, y + 1.0, z0, z0 + 0.06);
      else if (face === 'S') b.metal.box(x0, x1, y, y + 1.0, z1 - 0.06, z1);
      else if (face === 'W') b.metal.box(x0, x0 + 0.06, y, y + 1.0, z0, z1);
      else b.metal.box(x1 - 0.06, x1, y, y + 1.0, z0, z1);
    }
  }
}

function apartment(ctx: BuildCtx, r: Rect, faces: Dir4[], floorsRange: [number, number], opts: { shop?: boolean; roof?: 'flat' | 'hip' | 'auto'; kind?: FacadeKey } = {}) {
  const { rng } = ctx;
  const floors = randInt(rng, floorsRange[0], floorsRange[1]);
  const fh = 3.2;
  const shopH = opts.shop ? 4.4 : 0;
  const top = Y0 + shopH + floors * fh;
  const kind: FacadeKey = opts.kind ?? (rng() < 0.72 ? 'apartment' : rng() < 0.5 ? 'brick' : 'modern');
  const tint = kind === 'brick' ? pick(rng, BRICK_TINT) : kind === 'modern' ? pick(rng, OFFICE_TINT) : pick(rng, PLASTER);
  if (opts.shop) storefront(ctx, r.minX, r.maxX, r.minZ, r.maxZ, shopH);
  facadeBox(ctx, kind, tint, r.minX, r.maxX, Y0 + shopH, top, r.minZ, r.maxZ);
  // cornice band
  ctx.b.trim.setColor('#d6d0c4');
  ctx.b.trim.box(r.minX - 0.15, r.maxX + 0.15, top - 0.35, top, r.minZ - 0.15, r.maxZ + 0.15, { top: false });
  if (kind === 'apartment') for (const f of faces) balconies(ctx, f, r.minX, r.maxX, r.minZ, r.maxZ, floors, Y0 + shopH, fh);
  const roof = opts.roof ?? 'auto';
  const hip = roof === 'hip' || (roof === 'auto' && kind === 'apartment' && rng() < 0.45 && floors <= 7);
  if (hip) hipRoof(ctx, r.minX, r.maxX, r.minZ, r.maxZ, top, 0.5);
  else {
    ctx.b.roof.setColor('#ffffff');
    ctx.b.roof.flatRect(r.minX, r.maxX, r.minZ, r.maxZ, top, 0.2);
    rooftop(ctx, r.minX, r.maxX, r.minZ, r.maxZ, top);
  }
  addSolid(ctx, r.minX, r.maxX, r.minZ, r.maxZ);
  return top;
}

function tower(ctx: BuildCtx, r: Rect) {
  const { rng, b } = ctx;
  const podium = 4.6;
  storefront(ctx, r.minX, r.maxX, r.minZ, r.maxZ, podium);
  const h = randRange(rng, 38, 118);
  const kind: FacadeKey = rng() < 0.6 ? 'office' : 'modern';
  const tint = pick(rng, OFFICE_TINT);
  const inset = rng() < 0.5 ? 1.2 : 0;
  const x0 = r.minX + inset;
  const x1 = r.maxX - inset;
  const z0 = r.minZ + inset;
  const z1 = r.maxZ - inset;
  const setback = rng() < 0.55 && h > 60;
  const midH = setback ? h * randRange(rng, 0.55, 0.75) : h;
  facadeBox(ctx, kind, tint, x0, x1, Y0 + podium, Y0 + podium + midH, z0, z1);
  let topY = Y0 + podium + midH;
  let rx0 = x0;
  let rx1 = x1;
  let rz0 = z0;
  let rz1 = z1;
  if (setback) {
    const s = Math.min(x1 - x0, z1 - z0) * 0.18;
    rx0 += s;
    rx1 -= s;
    rz0 += s;
    rz1 -= s;
    b.roof.setColor('#ffffff');
    b.roof.flatRect(x0, x1, z0, z1, topY, 0.2);
    facadeBox(ctx, kind, tint, rx0, rx1, topY, Y0 + podium + h, rz0, rz1);
    topY = Y0 + podium + h;
  }
  b.roof.setColor('#ffffff');
  b.roof.flatRect(rx0, rx1, rz0, rz1, topY, 0.2);
  rooftop(ctx, rx0, rx1, rz0, rz1, topY, 1.5);
  // crown / antenna
  if (rng() < 0.5) {
    b.metal.setColor('#8d99a4');
    b.metal.box(rx0 + 1, rx1 - 1, topY, topY + 3.5, rz0 + 1, rz1 - 1, { sides: true });
    b.metal.setColor('#cfd6dc');
    b.metal.cylinder((rx0 + rx1) / 2, (rz0 + rz1) / 2, topY + 3.5, topY + 16, 0.25, 0.06, 6);
  }
  addSolid(ctx, r.minX, r.maxX, r.minZ, r.maxZ);
}

function house(ctx: BuildCtx, cx: number, cz: number, w: number, d: number) {
  const { rng } = ctx;
  const floors = rng() < 0.55 ? 2 : 1;
  const top = Y0 + floors * 3.0;
  const r = { minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 };
  facadeBox(ctx, 'house', pick(rng, HOUSE_TINT), r.minX, r.maxX, Y0, top, r.minZ, r.maxZ);
  hipRoof(ctx, r.minX, r.maxX, r.minZ, r.maxZ, top, 0.62);
  // chimney
  if (rng() < 0.6) {
    ctx.b.trim.setColor('#8f5b45');
    const x = randRange(rng, r.minX + 1, r.maxX - 1);
    const z = randRange(rng, r.minZ + 1, r.maxZ - 1);
    ctx.b.trim.box(x - 0.35, x + 0.35, top, top + 2.8, z - 0.35, z + 0.35);
  }
  addSolid(ctx, r.minX, r.maxX, r.minZ, r.maxZ);
}

function groundRect(ctx: BuildCtx, key: 'concrete' | 'grass' | 'paver' | 'asphaltLot', r: Rect, y = Y0 + 0.001) {
  ctx.b[key].setColor('#ffffff');
  ctx.b[key].flatRect(r.minX, r.maxX, r.minZ, r.maxZ, y, key === 'grass' ? 1 / 8 : key === 'paver' ? 1 / 4 : 1 / 6);
}

/** Low garden wall / hedge along the block perimeter where there is no building. */
function perimeterWall(ctx: BuildCtx, r: Rect, style: 'hedge' | 'wall' | 'fence') {
  const t = 0.4;
  const h = style === 'hedge' ? 1.1 : style === 'wall' ? 1.2 : 1.6;
  const key = style === 'hedge' ? 'hedge' : style === 'wall' ? 'trim' : 'metal';
  const b = ctx.b[key];
  b.setColor(style === 'hedge' ? '#ffffff' : style === 'wall' ? '#d8d2c6' : '#4f5a60');
  b.box(r.minX, r.maxX, Y0, Y0 + h, r.minZ, r.minZ + t);
  b.box(r.minX, r.maxX, Y0, Y0 + h, r.maxZ - t, r.maxZ);
  b.box(r.minX, r.minX + t, Y0, Y0 + h, r.minZ + t, r.maxZ - t);
  b.box(r.maxX - t, r.maxX, Y0, Y0 + h, r.minZ + t, r.maxZ - t);
}

function scatterTrees(ctx: BuildCtx, r: Rect, n: number, kinds: TreeKind[] = ['round'], margin = 2) {
  const { rng } = ctx;
  for (let i = 0; i < n; i++) {
    const x = randRange(rng, r.minX + margin, r.maxX - margin);
    const z = randRange(rng, r.minZ + margin, r.maxZ - margin);
    const kind = pick(rng, kinds);
    ctx.trees.push({ x, z, s: randRange(rng, 0.8, 1.35), kind, rot: rng() * 6.28, y: Y0 });
    ctx.colliders.add({ kind: 'circle', x, z, r: 0.35, tag: 'tree' });
  }
}

/** Split a block into perimeter lots along its frontage sides. */
function perimeterLots(
  rng: Rng,
  r: Rect,
  front: Record<Dir4, boolean>,
  depthRange: [number, number],
  widthRange: [number, number],
  gapRange: [number, number]
): { rect: Rect; faces: Dir4[] }[] {
  const lots: { rect: Rect; faces: Dir4[] }[] = [];
  const W = r.maxX - r.minX;
  const D = r.maxZ - r.minZ;
  const depth = Math.min(randRange(rng, depthRange[0], depthRange[1]), Math.min(W, D) / 2 - 1);
  if (depth < 7) {
    lots.push({ rect: { ...r }, faces: (['N', 'S', 'E', 'W'] as Dir4[]).filter((d) => front[d]) });
    return lots;
  }
  const along = (a0: number, a1: number, mk: (s0: number, s1: number) => { rect: Rect; faces: Dir4[] }) => {
    let s = a0;
    while (a1 - s > widthRange[0] * 0.7) {
      let w = randRange(rng, widthRange[0], widthRange[1]);
      if (a1 - s - w < widthRange[0] * 0.8) w = a1 - s;
      lots.push(mk(s, s + w));
      s += w + randRange(rng, gapRange[0], gapRange[1]);
    }
  };
  const hasN = front.N;
  const hasS = front.S;
  if (hasN) along(r.minX, r.maxX, (s0, s1) => ({ rect: { minX: s0, maxX: s1, minZ: r.minZ, maxZ: r.minZ + depth }, faces: ['N'] }));
  if (hasS) along(r.minX, r.maxX, (s0, s1) => ({ rect: { minX: s0, maxX: s1, minZ: r.maxZ - depth, maxZ: r.maxZ }, faces: ['S'] }));
  const z0 = r.minZ + (hasN ? depth + 1 : 0);
  const z1 = r.maxZ - (hasS ? depth + 1 : 0);
  if (front.W) along(z0, z1, (s0, s1) => ({ rect: { minX: r.minX, maxX: r.minX + depth, minZ: s0, maxZ: s1 }, faces: ['W'] }));
  if (front.E) along(z0, z1, (s0, s1) => ({ rect: { minX: r.maxX - depth, maxX: r.maxX, minZ: s0, maxZ: s1 }, faces: ['E'] }));
  // Corner lots also face the perpendicular street
  for (const l of lots) {
    if (l.faces[0] === 'N' || l.faces[0] === 'S') {
      if (front.W && Math.abs(l.rect.minX - r.minX) < 0.01) l.faces.push('W');
      if (front.E && Math.abs(l.rect.maxX - r.maxX) < 0.01) l.faces.push('E');
    }
  }
  return lots;
}

// ———————————————————————————————— landmarks ————————————————————————————————

function mosque(ctx: BuildCtx, r: Rect) {
  const { b } = ctx;
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  groundRect(ctx, 'paver', r);
  perimeterWall(ctx, r, 'wall');
  const s = Math.min(r.maxX - r.minX, r.maxZ - r.minZ) * 0.42;
  const hs = Math.min(s, 22);
  // main prayer hall
  b.stone.setColor('#efe7d8');
  b.stone.box(cx - hs, cx + hs, Y0, Y0 + 11, cz - hs, cz + hs, { tileU: 4, tileV: 4 });
  // drum + main dome
  b.stone.cylinder(cx, cz, Y0 + 11, Y0 + 14.5, hs * 0.72, hs * 0.72, 16);
  b.dome.setColor('#8e9aa3');
  b.dome.dome(cx, Y0 + 14.5, cz, hs * 0.72, 20, 8, 0.9);
  // finial
  b.metal.setColor('#d4af37');
  b.metal.cylinder(cx, cz, Y0 + 14.5 + hs * 0.65, Y0 + 14.5 + hs * 0.65 + 3, 0.18, 0.05, 6);
  // semi domes
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    b.dome.dome(cx + dx * hs * 0.8, Y0 + 11, cz + dz * hs * 0.8, hs * 0.38, 12, 5, 0.85);
  }
  // corner small domes
  for (const [dx, dz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    b.dome.dome(cx + dx * hs * 0.72, Y0 + 11, cz + dz * hs * 0.72, hs * 0.18, 10, 4, 1);
  }
  // minarets
  for (const [dx, dz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const mx = cx + dx * (hs + 3.5);
    const mz = cz + dz * (hs + 3.5);
    b.stone.setColor('#f2ebdf');
    b.stone.cylinder(mx, mz, Y0, Y0 + 30, 1.35, 1.1, 12);
    b.stone.cylinder(mx, mz, Y0 + 30, Y0 + 31, 1.9, 1.9, 12); // şerefe balcony
    b.stone.cylinder(mx, mz, Y0 + 31, Y0 + 40, 1.0, 0.9, 12);
    b.stone.cylinder(mx, mz, Y0 + 40, Y0 + 40.8, 1.5, 1.5, 12);
    b.stone.cylinder(mx, mz, Y0 + 40.8, Y0 + 44, 0.85, 0.85, 12);
    b.dome.setColor('#7f8b94');
    b.dome.cylinder(mx, mz, Y0 + 44, Y0 + 50, 0.95, 0.02, 12);
    ctx.colliders.add({ kind: 'circle', x: mx, z: mz, r: 1.5, tag: 'building' });
  }
  addSolid(ctx, cx - hs, cx + hs, cz - hs, cz + hs);
  // courtyard trees
  for (const [dx, dz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const x = cx + dx * (hs + 9);
    const z = cz + dz * (hs + 9);
    if (x > r.minX + 2 && x < r.maxX - 2 && z > r.minZ + 2 && z < r.maxZ - 2) {
      ctx.trees.push({ x, z, s: 1.3, kind: 'cypress', rot: 0, y: Y0 });
      ctx.colliders.add({ kind: 'circle', x, z, r: 0.4, tag: 'tree' });
    }
  }
  addSolid(ctx, r.minX, r.maxX, r.minZ, r.minZ + 0.4);
  addSolid(ctx, r.minX, r.maxX, r.maxZ - 0.4, r.maxZ);
  addSolid(ctx, r.minX, r.minX + 0.4, r.minZ, r.maxZ);
  addSolid(ctx, r.maxX - 0.4, r.maxX, r.minZ, r.maxZ);
}

function clockTower(ctx: BuildCtx, x: number, z: number) {
  const { b } = ctx;
  b.stone.setColor('#e7dcc6');
  b.stone.box(x - 2.2, x + 2.2, Y0, Y0 + 1.2, z - 2.2, z + 2.2, { tileU: 4, tileV: 4 });
  b.stone.box(x - 1.6, x + 1.6, Y0 + 1.2, Y0 + 17, z - 1.6, z + 1.6, { tileU: 4, tileV: 4 });
  b.stone.box(x - 1.9, x + 1.9, Y0 + 17, Y0 + 21, z - 1.9, z + 1.9, { tileU: 4, tileV: 4 });
  b.dome.setColor('#6f7c86');
  b.dome.cylinder(x, z, Y0 + 21, Y0 + 26, 2.4, 0.05, 4);
  // clock faces (canvas texture, shared)
  const faceTex = clockFaceTexture();
  const mat = new THREE.MeshStandardMaterial({ map: faceTex, emissive: 0xfff1d0, emissiveMap: faceTex, emissiveIntensity: 0.15 });
  const geo = new THREE.CircleGeometry(1.45, 32);
  const faces: [number, number, number][] = [
    [0, 0, 1.91],
    [Math.PI, 0, -1.91],
    [Math.PI / 2, 1.91, 0],
    [-Math.PI / 2, -1.91, 0],
  ];
  for (const [rot, dx, dz] of faces) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x + dx, Y0 + 19, z + dz);
    m.rotation.y = rot;
    ctx.specials.push(m);
  }
  ctx.colliders.add({ kind: 'box', minX: x - 2.2, maxX: x + 2.2, minZ: z - 2.2, maxZ: z + 2.2, tag: 'building' });
}

let clockTex: THREE.CanvasTexture | null = null;
function clockFaceTexture(): THREE.CanvasTexture {
  if (clockTex) return clockTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fbf6ea';
  g.beginPath();
  g.arc(64, 64, 62, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#2a2a2a';
  g.lineWidth = 4;
  g.stroke();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.fillStyle = '#222';
    g.fillRect(64 + Math.sin(a) * 50 - 2, 64 - Math.cos(a) * 50 - 5, 4, 10);
  }
  g.strokeStyle = '#111';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(64, 64);
  g.lineTo(64 + 28, 64 - 16);
  g.moveTo(64, 64);
  g.lineTo(64 - 8, 64 - 44);
  g.stroke();
  clockTex = new THREE.CanvasTexture(c);
  clockTex.colorSpace = THREE.SRGBColorSpace;
  return clockTex;
}

function fountain(ctx: BuildCtx, x: number, z: number, r: number) {
  const { b } = ctx;
  b.stone.setColor('#d9d2c3');
  b.stone.cylinder(x, z, Y0, Y0 + 0.7, r, r, 24);
  b.water.setColor('#ffffff');
  b.water.cylinder(x, z, Y0 + 0.55, Y0 + 0.56, r - 0.35, r - 0.35, 24);
  b.stone.cylinder(x, z, Y0 + 0.5, Y0 + 2.2, 0.6, 0.45, 12);
  b.stone.cylinder(x, z, Y0 + 2.2, Y0 + 2.5, 1.6, 1.6, 16);
  ctx.colliders.add({ kind: 'circle', x, z, r, tag: 'building' });
}

function flagPole(ctx: BuildCtx, x: number, z: number, h: number) {
  ctx.b.metal.setColor('#d7dbe0');
  ctx.b.metal.cylinder(x, z, Y0, Y0 + h, 0.12, 0.07, 8);
  ctx.flagSpots.push({ x, z, h: Y0 + h });
  ctx.colliders.add({ kind: 'circle', x, z, r: 0.25, tag: 'pole' });
}

function statue(ctx: BuildCtx, x: number, z: number) {
  const { b } = ctx;
  b.stone.setColor('#c9c1b0');
  b.stone.box(x - 1.8, x + 1.8, Y0, Y0 + 3.2, z - 1.8, z + 1.8, { tileU: 4, tileV: 4 });
  b.metal.setColor('#4f5d4a');
  // stylised standing figure
  b.metal.box(x - 0.35, x + 0.35, Y0 + 3.2, Y0 + 4.4, z - 0.2, z + 0.2);
  b.metal.box(x - 0.5, x + 0.5, Y0 + 4.4, Y0 + 5.6, z - 0.3, z + 0.3);
  b.metal.cylinder(x, z, Y0 + 5.6, Y0 + 6.1, 0.22, 0.22, 8);
  ctx.colliders.add({ kind: 'box', minX: x - 1.8, maxX: x + 1.8, minZ: z - 1.8, maxZ: z + 1.8, tag: 'building' });
}

function benchRow(ctx: BuildCtx, x0: number, z0: number, x1: number, z1: number, n: number) {
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    ctx.benches.push({ x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, rot: Math.atan2(x1 - x0, z1 - z0) + Math.PI / 2, y: Y0 });
  }
}

// ———————————————————————————————— district fillers ————————————————————————————————

export function fillBlock(ctx: BuildCtx, blk: Block, isOuter: boolean) {
  const { rng } = ctx;
  const r = blk.rect;
  const W = r.maxX - r.minX;
  const D = r.maxZ - r.minZ;
  if (isOuter) return outskirts(ctx, blk);
  switch (blk.district) {
    case 'downtown': {
      groundRect(ctx, 'concrete', r);
      const nx = W > 70 ? 2 : 1;
      const nz = D > 70 ? 2 : 1;
      const gap = 6;
      const cw = (W - gap * (nx - 1)) / nx;
      const cd = (D - gap * (nz - 1)) / nz;
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          const lot = { minX: r.minX + i * (cw + gap), maxX: r.minX + i * (cw + gap) + cw, minZ: r.minZ + j * (cd + gap), maxZ: r.minZ + j * (cd + gap) + cd };
          const shrink = rng() < 0.3 ? 3 : 0.5;
          const lr = { minX: lot.minX + shrink, maxX: lot.maxX - shrink, minZ: lot.minZ + shrink, maxZ: lot.maxZ - shrink };
          if (rng() < 0.75) tower(ctx, lr);
          else apartment(ctx, lr, ['N', 'S', 'E', 'W'], [6, 10], { shop: true, kind: 'modern', roof: 'flat' });
        }
      }
      break;
    }
    case 'commercial': {
      groundRect(ctx, 'concrete', r);
      const lots = perimeterLots(rng, r, blk.frontage, [14, 19], [11, 22], [0, 0.4]);
      for (const l of lots) apartment(ctx, l.rect, l.faces, [4, 8], { shop: true });
      scatterTrees(ctx, { minX: r.minX + 20, maxX: r.maxX - 20, minZ: r.minZ + 20, maxZ: r.maxZ - 20 }, 3);
      addSolid(ctx, r.minX, r.maxX, r.minZ, r.maxZ);
      break;
    }
    case 'residential': {
      groundRect(ctx, 'grass', r);
      perimeterWall(ctx, r, rng() < 0.5 ? 'hedge' : 'wall');
      const lots = perimeterLots(rng, { minX: r.minX + 3, maxX: r.maxX - 3, minZ: r.minZ + 3, maxZ: r.maxZ - 3 }, blk.frontage, [12, 15], [12, 16], [3, 6]);
      for (const l of lots) apartment(ctx, l.rect, l.faces, [4, 7], { shop: rng() < 0.15 });
      scatterTrees(ctx, { minX: r.minX + 18, maxX: r.maxX - 18, minZ: r.minZ + 18, maxZ: r.maxZ - 18 }, Math.floor((W * D) / 500), ['round', 'round', 'cypress']);
      addSolid(ctx, r.minX, r.maxX, r.minZ, r.maxZ);
      break;
    }
    case 'suburb': {
      groundRect(ctx, 'grass', r);
      perimeterWall(ctx, r, 'hedge');
      const lots = perimeterLots(rng, { minX: r.minX + 5, maxX: r.maxX - 5, minZ: r.minZ + 5, maxZ: r.maxZ - 5 }, blk.frontage, [10, 11], [10, 14], [6, 10]);
      for (const l of lots) {
        const cx = (l.rect.minX + l.rect.maxX) / 2;
        const cz = (l.rect.minZ + l.rect.maxZ) / 2;
        house(ctx, cx, cz, Math.min(10, l.rect.maxX - l.rect.minX - 1), Math.min(9, l.rect.maxZ - l.rect.minZ - 1));
      }
      scatterTrees(ctx, r, Math.floor((W * D) / 350), ['round', 'round', 'pine'], 4);
      addSolid(ctx, r.minX, r.maxX, r.minZ, r.maxZ);
      break;
    }
    case 'park':
      park(ctx, r);
      break;
    case 'plaza':
      plaza(ctx, r);
      break;
    case 'school': {
      groundRect(ctx, 'concrete', r);
      perimeterWall(ctx, r, 'fence');
      const bw = Math.min(W * 0.7, 70);
      const bd = Math.min(D * 0.28, 16);
      const bx = (r.minX + r.maxX) / 2;
      const top = { minX: bx - bw / 2, maxX: bx + bw / 2, minZ: r.minZ + 6, maxZ: r.minZ + 6 + bd };
      facadeBox(ctx, 'school', '#ffffff', top.minX, top.maxX, Y0, Y0 + 3 * 3.2, top.minZ, top.maxZ);
      hipRoof(ctx, top.minX, top.maxX, top.minZ, top.maxZ, Y0 + 9.6, 0.35);
      addSolid(ctx, top.minX, top.maxX, top.minZ, top.maxZ);
      const wing = { minX: top.minX, maxX: top.minX + bd, minZ: top.maxZ, maxZ: top.maxZ + D * 0.35 };
      facadeBox(ctx, 'school', '#ffffff', wing.minX, wing.maxX, Y0, Y0 + 2 * 3.2, wing.minZ, wing.maxZ);
      hipRoof(ctx, wing.minX, wing.maxX, wing.minZ, wing.maxZ, Y0 + 6.4, 0.35);
      addSolid(ctx, wing.minX, wing.maxX, wing.minZ, wing.maxZ);
      // yard: basketball court lines
      ctx.b.trim.setColor('#b24a3a');
      const court = { minX: bx - 6, maxX: bx + 14, minZ: r.maxZ - 28, maxZ: r.maxZ - 8 };
      ctx.b.trim.flatRect(court.minX, court.maxX, court.minZ, court.maxZ, Y0 + 0.01, 0.1);
      flagPole(ctx, bx - bw / 2 - 4, r.minZ + 4, 10);
      ctx.signBoards.push({ x: bx, y: Y0 + 8.1, z: top.minZ - 0.08, rot: Math.PI, text: 'ATATÜRK İLKOKULU', w: 16, h: 1.6, bg: '#1d3f78', fg: '#ffffff' });
      scatterTrees(ctx, { minX: r.maxX - 22, maxX: r.maxX - 3, minZ: r.minZ + 26, maxZ: r.maxZ - 3 }, 6);
      addSolid(ctx, r.minX, r.maxX, r.minZ, r.maxZ);
      break;
    }
    case 'hospital': {
      groundRect(ctx, 'concrete', r);
      perimeterWall(ctx, r, 'hedge');
      const m = 6;
      const hr = { minX: r.minX + m, maxX: r.maxX - m, minZ: r.minZ + m, maxZ: r.minZ + m + Math.min(26, D * 0.45) };
      facadeBox(ctx, 'modern', '#ffffff', hr.minX, hr.maxX, Y0, Y0 + 7 * 3.2, hr.minZ, hr.maxZ);
      ctx.b.roof.flatRect(hr.minX, hr.maxX, hr.minZ, hr.maxZ, Y0 + 22.4, 0.2);
      rooftop(ctx, hr.minX, hr.maxX, hr.minZ, hr.maxZ, Y0 + 22.4, 0.5);
      // helipad
      ctx.b.trim.setColor('#39434b');
      ctx.b.trim.cylinder((hr.minX + hr.maxX) / 2, (hr.minZ + hr.maxZ) / 2, Y0 + 22.4, Y0 + 22.6, 6, 6, 24);
      addSolid(ctx, hr.minX, hr.maxX, hr.minZ, hr.maxZ);
      ctx.signBoards.push({ x: (hr.minX + hr.maxX) / 2, y: Y0 + 18, z: hr.maxZ + 0.08, rot: 0, text: 'DEVLET HASTANESİ', w: 18, h: 2, bg: '#ffffff', fg: '#c62828' });
      ctx.signBoards.push({ x: hr.maxX - 4, y: Y0 + 23.6, z: (hr.minZ + hr.maxZ) / 2, rot: Math.PI / 2, text: 'H', w: 3, h: 3, bg: '#c62828', fg: '#ffffff' });
      const lotR = { minX: r.minX + m, maxX: r.maxX - m, minZ: hr.maxZ + 6, maxZ: r.maxZ - m };
      groundRect(ctx, 'asphaltLot', lotR, Y0 + 0.004);
      addSolid(ctx, r.minX, r.maxX, r.minZ, r.maxZ);
      break;
    }
    case 'mosque':
      mosque(ctx, r);
      break;
    case 'campus': {
      groundRect(ctx, 'grass', r);
      perimeterWall(ctx, r, 'fence');
      const cx = (r.minX + r.maxX) / 2;
      const cz = (r.minZ + r.maxZ) / 2;
      const main = { minX: cx - 26, maxX: cx + 26, minZ: r.minZ + 6, maxZ: r.minZ + 22 };
      facadeBox(ctx, 'brick', '#ffffff', main.minX, main.maxX, Y0, Y0 + 16, main.minZ, main.maxZ);
      ctx.b.roof.flatRect(main.minX, main.maxX, main.minZ, main.maxZ, Y0 + 16, 0.2);
      rooftop(ctx, main.minX, main.maxX, main.minZ, main.maxZ, Y0 + 16, 0.4);
      addSolid(ctx, main.minX, main.maxX, main.minZ, main.maxZ);
      for (const sx of [-1, 1]) {
        const w = { minX: cx + sx * 34 - 9, maxX: cx + sx * 34 + 9, minZ: cz - 10, maxZ: cz + 30 };
        facadeBox(ctx, 'modern', '#ffffff', w.minX, w.maxX, Y0, Y0 + 12.8, w.minZ, w.maxZ);
        ctx.b.roof.flatRect(w.minX, w.maxX, w.minZ, w.maxZ, Y0 + 12.8, 0.2);
        addSolid(ctx, w.minX, w.maxX, w.minZ, w.maxZ);
      }
      ctx.signBoards.push({ x: cx, y: Y0 + 13, z: main.maxZ + 0.08, rot: 0, text: 'ÜNİVERSİTE', w: 14, h: 1.8, bg: '#5a1f1f', fg: '#f3e2b8' });
      scatterTrees(ctx, { minX: cx - 20, maxX: cx + 20, minZ: cz, maxZ: r.maxZ - 4 }, 12);
      flagPole(ctx, cx, main.maxZ + 8, 14);
      addSolid(ctx, r.minX, r.maxX, r.minZ, r.maxZ);
      break;
    }
    case 'farm':
      farm(ctx, r, blk);
      break;
    case 'forest':
      forest(ctx, r);
      break;
    case 'fuel':
      fuelStation(ctx, r, blk);
      break;
    case 'industrial': {
      if (W > 200 || D > 200) {
        logistics(ctx, r);
        break;
      }
      groundRect(ctx, 'concrete', r);
      perimeterWall(ctx, r, 'fence');
      const n = W > 90 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const w = (W - 12) / n - 6;
        const x0 = r.minX + 6 + i * (w + 6);
        const d = Math.min(D - 20, 45);
        const wr = { minX: x0, maxX: x0 + w, minZ: r.minZ + 8, maxZ: r.minZ + 8 + d };
        const h = randRange(rng, 8, 13);
        facadeBox(ctx, 'industrial', pick(rng, ['#ffffff', '#e6eef2', '#f2ebe0', '#e3e9e1']), wr.minX, wr.maxX, Y0, Y0 + h, wr.minZ, wr.maxZ);
        // sawtooth roof
        const teeth = Math.max(2, Math.floor(w / 9));
        const tw = w / teeth;
        const b = ctx.b.metal;
        b.setColor('#9aa3aa');
        for (let t = 0; t < teeth; t++) {
          const a = wr.minX + t * tw;
          const p0 = { x: a, y: Y0 + h, z: wr.maxZ };
          const p1 = { x: a + tw, y: Y0 + h, z: wr.maxZ };
          const p2 = { x: a + tw, y: Y0 + h + 3, z: wr.maxZ };
          b.quad({ x: a, y: Y0 + h, z: wr.minZ }, { x: a, y: Y0 + h, z: wr.maxZ }, { x: a + tw, y: Y0 + h + 3, z: wr.maxZ }, { x: a + tw, y: Y0 + h + 3, z: wr.minZ });
          b.tri(p0, p1, p2);
          b.tri({ x: a, y: Y0 + h, z: wr.minZ }, { x: a + tw, y: Y0 + h + 3, z: wr.minZ }, { x: a + tw, y: Y0 + h, z: wr.minZ });
          ctx.b.glass.setColor('#ffffff');
          ctx.b.glass.quad({ x: a + tw, y: Y0 + h, z: wr.maxZ }, { x: a + tw, y: Y0 + h, z: wr.minZ }, { x: a + tw, y: Y0 + h + 3, z: wr.minZ }, { x: a + tw, y: Y0 + h + 3, z: wr.maxZ });
        }
        addSolid(ctx, wr.minX, wr.maxX, wr.minZ, wr.maxZ);
        if (rng() < 0.6) {
          ctx.b.trim.setColor('#8c7b6c');
          const cx = wr.maxX - 4;
          const cz = wr.maxZ + 5;
          ctx.b.trim.cylinder(cx, cz, Y0, Y0 + 26, 1.4, 0.9, 12);
        }
      }
      addSolid(ctx, r.minX, r.maxX, r.minZ, r.maxZ);
      break;
    }
    case 'lot':
      parkingLot(ctx, r);
      break;
  }
}

function park(ctx: BuildCtx, r: Rect) {
  const { rng, b } = ctx;
  groundRect(ctx, 'grass', r);
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  // cross paths
  b.paver.setColor('#e8e2d6');
  b.paver.flatRect(cx - 2, cx + 2, r.minZ, r.maxZ, Y0 + 0.01, 0.25);
  b.paver.flatRect(r.minX, r.maxX, cz - 2, cz + 2, Y0 + 0.012, 0.25);
  // pond
  const pr = Math.min(r.maxX - r.minX, r.maxZ - r.minZ) * 0.14;
  const px = cx + (r.maxX - cx) * 0.5;
  const pz = cz + (r.maxZ - cz) * 0.5;
  b.stone.setColor('#b9b1a2');
  b.stone.cylinder(px, pz, Y0 - 0.2, Y0 + 0.35, pr + 0.6, pr + 0.6, 28);
  b.water.setColor('#ffffff');
  b.water.cylinder(px, pz, Y0 + 0.2, Y0 + 0.22, pr, pr, 28);
  ctx.colliders.add({ kind: 'circle', x: px, z: pz, r: pr + 0.6, tag: 'barrier' });
  // trees avoiding the paths
  const n = Math.floor(((r.maxX - r.minX) * (r.maxZ - r.minZ)) / 170);
  for (let i = 0; i < n; i++) {
    const x = randRange(rng, r.minX + 3, r.maxX - 3);
    const z = randRange(rng, r.minZ + 3, r.maxZ - 3);
    if (Math.abs(x - cx) < 4.5 || Math.abs(z - cz) < 4.5) continue;
    if (Math.hypot(x - px, z - pz) < pr + 4) continue;
    ctx.trees.push({ x, z, s: randRange(rng, 0.9, 1.6), kind: pick(rng, ['round', 'round', 'pine', 'cypress'] as TreeKind[]), rot: rng() * 6.28, y: Y0 });
    ctx.colliders.add({ kind: 'circle', x, z, r: 0.4, tag: 'tree' });
  }
  benchRow(ctx, cx - 3.5, r.minZ + 10, cx - 3.5, cz - 8, 4);
  benchRow(ctx, cx + 3.5, cz + 8, cx + 3.5, r.maxZ - 10, 4);
  for (let t = 0.15; t < 1; t += 0.23) {
    ctx.parkLamps.push({ x: cx + 2.8, z: r.minZ + (r.maxZ - r.minZ) * t, rot: 0, y: Y0 });
    ctx.parkLamps.push({ x: r.minX + (r.maxX - r.minX) * t, z: cz - 2.8, rot: 0, y: Y0 });
  }
  // playground
  b.trim.setColor('#d8743c');
  const gx = cx - (cx - r.minX) * 0.5;
  const gz = cz + (r.maxZ - cz) * 0.5;
  b.trim.flatRect(gx - 7, gx + 7, gz - 6, gz + 6, Y0 + 0.012, 0.2);
  b.metal.setColor('#2f7fc1');
  b.metal.box(gx - 3, gx - 2.8, Y0, Y0 + 2.6, gz - 2, gz - 1.8);
  b.metal.box(gx + 2.8, gx + 3, Y0, Y0 + 2.6, gz - 2, gz - 1.8);
  b.metal.box(gx - 3, gx + 3, Y0 + 2.5, Y0 + 2.7, gz - 2, gz - 1.8);
  b.metal.setColor('#e5b62c');
  b.metal.quad({ x: gx - 1, y: Y0 + 2.2, z: gz + 1 }, { x: gx + 1, y: Y0 + 2.2, z: gz + 1 }, { x: gx + 1, y: Y0 + 0.2, z: gz + 4.5 }, { x: gx - 1, y: Y0 + 0.2, z: gz + 4.5 });
}

function plaza(ctx: BuildCtx, r: Rect) {
  const { b } = ctx;
  groundRect(ctx, 'paver', r);
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  fountain(ctx, cx, cz, 6);
  clockTower(ctx, cx - (r.maxX - r.minX) * 0.3, cz - (r.maxZ - r.minZ) * 0.3);
  statue(ctx, cx + (r.maxX - r.minX) * 0.3, cz - (r.maxZ - r.minZ) * 0.3);
  flagPole(ctx, cx + (r.maxX - r.minX) * 0.32, cz + (r.maxZ - r.minZ) * 0.3, 16);
  // tree grid with planters
  for (let i = 0; i < 4; i++) {
    for (const side of [-1, 1]) {
      const x = cx + side * (r.maxX - r.minX) * 0.42;
      const z = r.minZ + 8 + i * ((r.maxZ - r.minZ - 16) / 3);
      b.stone.setColor('#cfc7b8');
      b.stone.box(x - 1.3, x + 1.3, Y0, Y0 + 0.5, z - 1.3, z + 1.3, { tileU: 2, tileV: 2 });
      ctx.trees.push({ x, z, s: 1.1, kind: 'round', rot: i, y: Y0 + 0.5 });
      ctx.colliders.add({ kind: 'box', minX: x - 1.3, maxX: x + 1.3, minZ: z - 1.3, maxZ: z + 1.3, tag: 'barrier' });
    }
  }
  benchRow(ctx, cx - 10, cz + 12, cx + 10, cz + 12, 4);
  benchRow(ctx, cx - 10, cz - 12, cx + 10, cz - 12, 4);
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) ctx.parkLamps.push({ x: cx + dx * 12, z: cz + dz * 9, rot: 0, y: Y0 });
  // municipality building on the south side
  const hall = { minX: cx - 22, maxX: cx + 22, minZ: r.maxZ - 18, maxZ: r.maxZ - 3 };
  facadeBox(ctx, 'brick', '#fff3e8', hall.minX, hall.maxX, Y0, Y0 + 13, hall.minZ, hall.maxZ);
  ctx.b.roof.flatRect(hall.minX, hall.maxX, hall.minZ, hall.maxZ, Y0 + 13, 0.2);
  b.stone.setColor('#efe6d6');
  for (let i = 0; i < 6; i++) {
    const x = hall.minX + 8 + i * ((hall.maxX - hall.minX - 16) / 5);
    b.stone.cylinder(x, hall.minZ - 2, Y0, Y0 + 9, 0.55, 0.5, 10);
  }
  b.stone.box(hall.minX + 6, hall.maxX - 6, Y0 + 9, Y0 + 10.2, hall.minZ - 3, hall.minZ, { tileU: 4, tileV: 4 });
  addSolid(ctx, hall.minX, hall.maxX, hall.minZ - 3, hall.maxZ);
  ctx.signBoards.push({ x: cx, y: Y0 + 11.3, z: hall.minZ - 3.05, rot: Math.PI, text: 'BELEDİYE BAŞKANLIĞI', w: 20, h: 1.5, bg: '#8b1d1d', fg: '#f7e8c8' });
}

function parkingLot(ctx: BuildCtx, r: Rect) {
  const { b } = ctx;
  groundRect(ctx, 'asphaltLot', r, Y0 - CURB_H + 0.012);
  // Entry aisle along the north edge, two bay rows, slalom course in between.
  const bayW = 2.8;
  const bayL = 5.2;
  const rows = [r.minZ + 15 + bayL / 2, r.maxZ - bayL / 2 - 1.5];
  b.trim.setColor('#f2f2f2');
  const x0 = r.minX + 18;
  const n = Math.floor((r.maxX - r.minX - 30) / bayW);
  for (const z of rows) {
    for (let i = 0; i <= n; i++) {
      const x = x0 + i * bayW;
      b.trim.flatRect(x - 0.06, x + 0.06, z - bayL / 2, z + bayL / 2, 0.03, 0.2);
      if (i < n) ctx.parkingBays.push({ x: x + bayW / 2, z, heading: 0, w: bayW, l: bayL });
    }
    // back line
    b.trim.flatRect(x0, x0 + n * bayW, z + bayL / 2 - 0.06, z + bayL / 2 + 0.06, 0.03, 0.2);
  }
  // wheel stops at the back of each bay
  b.trim.setColor('#c9c3b5');
  for (const z of rows) for (let i = 0; i < n; i++) b.trim.box(x0 + i * bayW + 0.6, x0 + (i + 1) * bayW - 0.6, 0, 0.12, z + bayL / 2 - 0.55, z + bayL / 2 - 0.35);
  // slalom cones across the middle
  const midZ = (rows[0] + rows[1]) / 2;
  for (let i = 0; i < 8; i++) ctx.cones.push({ x: r.minX + 26 + i * 13, z: midZ + (i % 2 ? 1.5 : -1.5), rot: 0, y: 0 });
  // lot lamps
  for (let i = 0; i < 4; i++) ctx.parkLamps.push({ x: r.minX + 15 + i * ((r.maxX - r.minX - 30) / 3), z: midZ + 12, rot: 0, y: 0 });
  ctx.signBoards.push({ x: r.minX + 8, y: 3.2, z: r.minZ + 3, rot: 0, text: 'PARK ALANI', w: 6, h: 1.2, bg: '#1d5fbf', fg: '#ffffff' });
}

function outskirts(ctx: BuildCtx, blk: Block) {
  const { rng } = ctx;
  const r = blk.rect;
  // Sparse trees + occasional low buildings, mostly open fields
  const area = (r.maxX - r.minX) * (r.maxZ - r.minZ);
  const n = Math.min(90, Math.floor(area / 900));
  for (let i = 0; i < n; i++) {
    const x = randRange(rng, r.minX + 6, r.maxX - 6);
    const z = randRange(rng, r.minZ + 6, r.maxZ - 6);
    ctx.trees.push({ x, z, s: randRange(rng, 0.9, 1.8), kind: pick(rng, ['round', 'pine', 'pine', 'cypress'] as TreeKind[]), rot: rng() * 6.28, y: 0 });
    ctx.colliders.add({ kind: 'circle', x, z, r: 0.45, tag: 'tree' });
  }
  if (rng() < 0.55) {
    const x = randRange(rng, r.minX + 25, r.maxX - 25);
    const z = randRange(rng, r.minZ + 25, r.maxZ - 25);
    if (x > r.minX + 20 && x < r.maxX - 20 && z > r.minZ + 20 && z < r.maxZ - 20) {
      house(ctx, x, z, 11, 9);
    }
  }
}


// ——————————————————————————— countryside ———————————————————————————

const CROPS = [
  { base: '#c9b25a', row: '#b39a45' }, // wheat
  { base: '#6f9440', row: '#5b7c33' }, // young crop
  { base: '#7b5b3e', row: '#684a31' }, // ploughed
  { base: '#9bb466', row: '#88a257' }, // fallow
  { base: '#b7a13a', row: '#a18c2d' }, // sunflower
  { base: '#577d35', row: '#4a6b2c' }, // orchard green
];

/** Agricultural parcels with crop rows, wind-break trees and the odd farmstead. */
function farm(ctx: BuildCtx, r: Rect, blk: Block) {
  const { rng } = ctx;
  const W = r.maxX - r.minX;
  const D = r.maxZ - r.minZ;
  const alongX = W >= D;
  const len = alongX ? W : D;
  const b = ctx.b.field;
  const y = 0.03;
  let t = 0;
  while (t < len - 8) {
    const pw = Math.min(len - t, randRange(rng, 28, 70));
    const crop = pick(rng, CROPS);
    const p: Rect = alongX
      ? { minX: r.minX + t + 1, maxX: r.minX + t + pw - 1, minZ: r.minZ + 1, maxZ: r.maxZ - 1 }
      : { minX: r.minX + 1, maxX: r.maxX - 1, minZ: r.minZ + t + 1, maxZ: r.minZ + t + pw - 1 };
    b.setColor(crop.base);
    b.flatRect(p.minX, p.maxX, p.minZ, p.maxZ, y);
    // crop rows run across the parcel
    b.setColor(crop.row);
    const rowsAlongZ = rng() < 0.5;
    if (rowsAlongZ) for (let x = p.minX + 1.5; x < p.maxX - 1; x += 3) b.flatRect(x, x + 1.1, p.minZ + 1, p.maxZ - 1, y + 0.01);
    else for (let z = p.minZ + 1.5; z < p.maxZ - 1; z += 3) b.flatRect(p.minX + 1, p.maxX - 1, z, z + 1.1, y + 0.01);
    // hay bales on harvested wheat
    if (crop === CROPS[0] && rng() < 0.6) {
      ctx.b.trim.setColor('#d9c07a');
      for (let i = 0; i < 6; i++) {
        const hx = randRange(rng, p.minX + 4, p.maxX - 4);
        const hz = randRange(rng, p.minZ + 4, p.maxZ - 4);
        ctx.b.trim.cylinder(hx, hz, 0, 1.3, 0.75, 0.75, 10);
        ctx.colliders.add({ kind: 'circle', x: hx, z: hz, r: 0.8, tag: 'barrier' });
      }
      b.setColor(crop.row);
    }
    // wind-break row on the parcel edge
    if (rng() < 0.35) {
      const kind: TreeKind = rng() < 0.5 ? 'cypress' : 'round';
      for (let u = 4; u < (alongX ? D : W) - 4; u += kind === 'cypress' ? 5 : 8) {
        const x = alongX ? p.maxX + 1 : p.minX + u;
        const z = alongX ? p.minZ + u : p.maxZ + 1;
        ctx.trees.push({ x, z, s: randRange(rng, 0.9, 1.3), kind, rot: rng() * 6.28, y: 0 });
        ctx.colliders.add({ kind: 'circle', x, z, r: 0.35, tag: 'tree' });
      }
    }
    t += pw;
  }
  // Farmstead near a frontage road
  if (rng() < 0.45 && W > 60 && D > 60) {
    const fronts = (['N', 'S', 'E', 'W'] as Dir4[]).filter((d) => blk.frontage[d]);
    const f = fronts.length ? pick(rng, fronts) : 'N';
    const u = randRange(rng, 0.25, 0.75);
    const cx = f === 'E' ? r.maxX - 22 : f === 'W' ? r.minX + 22 : r.minX + W * u;
    const cz = f === 'S' ? r.maxZ - 22 : f === 'N' ? r.minZ + 22 : r.minZ + D * u;
    ctx.b.concrete.setColor('#a58f72');
    ctx.b.concrete.flatRect(cx - 18, cx + 18, cz - 16, cz + 16, 0.05, 1 / 6);
    house(ctx, cx - 7, cz, 10, 9);
    // barn: red walls + gable roof
    const bx0 = cx + 3;
    const bx1 = cx + 15;
    const bz0 = cz - 7;
    const bz1 = cz + 7;
    ctx.b.trim.setColor('#8e2f26');
    ctx.b.trim.box(bx0, bx1, Y0, Y0 + 5, bz0, bz1);
    ctx.b.metal.setColor('#5d6368');
    const ridge = Y0 + 8;
    ctx.b.metal.quad({ x: bx0 - 0.4, y: Y0 + 5, z: bz0 - 0.4 }, { x: bx0 - 0.4, y: Y0 + 5, z: bz1 + 0.4 }, { x: (bx0 + bx1) / 2, y: ridge, z: bz1 + 0.4 }, { x: (bx0 + bx1) / 2, y: ridge, z: bz0 - 0.4 });
    ctx.b.metal.quad({ x: bx1 + 0.4, y: Y0 + 5, z: bz1 + 0.4 }, { x: bx1 + 0.4, y: Y0 + 5, z: bz0 - 0.4 }, { x: (bx0 + bx1) / 2, y: ridge, z: bz0 - 0.4 }, { x: (bx0 + bx1) / 2, y: ridge, z: bz1 + 0.4 });
    ctx.b.trim.setColor('#8e2f26');
    ctx.b.trim.tri({ x: bx0, y: Y0 + 5, z: bz1 }, { x: bx1, y: Y0 + 5, z: bz1 }, { x: (bx0 + bx1) / 2, y: ridge, z: bz1 });
    ctx.b.trim.tri({ x: bx1, y: Y0 + 5, z: bz0 }, { x: bx0, y: Y0 + 5, z: bz0 }, { x: (bx0 + bx1) / 2, y: ridge, z: bz0 });
    addSolid(ctx, bx0, bx1, bz0, bz1);
    // silo
    ctx.b.metal.setColor('#c4c9cc');
    ctx.b.metal.cylinder(cx + 9, cz + 11, 0, 12, 2.2, 2.2, 14);
    ctx.b.metal.dome(cx + 9, 12, cz + 11, 2.2, 12, 4, 0.6);
    ctx.colliders.add({ kind: 'circle', x: cx + 9, z: cz + 11, r: 2.3, tag: 'building' });
    scatterTreesAt(ctx, cx - 16, cz - 14, cx + 16, cz + 14, 5);
  }
}

function scatterTreesAt(ctx: BuildCtx, x0: number, z0: number, x1: number, z1: number, n: number) {
  const { rng } = ctx;
  for (let i = 0; i < n; i++) {
    const x = randRange(rng, x0, x1);
    const z = randRange(rng, z0, z1);
    ctx.trees.push({ x, z, s: randRange(rng, 0.9, 1.4), kind: 'round', rot: rng() * 6.28, y: 0 });
    ctx.colliders.add({ kind: 'circle', x, z, r: 0.4, tag: 'tree' });
  }
}

/** Pine forest patch with a darker undergrowth floor. */
function forest(ctx: BuildCtx, r: Rect) {
  const { rng } = ctx;
  ctx.b.field.setColor('#44582f');
  ctx.b.field.flatRect(r.minX, r.maxX, r.minZ, r.maxZ, 0.025);
  const area = (r.maxX - r.minX) * (r.maxZ - r.minZ);
  const n = Math.min(260, Math.floor(area / 380));
  for (let i = 0; i < n; i++) {
    const x = randRange(rng, r.minX + 3, r.maxX - 3);
    const z = randRange(rng, r.minZ + 3, r.maxZ - 3);
    ctx.trees.push({ x, z, s: randRange(rng, 1.1, 2.0), kind: rng() < 0.8 ? 'pine' : 'round', rot: rng() * 6.28, y: 0 });
    ctx.colliders.add({ kind: 'circle', x, z, r: 0.5, tag: 'tree' });
  }
}

/** Filling station on the frontage road (canopy, pumps, shop, price pylon) + fields behind. */
function fuelStation(ctx: BuildCtx, r: Rect, blk: Block) {
  const { rng } = ctx;
  const f: Dir4 = blk.frontage.W ? 'W' : blk.frontage.N ? 'N' : blk.frontage.E ? 'E' : 'S';
  // Station footprint (60 × 45) against the frontage side near the town end of the block
  const SW = 60;
  const SD = 45;
  let st: Rect;
  if (f === 'W') st = { minX: r.minX, maxX: r.minX + SD, minZ: r.minZ + 8, maxZ: r.minZ + 8 + SW };
  else if (f === 'E') st = { minX: r.maxX - SD, maxX: r.maxX, minZ: r.minZ + 8, maxZ: r.minZ + 8 + SW };
  else if (f === 'N') st = { minX: (r.minX + r.maxX) / 2 - SW / 2, maxX: (r.minX + r.maxX) / 2 + SW / 2, minZ: r.minZ, maxZ: r.minZ + SD };
  else st = { minX: (r.minX + r.maxX) / 2 - SW / 2, maxX: (r.minX + r.maxX) / 2 + SW / 2, minZ: r.maxZ - SD, maxZ: r.maxZ };
  groundRect(ctx, 'asphaltLot', st, 0.05);
  const cx = (st.minX + st.maxX) / 2;
  const cz = (st.minZ + st.maxZ) / 2;
  const ns = f === 'W' || f === 'E';
  // canopy
  const cw = ns ? 14 : 26;
  const cd = ns ? 26 : 14;
  const ccx = f === 'W' ? st.minX + 14 : f === 'E' ? st.maxX - 14 : cx;
  const ccz = f === 'N' ? st.minZ + 14 : f === 'S' ? st.maxZ - 14 : cz;
  ctx.b.trim.setColor('#f4f4f4');
  ctx.b.trim.box(ccx - cw / 2, ccx + cw / 2, 5.2, 6.0, ccz - cd / 2, ccz + cd / 2);
  ctx.b.trim.setColor('#d32f2f');
  ctx.b.trim.box(ccx - cw / 2 - 0.05, ccx + cw / 2 + 0.05, 5.5, 5.95, ccz - cd / 2 - 0.05, ccz + cd / 2 + 0.05, { top: false });
  ctx.b.metal.setColor('#c7ccd0');
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = ccx + sx * (cw / 2 - 2);
      const pz = ccz + sz * (cd / 2 - 3);
      ctx.b.metal.box(px - 0.25, px + 0.25, 0, 5.2, pz - 0.25, pz + 0.25);
      ctx.colliders.add({ kind: 'circle', x: px, z: pz, r: 0.4, tag: 'pole' });
    }
  }
  // pump islands
  for (let i = -1; i <= 1; i += 2) {
    const px = ns ? ccx : ccx + i * 5;
    const pz = ns ? ccz + i * 5 : ccz;
    ctx.b.concrete.setColor('#bdbab2');
    ctx.b.concrete.box(px - (ns ? 0.9 : 3), px + (ns ? 0.9 : 3), 0, 0.2, pz - (ns ? 3 : 0.9), pz + (ns ? 3 : 0.9));
    for (const k of [-1.6, 1.6]) {
      const qx = ns ? px : px + k;
      const qz = ns ? pz + k : pz;
      ctx.b.trim.setColor('#e53935');
      ctx.b.trim.box(qx - 0.4, qx + 0.4, 0.2, 1.9, qz - 0.3, qz + 0.3);
      ctx.b.trim.setColor('#263238');
      ctx.b.trim.box(qx - 0.42, qx + 0.42, 1.2, 1.6, qz - 0.32, qz + 0.32, { top: false });
    }
    ctx.colliders.add({ kind: 'box', minX: px - (ns ? 0.9 : 3), maxX: px + (ns ? 0.9 : 3), minZ: pz - (ns ? 3 : 0.9), maxZ: pz + (ns ? 3 : 0.9), tag: 'barrier' });
  }
  // shop
  const shop: Rect =
    f === 'W'
      ? { minX: st.maxX - 14, maxX: st.maxX - 2, minZ: cz - 9, maxZ: cz + 9 }
      : f === 'E'
        ? { minX: st.minX + 2, maxX: st.minX + 14, minZ: cz - 9, maxZ: cz + 9 }
        : f === 'N'
          ? { minX: cx - 9, maxX: cx + 9, minZ: st.maxZ - 14, maxZ: st.maxZ - 2 }
          : { minX: cx - 9, maxX: cx + 9, minZ: st.minZ + 2, maxZ: st.minZ + 14 };
  storefront(ctx, shop.minX, shop.maxX, shop.minZ, shop.maxZ, 4.2);
  ctx.b.roof.setColor('#ffffff');
  ctx.b.roof.flatRect(shop.minX, shop.maxX, shop.minZ, shop.maxZ, 4.2);
  addSolid(ctx, shop.minX, shop.maxX, shop.minZ, shop.maxZ);
  // price pylon at the road
  const px = f === 'W' ? st.minX + 2 : f === 'E' ? st.maxX - 2 : st.minX + 3;
  const pz = f === 'N' ? st.minZ + 2 : f === 'S' ? st.maxZ - 2 : st.minZ + 3;
  ctx.b.trim.setColor('#b71c1c');
  ctx.b.trim.box(px - 0.8, px + 0.8, 0, 8.5, pz - 0.3, pz + 0.3);
  ctx.colliders.add({ kind: 'box', minX: px - 0.8, maxX: px + 0.8, minZ: pz - 0.3, maxZ: pz + 0.3, tag: 'barrier' });
  const faceRot = f === 'W' ? -Math.PI / 2 : f === 'E' ? Math.PI / 2 : f === 'N' ? Math.PI : 0;
  const fx = Math.sin(faceRot) * 0.32;
  const fz = Math.cos(faceRot) * 0.32;
  ctx.signBoards.push({ x: px + fx, y: 7.2, z: pz + fz, rot: faceRot, text: 'AKARYAKIT', w: 1.5, h: 1.4, bg: '#b71c1c', fg: '#ffffff' });
  ctx.signBoards.push({ x: px + fx, y: 5.6, z: pz + fz, rot: faceRot, text: 'Benzin 47.90', w: 1.5, h: 0.6, bg: '#101418', fg: '#ffd54f' });
  ctx.signBoards.push({ x: px + fx, y: 4.9, z: pz + fz, rot: faceRot, text: 'Motorin 49.20', w: 1.5, h: 0.6, bg: '#101418', fg: '#ffd54f' });
  // parked car spots are cones for now + fields for the rest of the block
  ctx.cones.push({ x: st.minX + 4, z: st.maxZ - 4, rot: 0, y: 0.05 });
  const rest: Rect =
    f === 'W' || f === 'E'
      ? { minX: r.minX, maxX: r.maxX, minZ: st.maxZ + 6, maxZ: r.maxZ }
      : f === 'N'
        ? { minX: r.minX, maxX: r.maxX, minZ: st.maxZ + 6, maxZ: r.maxZ }
        : { minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: st.minZ - 6 };
  if (rest.maxX - rest.minX > 20 && rest.maxZ - rest.minZ > 20) farm(ctx, rest, { ...blk, frontage: { N: false, S: false, E: false, W: false } });
  if (rng() < 0.5) scatterTreesAt(ctx, st.minX + 2, st.maxZ + 1, st.maxX - 2, st.maxZ + 5, 4);
}

/** Large logistics / industrial estate: rows of warehouses, truck yards, fences. */
function logistics(ctx: BuildCtx, r: Rect) {
  const { rng } = ctx;
  groundRect(ctx, 'concrete', r, 0.04);
  perimeterWall(ctx, { ...r }, 'fence');
  const cols = Math.max(1, Math.floor((r.maxX - r.minX - 20) / 85));
  const rows = Math.max(1, Math.floor((r.maxZ - r.minZ - 20) / 75));
  const cw = (r.maxX - r.minX - 20) / cols;
  const rd = (r.maxZ - r.minZ - 20) / rows;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x0 = r.minX + 10 + i * cw + 8;
      const x1 = x0 + cw - 16;
      const z0 = r.minZ + 10 + j * rd + 8;
      const z1 = z0 + rd * 0.55;
      if (rng() < 0.18) {
        // truck yard
        groundRect(ctx, 'asphaltLot', { minX: x0, maxX: x1, minZ: z0, maxZ: z0 + rd - 16 }, 0.06);
        continue;
      }
      const h = randRange(rng, 9, 14);
      facadeBox(ctx, 'industrial', pick(rng, ['#ffffff', '#e6eef2', '#f2ebe0', '#dfe6ea']), x0, x1, 0, h, z0, z1);
      ctx.b.roof.setColor('#ffffff');
      ctx.b.roof.flatRect(x0, x1, z0, z1, h);
      // loading docks
      ctx.b.trim.setColor('#37474f');
      for (let x = x0 + 4; x < x1 - 4; x += 7) ctx.b.trim.box(x, x + 3.6, 0.3, 4.2, z1 - 0.1, z1 + 0.05, { top: false });
      addSolid(ctx, x0, x1, z0, z1);
    }
  }
  // Company sign
  ctx.signBoards.push({ x: (r.minX + r.maxX) / 2, y: 4, z: r.minZ - 0.3, rot: Math.PI, text: 'LOJİSTİK MERKEZİ', w: 14, h: 1.6, bg: '#0d47a1', fg: '#ffffff' });
}
