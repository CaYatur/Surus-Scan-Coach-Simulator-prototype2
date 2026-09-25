import * as THREE from 'three';
import { mulberry32, randRange, type Rng } from '../core/math';
import type { MapDef } from './mapDefs';
import {
  RoadNetwork,
  SIDEWALK_W,
  CURB_H,
  DIRS,
  type Dir4,
  type Lane,
  type RoadEdge,
  type RoadNode,
} from './roadNetwork';
import { MeshBuilder } from './meshBuilder';
import { ColliderWorld } from './colliders';
import { LAYER_DETAIL } from '../vehicle/cockpit';
import { fillBlock, type BuildCtx, type MatKey, type PropInst, type TreeInst } from './buildings';
import {
  asphaltTexture,
  concreteTexture,
  facadeTexture,
  flagTexture,
  glowTexture,
  grassTexture,
  paverTexture,
  roofTexture,
  signAtlas,
  textTexture,
  tileRoofTexture,
  waterTexture,
  type FacadeKind,
  type SignKind,
} from './textures';

const TILE = 280;

function detail<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => c.layers.set(LAYER_DETAIL));
  return o;
}

export type ParkingSlot = { x: number; z: number; heading: number; edge: RoadEdge; side: 1 | -1; along: number; occupied: boolean };
export type SignalState = 'red' | 'yellow' | 'green' | 'redyellow' | 'off';

type Pt = { x: number; y: number; z: number };

/** Emits an upward-facing quad regardless of point order. */
function quadUp(b: MeshBuilder, p0: Pt, p1: Pt, p2: Pt, p3: Pt) {
  const ax = p1.x - p0.x;
  const az = p1.z - p0.z;
  const bx = p3.x - p0.x;
  const bz = p3.z - p0.z;
  const ny = az * bx - ax * bz;
  if (ny >= 0) b.quad(p0, p1, p2, p3);
  else b.quad(p0, p3, p2, p1);
}

function triUp(b: MeshBuilder, p0: Pt, p1: Pt, p2: Pt) {
  const ny = (p1.z - p0.z) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.z - p0.z);
  if (ny >= 0) b.tri(p0, p1, p2);
  else b.tri(p0, p2, p1);
}

/** Edge-local → world helper: s along x0→x1, l along edge.right. */
function ep(e: RoadEdge, s: number, l: number, y: number): Pt {
  return { x: e.x0 + e.dx * s + e.rx * l, y, z: e.z0 + e.dz * s + e.rz * l };
}

function edgeStripe(b: MeshBuilder, e: RoadEdge, s0: number, s1: number, l0: number, l1: number, y: number) {
  quadUp(b, ep(e, s0, l0, y), ep(e, s1, l0, y), ep(e, s1, l1, y), ep(e, s0, l1, y));
}

function dashed(b: MeshBuilder, e: RoadEdge, s0: number, s1: number, l: number, w: number, dash: number, gap: number, y: number) {
  for (let s = s0; s < s1; s += dash + gap) edgeStripe(b, e, s, Math.min(s + dash, s1), l - w / 2, l + w / 2, y);
}

type SignalHeadRef = { red: number[]; yellow: number[]; green: number[] };

/** Instanced lamp discs of every traffic light; state is pushed via instance colours. */
export class SignalLights {
  readonly mesh: THREE.InstancedMesh;
  private heads = new Map<string, SignalHeadRef>();
  private count = 0;
  private readonly on = {
    red: new THREE.Color(1.0, 0.08, 0.05).multiplyScalar(11),
    yellow: new THREE.Color(1.0, 0.62, 0.05).multiplyScalar(8),
    green: new THREE.Color(0.1, 1.0, 0.45).multiplyScalar(7),
  };
  private readonly off = {
    red: new THREE.Color(0.18, 0.03, 0.03),
    yellow: new THREE.Color(0.18, 0.12, 0.02),
    green: new THREE.Color(0.02, 0.14, 0.06),
  };
  private readonly positions: THREE.Matrix4[] = [];

  constructor(capacity: number) {
    const geo = new THREE.CircleGeometry(0.13, 16);
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, capacity));
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  addHead(key: string, matrix: THREE.Matrix4) {
    let ref = this.heads.get(key);
    if (!ref) this.heads.set(key, (ref = { red: [], yellow: [], green: [] }));
    const ys: [keyof SignalHeadRef, number][] = [
      ['red', 0.3],
      ['yellow', 0],
      ['green', -0.3],
    ];
    for (const [k, dy] of ys) {
      const m = matrix.clone().multiply(new THREE.Matrix4().makeTranslation(0, dy, 0.16));
      this.positions.push(m);
      ref[k].push(this.count++);
    }
  }

  finalize() {
    this.mesh.count = this.count;
    this.positions.forEach((m, i) => this.mesh.setMatrixAt(i, m));
    for (const ref of this.heads.values()) {
      for (const i of ref.red) this.mesh.setColorAt(i, this.off.red);
      for (const i of ref.yellow) this.mesh.setColorAt(i, this.off.yellow);
      for (const i of ref.green) this.mesh.setColorAt(i, this.off.green);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  set(nodeId: number, arm: Dir4, state: SignalState) {
    const ref = this.heads.get(`${nodeId}:${arm}`);
    if (!ref) return;
    const r = state === 'red' || state === 'redyellow';
    const y = state === 'yellow' || state === 'redyellow';
    const g = state === 'green';
    for (const i of ref.red) this.mesh.setColorAt(i, r ? this.on.red : this.off.red);
    for (const i of ref.yellow) this.mesh.setColorAt(i, y ? this.on.yellow : this.off.yellow);
    for (const i of ref.green) this.mesh.setColorAt(i, g ? this.on.green : this.off.green);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

export type CityMaterials = {
  asphalt: THREE.MeshStandardMaterial;
  marking: THREE.MeshStandardMaterial;
  sidewalk: THREE.MeshStandardMaterial;
  facades: THREE.MeshStandardMaterial[];
  lampHead: THREE.MeshStandardMaterial;
  lightPool: THREE.MeshBasicMaterial;
  byKey: Record<MatKey, THREE.MeshStandardMaterial>;
};

export class CityWorld {
  readonly group = new THREE.Group();
  readonly net: RoadNetwork;
  readonly colliders = new ColliderWorld();
  readonly parking: ParkingSlot[] = [];
  readonly parkingBays: BuildCtx['parkingBays'] = [];
  readonly signals: SignalLights;
  readonly materials: CityMaterials;
  readonly map: MapDef;
  private flags: { mesh: THREE.Mesh; base: Float32Array }[] = [];
  private rng: Rng;
  private lampCount = 0;
  private anisotropy: number;

  constructor(map: MapDef, anisotropy = 8) {
    this.map = map;
    this.anisotropy = anisotropy;
    this.net = new RoadNetwork(map);
    this.rng = mulberry32(map.seed ^ 0xabcdef);
    this.materials = this.createMaterials();
    let signalCount = 0;
    for (const n of this.net.nodes) if (n.signalized) signalCount += n.armCount * 2 * 3;
    this.signals = new SignalLights(signalCount);
    this.build();
  }

  // ————————————————————————————— materials —————————————————————————————

  private createMaterials(): CityMaterials {
    const A = this.anisotropy;
    const asp = asphaltTexture();
    asp.map.anisotropy = A;
    const asphalt = new THREE.MeshStandardMaterial({ map: asp.map, roughnessMap: asp.rough, roughness: 0.92, metalness: 0.0, color: 0xffffff });
    const marking = new THREE.MeshStandardMaterial({
      color: 0xf4f4f0,
      roughness: 0.7,
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const paver = paverTexture();
    paver.anisotropy = A;
    const sidewalk = new THREE.MeshStandardMaterial({ map: paver, roughness: 0.85, vertexColors: true });
    const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, ...o });
    const facade = (kind: FacadeKind, seed: number, extra: THREE.MeshStandardMaterialParameters = {}) => {
      const t = facadeTexture(kind, seed);
      t.map.anisotropy = A;
      return std({ map: t.map, emissiveMap: t.emissive, emissive: 0xffffff, emissiveIntensity: 0, ...extra });
    };
    const grass = grassTexture();
    grass.anisotropy = A;
    const byKey: Record<MatKey, THREE.MeshStandardMaterial> = {
      apartment: facade('apartment', 101),
      office: facade('office', 202, { roughness: 0.35, metalness: 0.35 }),
      brick: facade('brick', 303),
      modern: facade('modern', 404, { roughness: 0.6 }),
      storefront: facade('storefront', 505, { roughness: 0.6 }),
      house: facade('house', 606),
      industrial: facade('industrial', 707, { roughness: 0.7, metalness: 0.2 }),
      school: facade('school', 808),
      roof: std({ map: roofTexture(), roughness: 0.95 }),
      tileRoof: std({ map: tileRoofTexture(), roughness: 0.8 }),
      concrete: std({ map: concreteTexture(), roughness: 0.9 }),
      paver: std({ map: paver, roughness: 0.85 }),
      grass: std({ map: grass, roughness: 1 }),
      trim: std({ roughness: 0.8 }),
      metal: std({ roughness: 0.4, metalness: 0.55 }),
      glass: std({ color: 0x5a7d99, roughness: 0.1, metalness: 0.6 }),
      stone: std({ map: concreteTexture(), roughness: 0.75 }),
      dome: std({ roughness: 0.35, metalness: 0.7 }),
      water: std({ map: waterTexture(), roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.9 }),
      hedge: std({ color: 0x3f6b2f, roughness: 1 }),
      asphaltLot: std({ map: asp.map, roughness: 0.9 }),
    };
    const lampHead = new THREE.MeshStandardMaterial({ color: 0xfff4dd, emissive: 0xffd9a0, emissiveIntensity: 0.2, roughness: 0.4 });
    const lightPool = new THREE.MeshBasicMaterial({
      map: glowTexture('rgba(255,214,150,0.55)', 'rgba(255,190,110,0)'),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    return {
      asphalt,
      marking,
      sidewalk,
      facades: [byKey.apartment, byKey.office, byKey.brick, byKey.modern, byKey.storefront, byKey.house, byKey.industrial, byKey.school],
      lampHead,
      lightPool,
      byKey,
    };
  }

  // ————————————————————————————— build —————————————————————————————

  private build() {
    const net = this.net;
    const road = new MeshBuilder();
    const marks = new MeshBuilder();
    const walk = new MeshBuilder();
    const curb = new MeshBuilder();
    const builders = {} as Record<MatKey, MeshBuilder>;
    for (const k of Object.keys(this.materials.byKey) as MatKey[]) builders[k] = new MeshBuilder();
    const ctx: BuildCtx = {
      rng: this.rng,
      b: builders,
      colliders: this.colliders,
      trees: [],
      benches: [],
      parkLamps: [],
      bins: [],
      cones: [],
      specials: [],
      flagSpots: [],
      signBoards: [],
      parkingBays: this.parkingBays,
    };

    this.buildGround();

    // Asphalt: edges + junction boxes
    for (const e of net.edges) {
      const hw = e.halfWidth;
      if (e.axis === 'ns') road.flatRect(e.x0 - hw, e.x0 + hw, e.z0, e.z1, 0, 1 / 6);
      else road.flatRect(e.x0, e.x1, e.z0 - hw, e.z0 + hw, 0, 1 / 6);
    }
    for (const n of net.nodes) road.flatRect(n.x - n.hx, n.x + n.hx, n.z - n.hz, n.z + n.hz, 0, 1 / 6);
    for (const c of this.map.sidewalkCuts) road.flatRect(c.minX, c.maxX, c.minZ, c.maxZ, 0.004, 1 / 6);

    // Sidewalks (raised) + curb stones
    walk.setColor('#ffffff');
    for (const s of net.sidewalks) walk.box(s.minX, s.maxX, 0, CURB_H, s.minZ, s.maxZ, { tileU: 2, tileV: 2 });
    curb.setColor('#c9c6be');
    for (const e of net.edges) {
      const hw = e.halfWidth;
      for (const side of [-1, 1]) {
        const l0 = side * hw;
        const l1 = side * (hw + 0.22);
        const a = ep(e, 0, l0, 0);
        const b = ep(e, e.length, l1, 0);
        curb.box(Math.min(a.x, b.x), Math.max(a.x, b.x), 0, CURB_H + 0.012, Math.min(a.z, b.z), Math.max(a.z, b.z), { tileU: 1, tileV: 1 });
      }
      this.buildEdgeMarkings(marks, e);
      if (e.spec.medianRaised) this.buildMedian(ctx, e);
    }
    for (const n of net.nodes) this.buildNodeMarkings(marks, n);

    // Blocks
    for (const blk of net.blocks) fillBlock(ctx, blk, net.isOuterBlock(blk));

    // Roadside props
    const lamps: PropInst[] = [];
    this.buildStreetProps(ctx, lamps);
    this.buildParking();
    this.buildSignals(ctx);
    const signs = this.buildSigns();

    // World bounds
    const ext = this.map.extent;
    const T = 5;
    this.colliders.add({ kind: 'box', minX: ext.minX - T, maxX: ext.minX, minZ: ext.minZ - T, maxZ: ext.maxZ + T, tag: 'barrier' });
    this.colliders.add({ kind: 'box', minX: ext.maxX, maxX: ext.maxX + T, minZ: ext.minZ - T, maxZ: ext.maxZ + T, tag: 'barrier' });
    this.colliders.add({ kind: 'box', minX: ext.minX, maxX: ext.maxX, minZ: ext.minZ - T, maxZ: ext.minZ, tag: 'barrier' });
    this.colliders.add({ kind: 'box', minX: ext.minX, maxX: ext.maxX, minZ: ext.maxZ, maxZ: ext.maxZ + T, tag: 'barrier' });

    // Meshes
    const g = this.group;
    g.add(road.toMesh(this.materials.asphalt));
    g.add(marks.toMesh(this.materials.marking));
    g.add(walk.toMesh(this.materials.sidewalk));
    g.add(curb.toMesh(this.materials.byKey.concrete));
    for (const k of Object.keys(builders) as MatKey[]) {
      const b = builders[k];
      if (b.empty) continue;
      const cast = !['grass', 'paver', 'concrete', 'asphaltLot', 'water'].includes(k);
      for (const m of b.toTiledMeshes(this.materials.byKey[k], TILE, { cast, receive: true })) g.add(m);
    }
    for (const s of ctx.specials) g.add(s);
    this.buildTrees(ctx.trees);
    this.buildLamps(lamps, ctx.parkLamps);
    this.buildSmallProps(ctx);
    this.buildFlags(ctx.flagSpots);
    this.buildSignBoards(ctx.signBoards);
    this.buildMountains();
    g.add(this.signals.mesh);
    for (const s of signs) g.add(detail(s));
    this.signals.finalize();
    this.buildDecals();
  }

  private buildGround() {
    const ext = this.map.extent;
    const size = 5200;
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (size / 10), uv.getY(i) * (size / 10));
    const tex = grassTexture();
    tex.anisotropy = this.anisotropy;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, color: 0xd6dcc8 });
    const m = new THREE.Mesh(geo, mat);
    m.position.set((ext.minX + ext.maxX) / 2, -0.02, (ext.minZ + ext.maxZ) / 2);
    m.receiveShadow = true;
    this.group.add(m);
  }

  private buildMountains() {
    const rng = mulberry32(this.map.seed ^ 77);
    const b = new MeshBuilder();
    const ext = this.map.extent;
    const cx = (ext.minX + ext.maxX) / 2;
    const cz = (ext.minZ + ext.maxZ) / 2;
    const R = Math.max(ext.maxX - ext.minX, ext.maxZ - ext.minZ) * 0.9 + 600;
    const n = 42;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng() * 0.1;
      const r = R + rng() * 500;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const h = 120 + rng() * 260;
      const w = 260 + rng() * 380;
      const shade = 0.75 + rng() * 0.25;
      b.setColor(new THREE.Color(0.36 * shade, 0.45 * shade, 0.36 * shade));
      b.cylinder(x, z, -5, h, w, 12 + rng() * 30, 7, true);
    }
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, fog: true });
    const mesh = b.toMesh(mat, { receive: false });
    mesh.userData.distant = true;
    this.group.add(mesh);
  }

  private buildMedian(ctx: BuildCtx, e: RoadEdge) {
    const half = e.spec.median / 2;
    const a = ep(e, 0.5, -half, 0);
    const b = ep(e, e.length - 0.5, half, 0);
    const r = { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) };
    ctx.b.trim.setColor('#c9c6be');
    ctx.b.trim.box(r.minX, r.maxX, 0, 0.2, r.minZ, r.maxZ, { top: false });
    ctx.b.grass.setColor('#ffffff');
    ctx.b.grass.flatRect(r.minX + (e.axis === 'ns' ? 0.2 : 0), r.maxX - (e.axis === 'ns' ? 0.2 : 0), r.minZ + (e.axis === 'ew' ? 0.2 : 0), r.maxZ - (e.axis === 'ew' ? 0.2 : 0), 0.2, 1 / 8);
    ctx.b.trim.setColor('#bdbab2');
    if (e.axis === 'ns') {
      ctx.b.trim.box(r.minX, r.minX + 0.2, 0, 0.22, r.minZ, r.maxZ, { top: true });
      ctx.b.trim.box(r.maxX - 0.2, r.maxX, 0, 0.22, r.minZ, r.maxZ, { top: true });
    } else {
      ctx.b.trim.box(r.minX, r.maxX, 0, 0.22, r.minZ, r.minZ + 0.2, { top: true });
      ctx.b.trim.box(r.minX, r.maxX, 0, 0.22, r.maxZ - 0.2, r.maxZ, { top: true });
    }
    for (let s = 8; s < e.length - 8; s += 13) {
      const p = ep(e, s, 0, 0);
      ctx.trees.push({ x: p.x, z: p.z, s: randRange(this.rng, 0.9, 1.15), kind: 'cypress', rot: 0, y: 0.2 });
      this.colliders.add({ kind: 'circle', x: p.x, z: p.z, r: 0.35, tag: 'tree' });
    }
  }

  private buildEdgeMarkings(b: MeshBuilder, e: RoadEdge) {
    const s = e.spec;
    const y = 0.012;
    const L = e.length;
    const W = 0.14;
    b.setColor('#ffffff');
    if (e.oneway !== 0) {
      const outer = (s.lanes * s.laneWidth) / 2;
      for (let i = 1; i < s.lanes; i++) {
        const l = -outer + i * s.laneWidth;
        dashed(b, e, 18, L - 18, l, W, 3, 6, y);
        edgeStripe(b, e, 1, 18, l - W / 2, l + W / 2, y);
        edgeStripe(b, e, L - 18, L - 1, l - W / 2, l + W / 2, y);
      }
      edgeStripe(b, e, 0, L, outer - 0.07, outer + 0.07, y);
      edgeStripe(b, e, 0, L, -outer - 0.07, -outer + 0.07, y);
    } else {
      const half = s.median / 2;
      const outer = half + s.lanes * s.laneWidth;
      // centre
      if (!s.medianRaised) {
        if (s.lanes >= 2) {
          edgeStripe(b, e, 0.5, L - 0.5, -0.22, -0.08, y);
          edgeStripe(b, e, 0.5, L - 0.5, 0.08, 0.22, y);
        } else {
          dashed(b, e, 14, L - 14, 0, W, 3, 5, y);
          edgeStripe(b, e, 0.5, 14, -W / 2, W / 2, y);
          edgeStripe(b, e, L - 14, L - 0.5, -W / 2, W / 2, y);
        }
      }
      // lane dividers
      for (const side of [-1, 1]) {
        for (let i = 1; i < s.lanes; i++) {
          const l = side * (half + i * s.laneWidth);
          dashed(b, e, 20, L - 20, l, W, 3, 6, y);
          edgeStripe(b, e, 1, 20, l - W / 2, l + W / 2, y);
          edgeStripe(b, e, L - 20, L - 1, l - W / 2, l + W / 2, y);
        }
        const el = side * (s.parking > 0 ? outer : outer - 0.35);
        edgeStripe(b, e, 0, L, el - 0.07, el + 0.07, y);
      }
    }
    // parking bay ticks
    if (s.parking > 0) {
      const outer = e.oneway !== 0 ? (s.lanes * s.laneWidth) / 2 : s.median / 2 + s.lanes * s.laneWidth;
      for (const side of [-1, 1]) {
        for (let a = 10; a < L - 10; a += 5.8) {
          if (e.zebras.some((z) => Math.abs(z - a) < 6)) continue;
          edgeStripe(b, e, a - 0.06, a + 0.06, side * outer, side * (outer + s.parking * 0.85), y);
        }
      }
    }
    // Mid-block zebras
    for (const zs of e.zebras) this.zebra(b, e, zs - 1.6, zs + 1.6, y);
    // Turn arrows
    for (const lane of [...e.lanesFwd, ...e.lanesBwd]) this.laneArrows(b, lane);
  }

  private zebra(b: MeshBuilder, e: RoadEdge, s0: number, s1: number, y: number) {
    const hw = e.halfWidth - 0.3;
    b.setColor('#ffffff');
    for (let l = -hw; l < hw - 0.3; l += 1.0) edgeStripe(b, e, s0, s1, l, l + 0.5, y + 0.001);
  }

  private laneArrows(b: MeshBuilder, lane: Lane) {
    const turns = new Set(lane.outs.map((c) => c.turn));
    if (!turns.size) return;
    const e = lane.edge;
    if (e.spec.lanes < 2 && !lane.endNode.signalized) return;
    if (lane.path.length < 40) return;
    const p = { x: 0, z: 0, h: 0 };
    lane.path.sample(lane.stopS - 9, p);
    const h = lane.heading;
    const tx = Math.sin(h);
    const tz = Math.cos(h);
    const rx = -Math.cos(h);
    const rz = Math.sin(h);
    const y = 0.013;
    const P = (u: number, v: number): Pt => ({ x: p.x + rx * u + tx * v, y, z: p.z + rz * u + tz * v });
    const shaft = (u0: number, v0: number, u1: number, v1: number, w: number) => {
      const dx = u1 - u0;
      const dv = v1 - v0;
      const len = Math.hypot(dx, dv) || 1;
      const nu = (-dv / len) * (w / 2);
      const nv = (dx / len) * (w / 2);
      quadUp(b, P(u0 + nu, v0 + nv), P(u1 + nu, v1 + nv), P(u1 - nu, v1 - nv), P(u0 - nu, v0 - nv));
    };
    const head = (u: number, v: number, du: number, dv: number) => {
      const len = Math.hypot(du, dv) || 1;
      const fu = du / len;
      const fv = dv / len;
      triUp(b, P(u + fu * 1.2, v + fv * 1.2), P(u - fv * 0.55, v + fu * 0.55), P(u + fv * 0.55, v - fu * 0.55));
    };
    b.setColor('#ffffff');
    const hasS = turns.has('S');
    const hasL = turns.has('L');
    const hasR = turns.has('R');
    shaft(0, -2.5, 0, hasS ? 1.2 : 0, 0.28);
    if (hasS) head(0, 1.2, 0, 1);
    if (hasR) {
      shaft(0, -0.2, 0.9, 0.7, 0.26);
      head(0.9, 0.7, 1, 0.35);
    }
    if (hasL) {
      shaft(0, -0.2, -0.9, 0.7, 0.26);
      head(-0.9, 0.7, -1, 0.35);
    }
  }

  private buildNodeMarkings(b: MeshBuilder, n: RoadNode) {
    const y = 0.012;
    for (const d of DIRS) {
      const e = n.arms[d];
      if (!e) continue;
      const atB = e.b === n;
      if (n.crosswalk[d]) {
        const s0 = atB ? e.length - 3.3 : 0.3;
        this.zebra(b, e, s0, s0 + 3, y);
      }
      const control = n.control[d];
      if (!control || control === 'none') continue;
      const ins = this.net.incomingLanes(n, d);
      if (!ins.length) continue;
      const lane = ins[0];
      const sEdge = atB ? lane.stopS : e.length - lane.stopS;
      let lmin = Infinity;
      let lmax = -Infinity;
      for (const l of ins) {
        lmin = Math.min(lmin, l.lateral - l.width / 2);
        lmax = Math.max(lmax, l.lateral + l.width / 2);
      }
      b.setColor('#ffffff');
      if (control === 'yield') {
        // shark teeth
        for (let l = lmin + 0.3; l < lmax - 0.5; l += 0.9) {
          const a = ep(e, sEdge, l, y);
          const c = ep(e, sEdge, l + 0.6, y);
          const tip = ep(e, sEdge + (atB ? -0.7 : 0.7), l + 0.3, y);
          triUp(b, a, c, tip);
        }
      } else {
        edgeStripe(b, e, sEdge - 0.25, sEdge + 0.25, lmin, lmax, y);
      }
    }
  }

  // ————————————————————————————— props —————————————————————————————

  private buildStreetProps(ctx: BuildCtx, lamps: PropInst[]) {
    const rng = this.rng;
    for (const e of this.net.edges) {
      const district = this.map.district(e.cx, e.cz);
      const leafy = district !== 'downtown' && district !== 'industrial';
      const spacing = e.cls === 'boulevard' || e.cls === 'avenue' ? 30 : 36;
      for (const side of [-1, 1] as const) {
        const off = side === 1 ? 0 : spacing / 2;
        for (let s = 10 + off; s < e.length - 8; s += spacing) {
          if (e.zebras.some((z) => Math.abs(z - s) < 5)) continue;
          const p = ep(e, s, side * (e.halfWidth + 0.55), CURB_H);
          const rot = Math.atan2(-e.rx * side, -e.rz * side); // arm points to road centre
          lamps.push({ x: p.x, z: p.z, rot, y: CURB_H });
          this.colliders.add({ kind: 'circle', x: p.x, z: p.z, r: 0.18, tag: 'pole' });
        }
        if (leafy) {
          for (let s = 16 + off * 0.5; s < e.length - 12; s += 12) {
            if (e.zebras.some((z) => Math.abs(z - s) < 5)) continue;
            if (rng() < 0.2) continue;
            const p = ep(e, s, side * (e.halfWidth + SIDEWALK_W - 0.85), CURB_H);
            ctx.trees.push({ x: p.x, z: p.z, s: randRange(rng, 0.75, 1.05), kind: 'round', rot: rng() * 6, y: CURB_H });
            this.colliders.add({ kind: 'circle', x: p.x, z: p.z, r: 0.3, tag: 'tree' });
          }
        }
      }
      // bus stop on larger roads
      if ((e.cls === 'avenue' || e.cls === 'boulevard') && e.length > 100 && rng() < 0.6) {
        const side = rng() < 0.5 ? -1 : 1;
        const s = e.length * 0.4;
        this.busStop(ctx, e, s, side);
      }
    }
  }

  private busStop(ctx: BuildCtx, e: RoadEdge, s: number, side: number) {
    const base = e.halfWidth + SIDEWALK_W - 0.7;
    const p0 = ep(e, s - 2.5, side * (base - 0.9), CURB_H);
    const p1 = ep(e, s + 2.5, side * base, CURB_H);
    const minX = Math.min(p0.x, p1.x);
    const maxX = Math.max(p0.x, p1.x);
    const minZ = Math.min(p0.z, p1.z);
    const maxZ = Math.max(p0.z, p1.z);
    ctx.b.metal.setColor('#44515c');
    ctx.b.metal.box(minX, maxX, CURB_H + 2.5, CURB_H + 2.65, minZ, maxZ);
    ctx.b.glass.setColor('#ffffff');
    const back = ep(e, s, side * base, CURB_H);
    if (e.axis === 'ns') ctx.b.glass.box(back.x - 0.03, back.x + 0.03, CURB_H, CURB_H + 2.5, minZ, maxZ);
    else ctx.b.glass.box(minX, maxX, CURB_H, CURB_H + 2.5, back.z - 0.03, back.z + 0.03);
    ctx.b.trim.setColor('#7a5a3a');
    const seat = ep(e, s, side * (base - 0.35), CURB_H);
    ctx.b.trim.box(seat.x - (e.axis === 'ns' ? 0.2 : 1.5), seat.x + (e.axis === 'ns' ? 0.2 : 1.5), CURB_H + 0.45, CURB_H + 0.55, seat.z - (e.axis === 'ns' ? 1.5 : 0.2), seat.z + (e.axis === 'ns' ? 1.5 : 0.2));
    this.colliders.add({ kind: 'box', minX, maxX, minZ, maxZ, tag: 'barrier' });
  }

  private buildParking() {
    const rng = this.rng;
    for (const e of this.net.edges) {
      const s = e.spec;
      if (s.parking <= 0 || e.length < 30) continue;
      const district = this.map.district(e.cx, e.cz);
      const occ = district === 'downtown' ? 0.8 : district === 'commercial' ? 0.75 : district === 'suburb' ? 0.35 : district === 'park' ? 0.25 : 0.6;
      const outer = e.oneway !== 0 ? (s.lanes * s.laneWidth) / 2 : s.median / 2 + s.lanes * s.laneWidth;
      for (const side of [-1, 1] as const) {
        for (let a = 10 + 2.9; a < e.length - 10; a += 5.8) {
          if (e.zebras.some((z) => Math.abs(z - a) < 7)) continue;
          const p = ep(e, a, side * (outer + s.parking / 2 - 0.1), 0);
          // parked facing the legal travel direction of that side
          let heading = side === 1 ? e.heading : e.heading + Math.PI;
          if (e.oneway !== 0) heading = e.oneway === 1 ? e.heading : e.heading + Math.PI;
          this.parking.push({ x: p.x, z: p.z, heading, edge: e, side, along: a, occupied: rng() < occ });
        }
      }
    }
  }

  private buildSignals(ctx: BuildCtx) {
    const b = ctx.b.metal;
    for (const n of this.net.nodes) {
      if (!n.signalized) continue;
      for (const d of DIRS) {
        const ins = this.net.incomingLanes(n, d);
        if (!ins.length) continue;
        const e = n.arms[d]!;
        const atB = e.b === n;
        const lane = ins[0];
        const sEdge = atB ? lane.stopS + 1.4 : e.length - lane.stopS - 1.4;
        const side = Math.sign(lane.lateral) || 1;
        const pole = ep(e, sEdge, side * (e.halfWidth + 0.6), CURB_H);
        const faceH = lane.heading + Math.PI; // faces incoming traffic
        b.setColor('#2d3237');
        b.cylinder(pole.x, pole.z, CURB_H, CURB_H + 3.9, 0.09, 0.08, 8);
        this.colliders.add({ kind: 'circle', x: pole.x, z: pole.z, r: 0.2, tag: 'signal' });
        const addHead = (x: number, y: number, z: number) => {
          b.setColor('#1c1f22');
          b.orientedBox(x, y, z, 0.42, 1.05, 0.28, faceH);
          // visors
          for (const dy of [0.3, 0, -0.3]) {
            const vx = x + Math.sin(faceH) * 0.2;
            const vz = z + Math.cos(faceH) * 0.2;
            b.orientedBox(vx, y + dy + 0.14, vz, 0.36, 0.04, 0.16, faceH);
          }
          const m = new THREE.Matrix4().compose(
            new THREE.Vector3(x, y, z),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), faceH),
            new THREE.Vector3(1, 1, 1)
          );
          this.signals.addHead(`${n.id}:${d}`, m);
        };
        addHead(pole.x, CURB_H + 3.2, pole.z);
        if (ins.length >= 2 || e.halfWidth > 6) {
          // mast arm over the lanes
          const armLen = e.halfWidth * 0.75 + 1;
          b.setColor('#2d3237');
          b.cylinder(pole.x, pole.z, CURB_H + 3.9, CURB_H + 6.2, 0.1, 0.09, 8);
          const tip = ep(e, sEdge, side * (e.halfWidth + 0.6 - armLen), CURB_H);
          const midX = (pole.x + tip.x) / 2;
          const midZ = (pole.z + tip.z) / 2;
          const armRot = Math.atan2(tip.x - pole.x, tip.z - pole.z);
          b.orientedBox(midX, CURB_H + 6.1, midZ, 0.12, 0.12, armLen, armRot);
          const hx = pole.x + (tip.x - pole.x) * 0.8;
          const hz = pole.z + (tip.z - pole.z) * 0.8;
          addHead(hx, CURB_H + 5.4, hz);
        }
      }
    }
  }

  private buildSigns(): THREE.Object3D[] {
    const atlas = signAtlas();
    atlas.texture.anisotropy = this.anisotropy;
    const placements = new Map<SignKind, THREE.Matrix4[]>();
    const poles: THREE.Matrix4[] = [];
    const place = (kind: SignKind, x: number, z: number, faceH: number, y = CURB_H + 2.3) => {
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), faceH),
        new THREE.Vector3(1, 1, 1)
      );
      let list = placements.get(kind);
      if (!list) placements.set(kind, (list = []));
      list.push(m);
      poles.push(new THREE.Matrix4().makeTranslation(x - Math.sin(faceH) * 0.04, CURB_H, z - Math.cos(faceH) * 0.04));
      this.colliders.add({ kind: 'circle', x, z, r: 0.12, tag: 'pole' });
    };
    const limitKind = (l: number): SignKind => (l <= 30 ? 'limit30' : l <= 50 ? 'limit50' : 'limit70');
    for (const e of this.net.edges) {
      for (const lanes of [e.lanesFwd, e.lanesBwd]) {
        if (!lanes.length) continue;
        const lane = lanes[0];
        const side = Math.sign(lane.lateral) || 1;
        const sStart = lane.dir === 1 ? 7 : e.length - 7;
        const faceH = lane.heading + Math.PI;
        if (e.length > 50) {
          const p = ep(e, sStart, side * (e.halfWidth + 1.1), 0);
          place(limitKind(e.limit), p.x, p.z, faceH);
          if (e.zoneLabel) {
            const p2 = ep(e, lane.dir === 1 ? 20 : e.length - 20, side * (e.halfWidth + 1.1), 0);
            place('school', p2.x, p2.z, faceH);
          }
        }
        // Stop / yield at the end node
        const n = lane.endNode;
        const ctl = n.control[lane.arm];
        if (ctl === 'stop' || ctl === 'yield') {
          const s = lane.dir === 1 ? lane.stopS + 0.8 : e.length - lane.stopS - 0.8;
          const p = ep(e, s, side * (e.halfWidth + 1.0), 0);
          place(ctl === 'stop' ? 'stop' : 'yield', p.x, p.z, faceH);
        }
        for (const zs of e.zebras) {
          const s = lane.dir === 1 ? zs - 3 : zs + 3;
          const p = ep(e, s, side * (e.halfWidth + 1.1), 0);
          place('crosswalk', p.x, p.z, faceH);
        }
      }
      if (e.oneway !== 0) {
        // No-entry at the exit end (faces drivers who would enter against the flow)
        const exitAtB = e.oneway === 1;
        const s = exitAtB ? e.length - 3 : 3;
        const enterHeading = exitAtB ? e.heading + Math.PI : e.heading; // wrong-way entry heading
        const faceH = enterHeading + Math.PI;
        const rightSide = exitAtB ? -1 : 1; // right of the wrong-way driver
        for (const side of [rightSide, -rightSide]) {
          const p = ep(e, s, side * (e.halfWidth + 0.9), 0);
          place('noentry', p.x, p.z, faceH);
        }
        const sIn = exitAtB ? 12 : e.length - 12;
        const legalH = e.oneway === 1 ? e.heading : e.heading + Math.PI;
        const pr = ep(e, sIn, (e.oneway === 1 ? 1 : -1) * (e.halfWidth + 1.1), 0);
        place('oneway', pr.x, pr.z, legalH + Math.PI);
      }
    }
    // Hospital sign near hospital landmark
    for (const lm of this.map.landmarks) {
      if (lm.id !== 'hastane') continue;
      const near = this.net.nearestLane(lm.x, lm.z);
      if (near) {
        const p = { x: 0, z: 0, h: 0 };
        near.lane.path.sample(Math.max(0, near.s - 60), p);
        const rx = -Math.cos(p.h);
        const rz = Math.sin(p.h);
        place('hospital', p.x + rx * 6.5, p.z + rz * 6.5, p.h + Math.PI);
      }
    }

    const out: THREE.Object3D[] = [];
    const faceMat = new THREE.MeshStandardMaterial({ map: atlas.texture, alphaTest: 0.5, roughness: 0.5, metalness: 0.1 });
    const backMat = new THREE.MeshStandardMaterial({ map: atlas.texture, alphaTest: 0.5, color: 0x3a3f44, roughness: 0.7 });
    for (const [kind, mats] of placements) {
      const [u0, v0, u1, v1] = atlas.uv(kind);
      const geo = new THREE.PlaneGeometry(0.72, 0.72);
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
      const front = new THREE.InstancedMesh(geo, faceMat, mats.length);
      const backGeo = geo.clone();
      backGeo.rotateY(Math.PI);
      backGeo.translate(0, 0, -0.015);
      const back = new THREE.InstancedMesh(backGeo, backMat, mats.length);
      mats.forEach((m, i) => {
        front.setMatrixAt(i, m);
        back.setMatrixAt(i, m);
      });
      front.castShadow = true;
      out.push(front, back);
    }
    const poleGeo = new THREE.CylinderGeometry(0.045, 0.045, 2.35, 6);
    poleGeo.translate(0, 1.17, 0);
    const poleMesh = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: 0x9aa2a8, metalness: 0.6, roughness: 0.4 }), poles.length);
    poles.forEach((m, i) => poleMesh.setMatrixAt(i, m));
    poleMesh.castShadow = true;
    out.push(poleMesh);
    return out;
  }

  private buildTrees(trees: TreeInst[]) {
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
    const rng = mulberry32(99);
    const tiles = new Map<string, TreeInst[]>();
    for (const t of trees) {
      const k = `${Math.floor(t.x / TILE)}:${Math.floor(t.z / TILE)}:${t.kind}`;
      let l = tiles.get(k);
      if (!l) tiles.set(k, (l = []));
      l.push(t);
    }
    const geos = new Map<string, [THREE.BufferGeometry, THREE.BufferGeometry]>();
    for (const [key, list] of tiles) {
      const kind = key.split(':')[2] as TreeInst['kind'];
      if (!geos.has(kind)) {
      const trunk = new THREE.CylinderGeometry(0.12, 0.2, kind === 'cypress' ? 1.6 : 2.6, 6);
      trunk.translate(0, kind === 'cypress' ? 0.8 : 1.3, 0);
      let crown: THREE.BufferGeometry;
      if (kind === 'round') {
        const g = new THREE.IcosahedronGeometry(1.9, 1);
        const p = g.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < p.count; i++) {
          const k = 0.85 + rng() * 0.3;
          p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.9, p.getZ(i) * k);
        }
        g.computeVertexNormals();
        g.translate(0, 3.7, 0);
        crown = g;
      } else if (kind === 'cypress') {
        const g = new THREE.CylinderGeometry(0.05, 0.85, 6.5, 7, 3);
        g.translate(0, 4.5, 0);
        crown = g;
      } else {
        const g = new THREE.ConeGeometry(1.8, 5.2, 7, 2);
        g.translate(0, 4.6, 0);
        crown = g;
      }
        geos.set(kind, [trunk, crown]);
      }
      const [trunkG, crownG] = geos.get(kind)!;
      const tm = new THREE.InstancedMesh(trunkG, trunkMat, list.length);
      const cm = new THREE.InstancedMesh(crownG, leafMat, list.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const col = new THREE.Color();
      list.forEach((t, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rot);
        m.compose(new THREE.Vector3(t.x, t.y ?? 0, t.z), q, new THREE.Vector3(t.s, t.s, t.s));
        tm.setMatrixAt(i, m);
        cm.setMatrixAt(i, m);
        const base = kind === 'round' ? [0.3, 0.5, 0.2] : kind === 'cypress' ? [0.16, 0.32, 0.16] : [0.18, 0.36, 0.2];
        const v = 0.8 + rng() * 0.4;
        col.setRGB(base[0] * v * (0.9 + rng() * 0.25), base[1] * v, base[2] * v);
        cm.setColorAt(i, col);
      });
      tm.castShadow = true;
      cm.castShadow = true;
      cm.receiveShadow = true;
      tm.computeBoundingSphere();
      cm.computeBoundingSphere();
      this.group.add(detail(tm), detail(cm));
    }
  }

  private buildLamps(street: PropInst[], park: PropInst[]) {
    // Street lamp: pole + curved arm + head (arm toward local +z)
    const pb = new MeshBuilder();
    pb.setColor('#59636b');
    pb.cylinder(0, 0, 0, 7.6, 0.13, 0.08, 8, true);
    pb.orientedBox(0, 7.65, 0.9, 0.08, 0.08, 1.9, 0);
    pb.orientedBox(0, 7.55, 1.9, 0.32, 0.14, 0.7, 0);
    const poleGeo = pb.build();
    const headGeo = new THREE.BoxGeometry(0.26, 0.05, 0.6);
    headGeo.translate(0, 7.46, 1.95);
    const poleMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.5, roughness: 0.5 });
    const all = street;
    const poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, Math.max(1, all.length));
    const headMesh = new THREE.InstancedMesh(headGeo, this.materials.lampHead, Math.max(1, all.length));
    const poolGeo = new THREE.PlaneGeometry(13, 13);
    poolGeo.rotateX(-Math.PI / 2);
    const pools = new THREE.InstancedMesh(poolGeo, this.materials.lightPool, all.length + park.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    all.forEach((l, i) => {
      q.setFromAxisAngle(up, l.rot);
      m.compose(new THREE.Vector3(l.x, l.y ?? 0, l.z), q, new THREE.Vector3(1, 1, 1));
      poleMesh.setMatrixAt(i, m);
      headMesh.setMatrixAt(i, m);
      const px = l.x + Math.sin(l.rot) * 2.2;
      const pz = l.z + Math.cos(l.rot) * 2.2;
      pools.setMatrixAt(i, new THREE.Matrix4().makeTranslation(px, 0.03, pz));
    });
    poleMesh.count = all.length;
    headMesh.count = all.length;
    poleMesh.castShadow = true;
    this.group.add(poleMesh, headMesh);
    // Park lamps: short classic posts with globe
    const kb = new MeshBuilder();
    kb.setColor('#2e3439');
    kb.cylinder(0, 0, 0, 3.6, 0.09, 0.06, 8, true);
    const kGeo = kb.build();
    const globe = new THREE.SphereGeometry(0.26, 12, 8);
    globe.translate(0, 3.8, 0);
    const kMesh = new THREE.InstancedMesh(kGeo, poleMat, Math.max(1, park.length));
    const gMesh = new THREE.InstancedMesh(globe, this.materials.lampHead, Math.max(1, park.length));
    park.forEach((l, i) => {
      m.makeTranslation(l.x, l.y ?? 0, l.z);
      kMesh.setMatrixAt(i, m);
      gMesh.setMatrixAt(i, m);
      pools.setMatrixAt(all.length + i, new THREE.Matrix4().makeScale(0.6, 1, 0.6).setPosition(l.x, (l.y ?? 0) + 0.03, l.z));
      this.colliders.add({ kind: 'circle', x: l.x, z: l.z, r: 0.15, tag: 'pole' });
    });
    kMesh.count = park.length;
    gMesh.count = park.length;
    this.group.add(detail(kMesh), detail(gMesh), detail(pools));
    pools.frustumCulled = false;
    this.lampCount = all.length + park.length;
  }

  private buildSmallProps(ctx: BuildCtx) {
    // Benches
    if (ctx.benches.length) {
      const bb = new MeshBuilder();
      bb.setColor('#8a5a35');
      bb.orientedBox(0, 0.45, 0, 1.8, 0.08, 0.45, 0);
      bb.orientedBox(0, 0.8, -0.2, 1.8, 0.35, 0.06, 0);
      bb.setColor('#2d2f33');
      bb.orientedBox(-0.75, 0.22, 0, 0.08, 0.45, 0.4, 0);
      bb.orientedBox(0.75, 0.22, 0, 0.08, 0.45, 0.4, 0);
      const geo = bb.build();
      const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), ctx.benches.length);
      const m = new THREE.Matrix4();
      ctx.benches.forEach((p, i) => {
        m.compose(new THREE.Vector3(p.x, p.y ?? 0, p.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot), new THREE.Vector3(1, 1, 1));
        mesh.setMatrixAt(i, m);
        this.colliders.add({ kind: 'circle', x: p.x, z: p.z, r: 0.6, tag: 'bench' });
      });
      mesh.castShadow = true;
      this.group.add(detail(mesh));
    }
    // Traffic cones
    if (ctx.cones.length) {
      const cb = new MeshBuilder();
      cb.setColor('#ff6a13');
      cb.cylinder(0, 0, 0.05, 0.75, 0.2, 0.03, 12);
      cb.setColor('#f5f5f5');
      cb.cylinder(0, 0, 0.35, 0.5, 0.125, 0.1, 12, false);
      cb.setColor('#222222');
      cb.box(-0.26, 0.26, 0, 0.05, -0.26, 0.26);
      const mesh = new THREE.InstancedMesh(cb.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), ctx.cones.length);
      ctx.cones.forEach((p, i) => {
        mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, p.y ?? 0, p.z));
        this.colliders.add({ kind: 'circle', x: p.x, z: p.z, r: 0.25, tag: 'barrier' });
      });
      mesh.castShadow = true;
      this.group.add(detail(mesh));
    }
  }

  private buildFlags(spots: { x: number; z: number; h: number }[]) {
    if (!spots.length) return;
    const mat = new THREE.MeshStandardMaterial({ map: flagTexture(), side: THREE.DoubleSide, roughness: 0.8 });
    for (const s of spots) {
      const geo = new THREE.PlaneGeometry(3, 2, 12, 4);
      geo.translate(1.5, -1, 0);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(s.x, s.h, s.z);
      mesh.castShadow = true;
      this.group.add(detail(mesh));
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      this.flags.push({ mesh, base: Float32Array.from(pos.array as ArrayLike<number>) });
    }
  }

  private buildSignBoards(boards: BuildCtx['signBoards']) {
    for (const s of boards) {
      const t = textTexture(s.text, { w: Math.round(s.w * 48), h: Math.round(s.h * 48), bg: s.bg, fg: s.fg });
      const mat = new THREE.MeshStandardMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.05, roughness: 0.6 });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h), mat);
      mesh.position.set(s.x, s.y, s.z);
      mesh.rotation.y = s.rot;
      mesh.userData.signBoard = true;
      this.group.add(detail(mesh));
    }
  }

  private buildDecals() {
    // Painted words on the road: "OKUL" in school zones and "DUR" before stop lines.
    const words: { text: string; list: { x: number; z: number; h: number }[] }[] = [
      { text: 'OKUL', list: [] },
      { text: 'DUR', list: [] },
    ];
    const p = { x: 0, z: 0, h: 0 };
    for (const lane of this.net.lanes) {
      if (lane.edge.zoneLabel && lane.path.length > 50) {
        lane.path.sample(18, p);
        words[0].list.push({ ...p });
      }
      if (lane.endNode.control[lane.arm] === 'stop') {
        lane.path.sample(lane.stopS - 3.2, p);
        words[1].list.push({ ...p });
      }
    }
    for (const w of words) {
      if (!w.list.length) continue;
      const t = textTexture(w.text, { w: 256, h: 128, bg: 'rgba(0,0,0,0)', fg: '#f4f4f0', font: 'bold 96px Arial, sans-serif' });
      const mat = new THREE.MeshStandardMaterial({ map: t, transparent: true, depthWrite: false, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      const geo = new THREE.PlaneGeometry(2.2, 3.2);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.InstancedMesh(geo, mat, w.list.length);
      w.list.forEach((q, i) => {
        // text reads bottom→top for an approaching driver
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(q.x, 0.014, q.z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), q.h + Math.PI),
          new THREE.Vector3(1, 1, 1)
        );
        mesh.setMatrixAt(i, m);
      });
      mesh.receiveShadow = true;
      this.group.add(detail(mesh));
    }
  }

  // ————————————————————————————— runtime —————————————————————————————

  /** 0 = full day, 1 = full night. */
  setNight(f: number) {
    for (const m of this.materials.facades) m.emissiveIntensity = f * 0.9;
    this.materials.lampHead.emissiveIntensity = 0.2 + f * 9;
    this.materials.lightPool.opacity = f * 0.85;
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).userData?.signBoard) {
        const mm = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
        mm.emissiveIntensity = 0.05 + f * 0.6;
      }
    });
  }

  /** 0 = dry, 1 = soaking wet. */
  setWet(w: number) {
    const m = this.materials.asphalt;
    m.roughness = 0.92 - w * 0.62;
    m.metalness = w * 0.15;
    m.color.setScalar(1 - w * 0.35);
    this.materials.sidewalk.roughness = 0.85 - w * 0.4;
  }

  update(time: number) {
    for (const f of this.flags) {
      const pos = f.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        const x = f.base[i];
        arr[i + 2] = Math.sin(x * 1.8 - time * 5) * 0.14 * (x / 3);
      }
      pos.needsUpdate = true;
    }
  }

  get lampTotal() {
    return this.lampCount;
  }
}
