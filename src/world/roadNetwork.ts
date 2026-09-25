import { mulberry32, angleDiff, type Rng } from '../core/math';
import type { District, LineDef, MapDef, Rect, RoadClass, SpeedZone } from './mapDefs';
import { Path, bezierPath } from './path';

export const SIDEWALK_W = 3.2;
export const CURB_H = 0.16;

export type ClassSpec = {
  lanes: number;
  laneWidth: number;
  /** Width of the centre divider (for highways: barrier + inner shoulders). */
  median: number;
  medianRaised: boolean;
  /** Concrete barrier in the centre (highway). */
  barrier: boolean;
  parking: number;
  /** Emergency lane (paved shoulder) outside the travel lanes. */
  shoulder: number;
  limit: number;
  rank: number;
  label: string;
};

export const CLASS_SPEC: Record<RoadClass, ClassSpec> = {
  highway: { lanes: 3, laneWidth: 3.6, median: 3.0, medianRaised: false, barrier: true, parking: 0, shoulder: 3.0, limit: 110, rank: 5, label: 'Bölünmüş yol' },
  boulevard: { lanes: 2, laneWidth: 3.5, median: 3.2, medianRaised: true, barrier: false, parking: 0, shoulder: 0, limit: 70, rank: 4, label: 'Bulvar' },
  avenue: { lanes: 2, laneWidth: 3.4, median: 0.5, medianRaised: false, barrier: false, parking: 0, shoulder: 0, limit: 50, rank: 3, label: 'Cadde' },
  street: { lanes: 1, laneWidth: 3.4, median: 0.2, medianRaised: false, barrier: false, parking: 2.3, shoulder: 0, limit: 50, rank: 2, label: 'Cadde' },
  oneway: { lanes: 2, laneWidth: 3.3, median: 0, medianRaised: false, barrier: false, parking: 2.3, shoulder: 0, limit: 50, rank: 2, label: 'Tek yön' },
  residential: { lanes: 1, laneWidth: 3.1, median: 0.15, medianRaised: false, barrier: false, parking: 2.2, shoulder: 0, limit: 30, rank: 1, label: 'Sokak' },
};

export function halfWidthOf(cls: RoadClass): number {
  const s = CLASS_SPEC[cls];
  if (cls === 'oneway') return (s.lanes * s.laneWidth) / 2 + s.parking;
  return s.median / 2 + s.lanes * s.laneWidth + s.parking + s.shoulder;
}

/** Distance before a highway bend where its advisory limit starts. */
export const BEND_APPROACH = 180;

/** Barrier half-thickness inside a highway median. */
export const BARRIER_HALF = 0.45;

export type Dir4 = 'N' | 'S' | 'E' | 'W';
export const DIRS: Dir4[] = ['N', 'E', 'S', 'W'];
/** Unit vector pointing from a node out along each arm. */
export const ARM_VEC: Record<Dir4, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
export type Control = 'signal' | 'stop' | 'yield' | 'none';
export type SignalGroup = 'NS' | 'EW';
export type NodeKind = 'junction' | 'bend' | 'roundabout';

export type RoadNode = {
  id: number;
  x: number;
  z: number;
  /** Half extent of the junction box along x / z. */
  hx: number;
  hz: number;
  kind: NodeKind;
  /** Bend: centre-line radius. Roundabout: central island radius. */
  radius: number;
  /** Roundabout: radius of the circulating lane centre / outer paved edge. */
  ringR: number;
  ringOuter: number;
  /** Bend: inside corner (arc centre). */
  cx: number;
  cz: number;
  /** Advisory speed through the node (km/h), 0 = none. */
  limit: number;
  arms: Partial<Record<Dir4, RoadEdge>>;
  control: Partial<Record<Dir4, Control>>;
  crosswalk: Partial<Record<Dir4, boolean>>;
  signalized: boolean;
  nsLine: LineDef;
  ewLine: LineDef;
  armCount: number;
  /** Any arm is a highway (no pedestrians / sidewalks here). */
  highway: boolean;
  connectors: Connector[];
};

export type Lane = {
  id: number;
  edge: RoadEdge;
  dir: 1 | -1;
  /** 0 = curb (rightmost) lane. */
  index: number;
  /** Signed offset from the centerline along edge.right (a→b right vector). */
  lateral: number;
  width: number;
  path: Path;
  heading: number;
  startNode: RoadNode;
  endNode: RoadNode;
  /** Arc length where vehicles must stop (stop line). */
  stopS: number;
  /** Approach direction at the end node (which arm this lane arrives from). */
  arm: Dir4;
  limit: number;
  outs: Connector[];
  /** Arc length from which lane lines are solid before the junction (no lane changes). */
  solidFromS: number;
};

export type Turn = 'L' | 'R' | 'S';

export type Connector = {
  id: number;
  node: RoadNode;
  from: Lane;
  to: Lane;
  turn: Turn;
  path: Path;
  limit: number;
};

export type RoadEdge = {
  id: number;
  line: LineDef;
  axis: 'ns' | 'ew';
  cls: RoadClass;
  spec: ClassSpec;
  name: string;
  a: RoadNode;
  b: RoadNode;
  /** Road surface endpoints (junction box edges). */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  length: number;
  heading: number;
  dx: number;
  dz: number;
  rx: number;
  rz: number;
  cx: number;
  cz: number;
  halfWidth: number;
  oneway: 0 | 1 | -1;
  limit: number;
  lanesFwd: Lane[];
  lanesBwd: Lane[];
  /** Mid-block zebra crossings, arc length from x0/z0. */
  zebras: number[];
  zoneLabel: string | null;
};

export type SurfaceKind = 'road' | 'junction' | 'sidewalk' | 'median' | 'parking' | 'shoulder' | 'lot' | 'offroad';

export type RoadQuery = {
  kind: SurfaceKind;
  edge: RoadEdge | null;
  node: RoadNode | null;
  /** Along-edge distance from x0/z0 and lateral offset (along edge.right). */
  along: number;
  lateral: number;
  /** +1 if moving a→b on the edge, −1 otherwise. */
  travelDir: 1 | -1;
  /** Lane index under the car (0 = curb) or −1. */
  laneIndex: number;
  lane: Lane | null;
  wrongWay: boolean;
  limit: number;
  zoneLabel: string | null;
  zone: SpeedZone | null;
  headingError: number;
};

export type Block = {
  id: number;
  rect: Rect;
  cell: Rect;
  district: District;
  frontage: Record<Dir4, boolean>;
  cx: number;
  cz: number;
};

type AreaRef =
  | { t: 'edge'; e: RoadEdge; r: Rect }
  | { t: 'node'; n: RoadNode; r: Rect }
  | { t: 'side'; r: Rect }
  | { t: 'lot'; r: Rect };

const EPS = 0.01;

function rectOverlaps(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

function inRect(r: Rect, x: number, z: number, pad = 0): boolean {
  return x >= r.minX - pad && x <= r.maxX + pad && z >= r.minZ - pad && z <= r.maxZ + pad;
}

/** Subtract axis-aligned cut rects from a strip; returns remaining pieces. */
export function subtractRects(r: Rect, cuts: Rect[]): Rect[] {
  let pieces = [r];
  for (const c of cuts) {
    const next: Rect[] = [];
    for (const p of pieces) {
      if (!rectOverlaps(p, c)) {
        next.push(p);
        continue;
      }
      // Split into up to 4 remaining rects.
      if (c.minX > p.minX) next.push({ ...p, maxX: c.minX });
      if (c.maxX < p.maxX) next.push({ ...p, minX: c.maxX });
      const midMinX = Math.max(p.minX, c.minX);
      const midMaxX = Math.min(p.maxX, c.maxX);
      if (c.minZ > p.minZ) next.push({ minX: midMinX, maxX: midMaxX, minZ: p.minZ, maxZ: c.minZ });
      if (c.maxZ < p.maxZ) next.push({ minX: midMinX, maxX: midMaxX, minZ: c.maxZ, maxZ: p.maxZ });
    }
    pieces = next.filter((q) => q.maxX - q.minX > 0.05 && q.maxZ - q.minZ > 0.05);
  }
  return pieces;
}

/** Circular arc (x,z pairs) around (cx,cz) from angle a0 sweeping `sweep` radians. */
function arcPoints(cx: number, cz: number, r: number, a0: number, sweep: number, out: number[], stepRad = 0.07) {
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / stepRad));
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
  }
}

function quadBezier(out: number[], x0: number, z0: number, cx: number, cz: number, x1: number, z1: number, segs: number, skipFirst = false) {
  for (let i = skipFirst ? 1 : 0; i <= segs; i++) {
    const t = i / segs;
    const u = 1 - t;
    out.push(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * z0 + 2 * u * t * cz + t * t * z1);
  }
}

export class RoadNetwork {
  readonly map: MapDef;
  readonly nodes: RoadNode[] = [];
  readonly edges: RoadEdge[] = [];
  readonly lanes: Lane[] = [];
  readonly connectors: Connector[] = [];
  readonly blocks: Block[] = [];
  readonly sidewalks: Rect[] = [];
  readonly rng: Rng;
  private grid = new Map<number, AreaRef[]>();
  private readonly cellSize = 32;

  constructor(map: MapDef) {
    this.map = map;
    this.rng = mulberry32(map.seed);
    this.buildNodesAndEdges();
    this.assignControl();
    this.buildLanes();
    this.buildConnectors();
    this.buildSidewalks();
    this.buildBlocks();
    this.indexAreas();
  }

  // ————————————————————————————————— generation —————————————————————————————————

  private lineRange(line: LineDef, perpendicular: LineDef[]): [number, number] {
    const ps = perpendicular.map((l) => l.pos);
    return [line.from ?? Math.min(...ps), line.to ?? Math.max(...ps)];
  }

  private roadAt(line: LineDef, range: [number, number], c: number): boolean {
    if (c < range[0] - EPS || c > range[1] + EPS) return false;
    for (const [g0, g1] of line.gaps ?? []) if (c > g0 + EPS && c < g1 - EPS) return false;
    return true;
  }

  private buildNodesAndEdges() {
    const { ns, ew } = this.map;
    const nsRanges = ns.map((l) => this.lineRange(l, ew));
    const ewRanges = ew.map((l) => this.lineRange(l, ns));
    const nodeAt = new Map<string, RoadNode>();

    ns.forEach((L, i) => {
      ew.forEach((M, j) => {
        const x = L.pos;
        const z = M.pos;
        const lr = nsRanges[i];
        const mr = ewRanges[j];
        if (!this.roadAt(L, lr, z) || !this.roadAt(M, mr, x)) {
          // The crossing point may still be an endpoint touching (e.g. T-junction at a range end).
          if (!(z >= lr[0] - EPS && z <= lr[1] + EPS && x >= mr[0] - EPS && x <= mr[1] + EPS)) return;
        }
        const n = this.roadAt(L, lr, z - 1);
        const s = this.roadAt(L, lr, z + 1);
        const w = this.roadAt(M, mr, x - 1);
        const e = this.roadAt(M, mr, x + 1);
        if (!(n || s) || !(w || e)) return; // not a junction (pass-through or no contact)
        const armN = [n, s, w, e].filter(Boolean).length;
        let hx = halfWidthOf(L.cls);
        let hz = halfWidthOf(M.cls);
        let kind: NodeKind = 'junction';
        let radius = 0;
        let ringR = 0;
        let ringOuter = 0;
        let cx = x;
        let cz = z;
        let limit = 0;
        if (armN === 2 && L.cls === 'highway' && M.cls === 'highway') {
          kind = 'bend';
          radius = this.map.bendRadius ?? 200;
          hx = hz = radius;
          const v1 = ARM_VEC[n ? 'N' : 'S'];
          const v2 = ARM_VEC[w ? 'W' : 'E'];
          cx = x + radius * (v1[0] + v2[0]);
          cz = z + radius * (v1[1] + v2[1]);
          limit = 90;
        } else {
          const rb = this.map.roundabouts?.find((r) => Math.abs(r.x - x) < 1 && Math.abs(r.z - z) < 1);
          if (rb && armN >= 3) {
            kind = 'roundabout';
            radius = rb.island ?? 8;
            ringR = radius + 3.4;
            ringOuter = radius + 7.6;
            const H = Math.max(ringOuter + 1.2, hx + 2, hz + 2);
            hx = hz = H;
            limit = 30;
          }
        }
        const node: RoadNode = {
          id: this.nodes.length,
          x,
          z,
          hx,
          hz,
          kind,
          radius,
          ringR,
          ringOuter,
          cx,
          cz,
          limit,
          arms: {},
          control: {},
          crosswalk: {},
          signalized: false,
          nsLine: L,
          ewLine: M,
          armCount: 0,
          highway: L.cls === 'highway' || M.cls === 'highway',
          connectors: [],
        };
        this.nodes.push(node);
        nodeAt.set(`${i}:${j}`, node);
      });
    });

    // Edges along ns lines
    ns.forEach((L, i) => {
      const list = ew
        .map((_, j) => nodeAt.get(`${i}:${j}`))
        .filter((n): n is RoadNode => !!n)
        .sort((p, q) => p.z - q.z);
      for (let k = 0; k < list.length - 1; k++) {
        const A = list[k];
        const B = list[k + 1];
        if (!this.roadAt(L, nsRanges[i], (A.z + B.z) / 2)) continue;
        this.addEdge(L, 'ns', A, B);
      }
    });
    ew.forEach((M, j) => {
      const list = ns
        .map((_, i) => nodeAt.get(`${i}:${j}`))
        .filter((n): n is RoadNode => !!n)
        .sort((p, q) => p.x - q.x);
      for (let k = 0; k < list.length - 1; k++) {
        const A = list[k];
        const B = list[k + 1];
        if (!this.roadAt(M, ewRanges[j], (A.x + B.x) / 2)) continue;
        this.addEdge(M, 'ew', A, B);
      }
    });

    for (const n of this.nodes) {
      n.armCount = Object.keys(n.arms).length;
      // A crossing that only touches highway arms through a T is still a highway node
      n.highway = DIRS.some((d) => n.arms[d]?.cls === 'highway');
    }
  }

  private addEdge(line: LineDef, axis: 'ns' | 'ew', A: RoadNode, B: RoadNode) {
    const spec = CLASS_SPEC[line.cls];
    let x0: number, z0: number, x1: number, z1: number;
    if (axis === 'ns') {
      x0 = x1 = line.pos;
      z0 = A.z + A.hz;
      z1 = B.z - B.hz;
    } else {
      z0 = z1 = line.pos;
      x0 = A.x + A.hx;
      x1 = B.x - B.hx;
    }
    const length = Math.hypot(x1 - x0, z1 - z0);
    const dx = (x1 - x0) / length;
    const dz = (z1 - z0) / length;
    const edge: RoadEdge = {
      id: this.edges.length,
      line,
      axis,
      cls: line.cls,
      spec,
      name: line.name,
      a: A,
      b: B,
      x0,
      z0,
      x1,
      z1,
      length,
      heading: Math.atan2(dx, dz),
      dx,
      dz,
      rx: -dz,
      rz: dx,
      cx: (x0 + x1) / 2,
      cz: (z0 + z1) / 2,
      halfWidth: halfWidthOf(line.cls),
      oneway: line.oneway ?? 0,
      limit: line.limit ?? spec.limit,
      lanesFwd: [],
      lanesBwd: [],
      zebras: [],
      zoneLabel: null,
    };
    const zn = this.zoneAt(edge.cx, edge.cz, [edge.cls]);
    if (zn && zn.kind !== 'rural' && zn.kind !== 'approach') edge.zoneLabel = zn.label;
    this.edges.push(edge);
    if (axis === 'ns') {
      A.arms.S = edge;
      B.arms.N = edge;
    } else {
      A.arms.E = edge;
      B.arms.W = edge;
    }
  }

  // ————————————————————————————————— speed zones —————————————————————————————————

  /** The governing zone at a point for roads of the given classes (strictest wins). */
  zoneAt(x: number, z: number, classes: RoadClass[]): SpeedZone | null {
    let best: SpeedZone | null = null;
    let bestLimit = Infinity;
    for (const zn of this.map.zones) {
      if (!inRect(zn.rect, x, z)) continue;
      if (zn.classes && !classes.some((c) => zn.classes!.includes(c))) continue;
      const lim = zn.limit;
      if (lim < bestLimit) {
        best = zn;
        bestLimit = lim;
      }
    }
    return best;
  }

  /** Effective limit at a point given the road's base limit. */
  limitAt(x: number, z: number, base: number, cls: RoadClass): { limit: number; zone: SpeedZone | null } {
    const zn = this.zoneAt(x, z, [cls]);
    if (!zn) return { limit: base, zone: null };
    return { limit: zn.mode === 'set' ? zn.limit : Math.min(base, zn.limit), zone: zn };
  }

  private assignControl() {
    const rng = mulberry32(this.map.seed ^ 0x51f15e);
    for (const n of this.nodes) {
      const arms = DIRS.filter((d) => n.arms[d]);
      if (arms.length < 2) continue;
      if (n.kind === 'bend') {
        for (const d of arms) n.control[d] = 'none';
        continue;
      }
      if (n.kind === 'roundabout') {
        for (const d of arms) {
          n.control[d] = 'yield';
          n.crosswalk[d] = false;
        }
        continue;
      }
      const nsRank = CLASS_SPEC[n.nsLine.cls].rank;
      const ewRank = CLASS_SPEC[n.ewLine.cls].rank;
      const maxRank = Math.max(nsRank, ewRank);
      const isCorner = arms.length === 2;
      if (isCorner) {
        for (const d of arms) n.control[d] = 'none';
        continue;
      }
      const signal = maxRank >= 3 && arms.length >= 3 && Math.min(nsRank, ewRank) >= 1;
      if (signal) {
        n.signalized = true;
        for (const d of arms) {
          n.control[d] = 'signal';
          n.crosswalk[d] = !n.highway;
        }
        continue;
      }
      // Priority: higher-rank line; ties → ns line has priority.
      const nsMajor = nsRank >= ewRank;
      for (const d of arms) {
        const onNs = d === 'N' || d === 'S';
        const major = onNs === nsMajor;
        if (major) {
          n.control[d] = 'none';
        } else {
          const minorRank = onNs ? nsRank : ewRank;
          n.control[d] = minorRank <= 1 || rng() < 0.55 ? 'stop' : 'yield';
          n.crosswalk[d] = !n.highway;
        }
      }
    }
    // Mid-block zebra crossings on longer busy streets
    for (const e of this.edges) {
      if (e.cls === 'highway' || e.a.highway || e.b.highway) continue;
      const d = this.map.district(e.cx, e.cz);
      const busy = d === 'downtown' || d === 'commercial' || d === 'school' || d === 'plaza' || d === 'hospital';
      if (e.length > 80 && (busy || e.zoneLabel) && e.cls !== 'boulevard') {
        e.zebras.push(e.length / 2);
      } else if (e.length > 150 && e.length < 400 && e.cls !== 'boulevard' && rng() < 0.35) {
        e.zebras.push(e.length * (0.4 + rng() * 0.2));
      }
    }
  }

  private buildLanes() {
    for (const e of this.edges) {
      const s = e.spec;
      const make = (dir: 1 | -1) => {
        const list: Lane[] = [];
        const oneway = e.oneway !== 0;
        const outer = oneway ? (s.lanes * s.laneWidth) / 2 : s.median / 2 + s.lanes * s.laneWidth;
        for (let i = 0; i < s.lanes; i++) {
          const off = outer - (i + 0.5) * s.laneWidth;
          const lateral = dir * off;
          const ox = e.rx * lateral;
          const oz = e.rz * lateral;
          const sx = dir === 1 ? e.x0 : e.x1;
          const sz = dir === 1 ? e.z0 : e.z1;
          const tx = dir === 1 ? e.x1 : e.x0;
          const tz = dir === 1 ? e.z1 : e.z0;
          const path = new Path([sx + ox, sz + oz, tx + ox, tz + oz]);
          const endNode = dir === 1 ? e.b : e.a;
          const arm: Dir4 = e.axis === 'ns' ? (dir === 1 ? 'N' : 'S') : dir === 1 ? 'W' : 'E';
          const hasCross = !!endNode.crosswalk[arm];
          const junctionAhead = endNode.kind !== 'bend' && endNode.armCount >= 3;
          const solidLen = !junctionAhead ? 0 : e.cls === 'highway' ? 60 : 20;
          const lane: Lane = {
            id: this.lanes.length,
            edge: e,
            dir,
            index: i,
            lateral,
            width: s.laneWidth,
            path,
            heading: dir === 1 ? e.heading : e.heading + Math.PI,
            startNode: dir === 1 ? e.a : e.b,
            endNode,
            stopS: Math.max(1, path.length - (hasCross ? 4.4 : 1.4)),
            arm,
            limit: e.limit,
            outs: [],
            solidFromS: solidLen > 0 ? Math.max(0, path.length - solidLen) : Infinity,
          };
          this.lanes.push(lane);
          list.push(lane);
        }
        return list;
      };
      if (e.oneway === 0 || e.oneway === 1) e.lanesFwd = make(1);
      if (e.oneway === 0 || e.oneway === -1) e.lanesBwd = make(-1);
    }
  }

  /** Lanes arriving at node from arm d. */
  incomingLanes(n: RoadNode, d: Dir4): Lane[] {
    const e = n.arms[d];
    if (!e) return [];
    const toNodeIsB = e.b === n;
    return toNodeIsB ? e.lanesFwd : e.lanesBwd;
  }

  /** Lanes leaving node through arm d. */
  outgoingLanes(n: RoadNode, d: Dir4): Lane[] {
    const e = n.arms[d];
    if (!e) return [];
    return e.a === n ? e.lanesFwd : e.lanesBwd;
  }

  private addConnector(n: RoadNode, from: Lane, to: Lane, turn: Turn, path: Path, limit: number) {
    const conn: Connector = { id: this.connectors.length, node: n, from, to, turn, path, limit };
    from.outs.push(conn);
    n.connectors.push(conn);
    this.connectors.push(conn);
  }

  private buildConnectors() {
    const p0 = { x: 0, z: 0, h: 0 };
    const p2 = { x: 0, z: 0, h: 0 };
    for (const n of this.nodes) {
      if (n.kind === 'bend') {
        this.buildBendConnectors(n);
        continue;
      }
      for (const din of DIRS) {
        const ins = this.incomingLanes(n, din);
        if (!ins.length) continue;
        for (const dout of DIRS) {
          if (dout === din) continue; // no U-turns
          const outs = this.outgoingLanes(n, dout);
          if (!outs.length) continue;
          const hin = ins[0].heading;
          const hout = outs[0].heading;
          const dh = angleDiff(hout, hin);
          const turn: Turn = Math.abs(dh) < 0.3 ? 'S' : dh > 0 ? 'L' : 'R';
          const pairs: [Lane, Lane][] = [];
          if (turn === 'S') {
            for (const li of ins) pairs.push([li, outs[Math.min(li.index, outs.length - 1)]]);
          } else if (turn === 'R') {
            pairs.push([ins[0], outs[0]]);
          } else {
            pairs.push([ins[ins.length - 1], outs[outs.length - 1]]);
          }
          for (const [a, b] of pairs) {
            a.path.sample(a.path.length, p0);
            b.path.sample(0, p2);
            if (n.kind === 'roundabout') {
              this.addConnector(n, a, b, turn, this.roundaboutPath(n, p0.x, p0.z, a.heading, p2.x, p2.z, b.heading), 28);
              continue;
            }
            let cx = (p0.x + p2.x) / 2;
            let cz = (p0.z + p2.z) / 2;
            if (turn !== 'S') {
              // Intersection of the two lane lines.
              const d1x = Math.sin(a.heading);
              const d1z = Math.cos(a.heading);
              const d2x = Math.sin(b.heading);
              const d2z = Math.cos(b.heading);
              const den = d1x * d2z - d1z * d2x;
              if (Math.abs(den) > 1e-6) {
                const t = ((p2.x - p0.x) * d2z - (p2.z - p0.z) * d2x) / den;
                cx = p0.x + d1x * t;
                cz = p0.z + d1z * t;
              }
            }
            const limit = turn === 'S' ? Math.min(a.limit, b.limit) : turn === 'R' ? 22 : 28;
            this.addConnector(n, a, b, turn, bezierPath(p0.x, p0.z, cx, cz, p2.x, p2.z, turn === 'S' ? 2 : 12), limit);
          }
        }
      }
    }
  }

  /** Large-radius highway corner: every lane continues into the same lane index. */
  private buildBendConnectors(n: RoadNode) {
    const arms = DIRS.filter((d) => n.arms[d]);
    const p0 = { x: 0, z: 0, h: 0 };
    const p2 = { x: 0, z: 0, h: 0 };
    for (const din of arms) {
      const dout = arms.find((d) => d !== din)!;
      const ins = this.incomingLanes(n, din);
      const outs = this.outgoingLanes(n, dout);
      if (!ins.length || !outs.length) continue;
      for (const a of ins) {
        const b = outs[Math.min(a.index, outs.length - 1)];
        a.path.sample(a.path.length, p0);
        b.path.sample(0, p2);
        const r = Math.hypot(p0.x - n.cx, p0.z - n.cz);
        const a0 = Math.atan2(p0.z - n.cz, p0.x - n.cx);
        const a1 = Math.atan2(p2.z - n.cz, p2.x - n.cx);
        const sweep = angleDiff(a1, a0);
        const pts: number[] = [];
        arcPoints(n.cx, n.cz, r, a0, sweep, pts, 0.03);
        this.addConnector(n, a, b, 'S', new Path(pts), n.limit);
      }
    }
  }

  /** Entry curve → counter-clockwise circulation (island on the left) → exit curve. */
  private roundaboutPath(n: RoadNode, x0: number, z0: number, hIn: number, x3: number, z3: number, hOut: number): Path {
    const R = n.ringR;
    const aIn = Math.atan2(z0 - n.z, x0 - n.x);
    const aOut = Math.atan2(z3 - n.z, x3 - n.x);
    const delta = 0.5;
    const aE = aIn - delta; // travelling with the island on the left decreases the angle
    const aX = aOut + delta;
    let sweep = aE - aX;
    while (sweep <= 0.05) sweep += Math.PI * 2;
    while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
    const ex = n.x + Math.cos(aE) * R;
    const ez = n.z + Math.sin(aE) * R;
    const xx = n.x + Math.cos(aX) * R;
    const xz = n.z + Math.sin(aX) * R;
    const pts: number[] = [];
    const k1 = Math.hypot(ex - x0, ez - z0) * 0.55;
    quadBezier(pts, x0, z0, x0 + Math.sin(hIn) * k1, z0 + Math.cos(hIn) * k1, ex, ez, 8);
    const arc: number[] = [];
    arcPoints(n.x, n.z, R, aE, -sweep, arc, 0.09);
    for (let i = 2; i < arc.length; i += 2) pts.push(arc[i], arc[i + 1]);
    const k2 = Math.hypot(x3 - xx, z3 - xz) * 0.55;
    quadBezier(pts, xx, xz, x3 - Math.sin(hOut) * k2, z3 - Math.cos(hOut) * k2, x3, z3, 8, true);
    return new Path(pts);
  }

  private buildSidewalks() {
    const cuts = this.map.sidewalkCuts;
    const add = (r: Rect) => {
      for (const p of subtractRects(r, cuts)) this.sidewalks.push(p);
    };
    const W = SIDEWALK_W;
    for (const e of this.edges) {
      if (e.cls === 'highway') continue;
      const hw = e.halfWidth;
      if (e.axis === 'ns') {
        add({ minX: e.x0 - hw - W, maxX: e.x0 - hw, minZ: e.z0, maxZ: e.z1 });
        add({ minX: e.x0 + hw, maxX: e.x0 + hw + W, minZ: e.z0, maxZ: e.z1 });
      } else {
        add({ minX: e.x0, maxX: e.x1, minZ: e.z0 - hw - W, maxZ: e.z0 - hw });
        add({ minX: e.x0, maxX: e.x1, minZ: e.z0 + hw, maxZ: e.z0 + hw + W });
      }
    }
    for (const n of this.nodes) {
      if (n.highway || n.kind !== 'junction') continue;
      const { x, z, hx, hz } = n;
      // Corners
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const ax = x + sx * hx;
          const az = z + sz * hz;
          add({
            minX: Math.min(ax, ax + sx * W),
            maxX: Math.max(ax, ax + sx * W),
            minZ: Math.min(az, az + sz * W),
            maxZ: Math.max(az, az + sz * W),
          });
        }
      }
      // Sides without an arm → sidewalk runs across
      if (!n.arms.N) add({ minX: x - hx, maxX: x + hx, minZ: z - hz - W, maxZ: z - hz });
      if (!n.arms.S) add({ minX: x - hx, maxX: x + hx, minZ: z + hz, maxZ: z + hz + W });
      if (!n.arms.W) add({ minX: x - hx - W, maxX: x - hx, minZ: z - hz, maxZ: z + hz });
      if (!n.arms.E) add({ minX: x + hx, maxX: x + hx + W, minZ: z - hz, maxZ: z + hz });
    }
  }

  private edgeCovering(axis: 'ns' | 'ew', pos: number, mid: number): RoadEdge | null {
    for (const e of this.edges) {
      if (e.axis !== axis || Math.abs(e.line.pos - pos) > EPS) continue;
      if (axis === 'ns') {
        if (mid > e.a.z && mid < e.b.z) return e;
      } else if (mid > e.a.x && mid < e.b.x) return e;
    }
    return null;
  }

  private buildBlocks() {
    const ext = this.map.extent;
    const xs = [ext.minX, ...this.map.ns.map((l) => l.pos), ext.maxX].sort((a, b) => a - b);
    const zs = [ext.minZ, ...this.map.ew.map((l) => l.pos), ext.maxZ].sort((a, b) => a - b);
    // Big nodes (bends, roundabouts) cut into the neighbouring blocks
    const bigBoxes: Rect[] = this.nodes
      .filter((n) => n.kind !== 'junction')
      .map((n) => ({ minX: n.x - n.hx - SIDEWALK_W, maxX: n.x + n.hx + SIDEWALK_W, minZ: n.z - n.hz - SIDEWALK_W, maxZ: n.z + n.hz + SIDEWALK_W }));
    for (let i = 0; i < xs.length - 1; i++) {
      for (let j = 0; j < zs.length - 1; j++) {
        const cell: Rect = { minX: xs[i], maxX: xs[i + 1], minZ: zs[j], maxZ: zs[j + 1] };
        const cx = (cell.minX + cell.maxX) / 2;
        const cz = (cell.minZ + cell.maxZ) / 2;
        const west = this.edgeCovering('ns', cell.minX, cz);
        const east = this.edgeCovering('ns', cell.maxX, cz);
        const north = this.edgeCovering('ew', cell.minZ, cx);
        const south = this.edgeCovering('ew', cell.maxZ, cx);
        const inset = (e: RoadEdge | null) => (e ? e.halfWidth + (e.cls === 'highway' ? 6 : SIDEWALK_W) : 0);
        let rect: Rect = {
          minX: cell.minX + inset(west),
          maxX: cell.maxX - inset(east),
          minZ: cell.minZ + inset(north),
          maxZ: cell.maxZ - inset(south),
        };
        const cuts = bigBoxes.filter((b) => rectOverlaps(b, rect));
        if (cuts.length) {
          const pieces = subtractRects(rect, cuts);
          if (!pieces.length) continue;
          pieces.sort((p, q) => (q.maxX - q.minX) * (q.maxZ - q.minZ) - (p.maxX - p.minX) * (p.maxZ - p.minZ));
          rect = pieces[0];
        }
        const outside = i === 0 || j === 0 || i === xs.length - 2 || j === zs.length - 2;
        if (rect.maxX - rect.minX < 6 || rect.maxZ - rect.minZ < 6) continue;
        this.blocks.push({
          id: this.blocks.length,
          rect,
          cell,
          district: outside ? 'suburb' : this.map.district(cx, cz),
          frontage: { N: !!north, S: !!south, W: !!west, E: !!east },
          cx: (rect.minX + rect.maxX) / 2,
          cz: (rect.minZ + rect.maxZ) / 2,
        });
      }
    }
  }

  isOuterBlock(b: Block): boolean {
    const ext = this.map.extent;
    return b.cell.minX === ext.minX || b.cell.maxX === ext.maxX || b.cell.minZ === ext.minZ || b.cell.maxZ === ext.maxZ;
  }

  // ————————————————————————————————— spatial index —————————————————————————————————

  private key(ix: number, iz: number) {
    return (ix + 4096) * 8192 + (iz + 4096);
  }

  private insert(ref: AreaRef) {
    const r = ref.r;
    const cs = this.cellSize;
    for (let ix = Math.floor(r.minX / cs); ix <= Math.floor(r.maxX / cs); ix++) {
      for (let iz = Math.floor(r.minZ / cs); iz <= Math.floor(r.maxZ / cs); iz++) {
        const k = this.key(ix, iz);
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(ref);
      }
    }
  }

  private indexAreas() {
    for (const n of this.nodes) {
      this.insert({ t: 'node', n, r: { minX: n.x - n.hx, maxX: n.x + n.hx, minZ: n.z - n.hz, maxZ: n.z + n.hz } });
    }
    for (const e of this.edges) {
      const hw = e.halfWidth;
      const r: Rect =
        e.axis === 'ns'
          ? { minX: e.x0 - hw, maxX: e.x0 + hw, minZ: e.z0, maxZ: e.z1 }
          : { minX: e.x0, maxX: e.x1, minZ: e.z0 - hw, maxZ: e.z0 + hw };
      this.insert({ t: 'edge', e, r });
    }
    for (const s of this.sidewalks) this.insert({ t: 'side', r: s });
    for (const d of this.map.drivableAreas) this.insert({ t: 'lot', r: d });
  }

  private candidates(x: number, z: number): AreaRef[] {
    return this.grid.get(this.key(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize))) ?? [];
  }

  /** Surface + lane information at a world position for a vehicle with the given heading. */
  query(x: number, z: number, heading: number): RoadQuery {
    const q: RoadQuery = {
      kind: 'offroad',
      edge: null,
      node: null,
      along: 0,
      lateral: 0,
      travelDir: 1,
      laneIndex: -1,
      lane: null,
      wrongWay: false,
      limit: 50,
      zoneLabel: null,
      zone: null,
      headingError: 0,
    };
    const cands = this.candidates(x, z);
    let isLot = false;
    let isSide = false;
    for (const c of cands) {
      if (!inRect(c.r, x, z)) continue;
      if (c.t === 'node') {
        const n = c.n;
        q.node = n;
        // Base: the limit of the fastest arm (then capped by zones / the node's own advisory limit)
        let lim = 0;
        for (const d of DIRS) if (n.arms[d]) lim = Math.max(lim, n.arms[d]!.limit);
        if (n.kind === 'bend') {
          this.fillBendQuery(q, n, x, z, heading);
        } else if (n.kind === 'roundabout') {
          this.fillRoundaboutQuery(q, n, x, z, heading);
        } else {
          // direction checks are skipped inside junctions
          q.kind = 'junction';
        }
        q.limit = lim || 50;
        const classes = DIRS.filter((d) => n.arms[d]).map((d) => n.arms[d]!.cls);
        const zn = this.zoneAt(x, z, classes);
        if (zn) {
          q.zone = zn;
          q.zoneLabel = zn.label;
          q.limit = zn.mode === 'set' ? zn.limit : Math.min(q.limit, zn.limit);
        }
        if (n.limit) q.limit = Math.min(q.limit, n.limit);
        return q;
      }
      if (c.t === 'edge') {
        this.fillEdgeQuery(q, c.e, x, z, heading);
        const lim = this.limitAt(x, z, c.e.limit, c.e.cls);
        q.limit = lim.limit;
        // advisory limit ahead of a highway bend
        const endNode = q.travelDir === 1 ? c.e.b : c.e.a;
        const rem = q.travelDir === 1 ? c.e.length - q.along : q.along;
        if (endNode.kind === 'bend' && rem < BEND_APPROACH) q.limit = Math.min(q.limit, endNode.limit);
        q.zone = lim.zone;
        q.zoneLabel = lim.zone?.label ?? null;
        return q;
      }
      if (c.t === 'lot') isLot = true;
      if (c.t === 'side') isSide = true;
    }
    if (isLot) q.kind = 'lot';
    else if (isSide) q.kind = 'sidewalk';
    q.limit = 30;
    return q;
  }

  private fillEdgeQuery(q: RoadQuery, e: RoadEdge, x: number, z: number, heading: number) {
    q.edge = e;
    q.limit = e.limit;
    q.along = (x - e.x0) * e.dx + (z - e.z0) * e.dz;
    q.lateral = (x - e.x0) * e.rx + (z - e.z0) * e.rz;
    const fwd = Math.cos(angleDiff(heading, e.heading));
    q.travelDir = fwd >= 0 ? 1 : -1;
    const s = e.spec;
    const off = q.lateral * q.travelDir;
    const travelHeading = q.travelDir === 1 ? e.heading : e.heading + Math.PI;
    q.headingError = angleDiff(heading, travelHeading);
    if (e.oneway !== 0) {
      const outer = (s.lanes * s.laneWidth) / 2;
      q.wrongWay = q.travelDir !== e.oneway && Math.abs(fwd) > 0.35;
      if (Math.abs(q.lateral) > outer) {
        q.kind = 'parking';
      } else {
        q.kind = 'road';
        // lanes indexed from the curb of the legal direction
        const legalOff = q.lateral * e.oneway;
        q.laneIndex = Math.min(s.lanes - 1, Math.max(0, Math.floor((outer - legalOff) / s.laneWidth)));
        const list = e.oneway === 1 ? e.lanesFwd : e.lanesBwd;
        q.lane = list[q.laneIndex] ?? null;
      }
      return;
    }
    const half = s.median / 2;
    const outer = half + s.lanes * s.laneWidth;
    const al = Math.abs(q.lateral);
    if (s.barrier && al < BARRIER_HALF) {
      q.kind = 'median';
      return;
    }
    if (al < half && s.medianRaised) {
      q.kind = 'median';
      return;
    }
    if (s.barrier && al < half) {
      q.kind = 'shoulder';
      q.wrongWay = off < 0 && Math.abs(fwd) > 0.35;
      return;
    }
    if (al > outer) {
      q.kind = s.shoulder > 0 ? 'shoulder' : 'parking';
      q.wrongWay = off < 0 && Math.abs(fwd) > 0.35;
      return;
    }
    q.kind = 'road';
    // On the opposite half of a two-way road while moving along it → wrong way.
    q.wrongWay = off < -0.25 && Math.abs(fwd) > 0.35;
    q.laneIndex = Math.min(s.lanes - 1, Math.max(0, Math.floor((outer - al) / s.laneWidth)));
    const list = q.lateral >= 0 ? e.lanesFwd : e.lanesBwd;
    q.lane = list[q.laneIndex] ?? null;
  }

  /** Surface inside a highway bend box: road ring around the inside corner, grass elsewhere. */
  private fillBendQuery(q: RoadQuery, n: RoadNode, x: number, z: number, heading: number) {
    const arms = DIRS.filter((d) => n.arms[d]);
    const dx = x - n.cx;
    const dz = z - n.cz;
    // inside the swept quadrant?
    for (const d of arms) {
      const v = ARM_VEC[d];
      if (dx * -v[0] + dz * -v[1] < -0.5) {
        q.kind = 'offroad';
        return;
      }
    }
    const e = n.arms[arms[0]]!;
    const s = e.spec;
    const off = Math.hypot(dx, dz) - n.radius;
    const al = Math.abs(off);
    const half = s.median / 2;
    const outer = half + s.lanes * s.laneWidth;
    q.lateral = off;
    // travel direction from the nearest connector
    let best: Connector | null = null;
    let bestD = Infinity;
    let bestS = 0;
    for (const c of n.connectors) {
      const p = c.path.project(x, z);
      if (p.dist < bestD) {
        bestD = p.dist;
        best = c;
        bestS = p.s;
      }
    }
    if (best) {
      const tmp = { x: 0, z: 0, h: 0 };
      best.path.sample(bestS, tmp);
      q.headingError = angleDiff(heading, tmp.h);
      q.wrongWay = Math.abs(q.headingError) > 2.0;
      q.travelDir = best.from.dir;
    }
    if (al < BARRIER_HALF) q.kind = 'median';
    else if (al < half) q.kind = 'shoulder';
    else if (al < outer) {
      q.kind = 'junction';
      if (best && bestD < s.laneWidth / 2 + 0.3) {
        q.laneIndex = best.from.index;
      }
    } else if (al < outer + s.shoulder) q.kind = 'shoulder';
    else q.kind = 'offroad';
  }

  /** Roundabout box: island (raised), circulating carriageway, arm throats, paved corners. */
  private fillRoundaboutQuery(q: RoadQuery, n: RoadNode, x: number, z: number, heading: number) {
    const dx = x - n.x;
    const dz = z - n.z;
    const d = Math.hypot(dx, dz);
    if (d < n.radius) {
      q.kind = 'median';
      return;
    }
    let paved = d <= n.ringOuter;
    if (!paved) {
      for (const dir of DIRS) {
        const e = n.arms[dir];
        if (!e) continue;
        const v = ARM_VEC[dir];
        const along = dx * v[0] + dz * v[1];
        const lat = Math.abs(-dx * v[1] + dz * v[0]);
        if (along > 0 && lat <= e.halfWidth) {
          paved = true;
          break;
        }
      }
    }
    if (!paved) {
      q.kind = 'sidewalk';
      return;
    }
    q.kind = 'junction';
    if (d < n.ringOuter + 0.5 && d > n.radius) {
      // circulating direction: island on the driver's left (angle decreasing)
      const a = Math.atan2(dz, dx);
      const th = Math.atan2(Math.sin(a), -Math.cos(a));
      q.headingError = angleDiff(heading, th);
      q.wrongWay = d < n.ringR + 2.5 && Math.abs(q.headingError) > 2.2;
    }
  }

  /** Nearest lane to a point, preferring lanes aligned with `heading` (if given). */
  nearestLane(x: number, z: number, heading?: number, maxDist = 60): { lane: Lane; s: number; dist: number } | null {
    let best: { lane: Lane; s: number; dist: number } | null = null;
    let bestScore = Infinity;
    for (const l of this.lanes) {
      const e = l.edge;
      // quick reject
      if (Math.abs(x - e.cx) > e.length / 2 + maxDist + e.halfWidth) continue;
      if (Math.abs(z - e.cz) > e.length / 2 + maxDist + e.halfWidth) continue;
      const p = l.path.project(x, z);
      if (p.dist > maxDist) continue;
      let score = p.dist;
      if (heading !== undefined) score += Math.abs(angleDiff(heading, l.heading)) * 6;
      if (score < bestScore) {
        bestScore = score;
        best = { lane: l, s: p.s, dist: p.dist };
      }
    }
    return best;
  }

  nearestNode(x: number, z: number): RoadNode {
    let best = this.nodes[0];
    let bd = Infinity;
    for (const n of this.nodes) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  armOf(n: RoadNode, e: RoadEdge): Dir4 | null {
    for (const d of DIRS) if (n.arms[d] === e) return d;
    return null;
  }

  isSidewalk(x: number, z: number): boolean {
    for (const c of this.candidates(x, z)) if (c.t === 'side' && inRect(c.r, x, z)) return true;
    return false;
  }

  /** Speed limit for a vehicle on lane / connector at a position (zones included). */
  vehicleLimit(x: number, z: number, lane: Lane | null, conn: Connector | null, s = 0): number {
    if (lane && lane.endNode.kind === 'bend' && lane.path.length - s < BEND_APPROACH) {
      return Math.min(lane.endNode.limit, this.limitAt(x, z, lane.limit, lane.edge.cls).limit);
    }
    if (conn) {
      const base = conn.limit;
      const zn = this.zoneAt(x, z, [conn.from.edge.cls]);
      if (!zn) return base;
      if (zn.mode === 'set') return conn.turn === 'S' && conn.node.kind === 'junction' ? zn.limit : Math.min(base, zn.limit);
      return Math.min(base, zn.limit);
    }
    if (!lane) return 50;
    return this.limitAt(x, z, lane.limit, lane.edge.cls).limit;
  }
}
