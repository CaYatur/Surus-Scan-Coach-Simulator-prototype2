import * as THREE from 'three';
import { mulberry32, pick, type Rng } from '../core/math';
import { SIDEWALK_W, CURB_H, type RoadNetwork, type RoadNode, type Dir4, type RoadEdge } from '../world/roadNetwork';
import type { SignalController } from './signals';
import type { AICar, PlayerInfo } from './aiTraffic';

type PNode = { id: number; x: number; z: number; links: PLink[] };
type PLink = {
  to: PNode;
  crossing: null | { node: RoadNode | null; arm: Dir4 | null; edge: RoadEdge };
};

export type Pedestrian = {
  id: number;
  group: THREE.Group;
  legs: THREE.Object3D[];
  arms: THREE.Object3D[];
  from: PNode;
  link: PLink;
  t: number;
  len: number;
  speed: number;
  phase: number;
  waiting: number;
  crossing: boolean;
  x: number;
  z: number;
  down: boolean;
  jaywalk: null | { x0: number; z0: number; x1: number; z1: number };
  child: boolean;
};

const SKIN = ['#f1c9a5', '#e0ac85', '#c68a62', '#8d5a3b', '#f5d6bd'];
const SHIRT = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#f39c12', '#34495e', '#ecf0f1', '#d35400', '#16a085', '#7f8c8d', '#e84393'];
const PANTS = ['#2c3e50', '#34495e', '#1f2a36', '#5d4037', '#3b3b3b', '#607d8b'];
const HAIR = ['#2b1d14', '#4a3222', '#101010', '#8a6a3a', '#b0b0b0'];

/** Pedestrians walking a sidewalk graph and crossing at crosswalks (signals / gaps). */
export class Pedestrians {
  readonly group = new THREE.Group();
  readonly peds: Pedestrian[] = [];
  private nodes: PNode[] = [];
  private rng: Rng;
  private net: RoadNetwork;
  private signals: SignalController;
  target = 24;
  radius = 150;
  private nextId = 1;
  private geo: { leg: THREE.BufferGeometry; torso: THREE.BufferGeometry; head: THREE.BufferGeometry; arm: THREE.BufferGeometry; hair: THREE.BufferGeometry };
  private matCache = new Map<string, THREE.MeshStandardMaterial>();
  detailLayer = 0;
  schoolZone: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;

  constructor(net: RoadNetwork, signals: SignalController, seed = 5) {
    this.net = net;
    this.signals = signals;
    this.rng = mulberry32(seed);
    this.geo = {
      leg: new THREE.BoxGeometry(0.13, 0.8, 0.15).translate(0, -0.4, 0),
      torso: new THREE.BoxGeometry(0.4, 0.62, 0.22),
      head: new THREE.SphereGeometry(0.12, 10, 8),
      arm: new THREE.BoxGeometry(0.09, 0.6, 0.1).translate(0, -0.3, 0),
      hair: new THREE.SphereGeometry(0.128, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
    };
    this.buildGraph();
    const zone = net.map.zones.find((z) => z.kind === 'school');
    if (zone) this.schoolZone = zone.rect;
  }

  private mat(c: string) {
    let m = this.matCache.get(c);
    if (!m) this.matCache.set(c, (m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 })));
    return m;
  }

  private buildGraph() {
    const W = SIDEWALK_W / 2;
    const corners = new Map<string, PNode>();
    const mk = (x: number, z: number) => {
      const n: PNode = { id: this.nodes.length, x, z, links: [] };
      this.nodes.push(n);
      return n;
    };
    const corner = (n: RoadNode, sx: number, sz: number) => {
      const k = `${n.id}:${sx}:${sz}`;
      let c = corners.get(k);
      // roundabout corners are paved islands inside the node box
      const inset = n.kind === 'roundabout' ? -2 : W;
      if (!c) corners.set(k, (c = mk(n.x + sx * (n.hx + inset), n.z + sz * (n.hz + inset))));
      return c;
    };
    const link = (a: PNode, b: PNode, crossing: PLink['crossing'] = null) => {
      a.links.push({ to: b, crossing });
      b.links.push({ to: a, crossing });
    };
    // At roundabouts the edge sidewalks end at "gates" that lead onto the paved corner islands.
    const endPt = (n: RoadNode, sx: number, sz: number, e: RoadEdge) => {
      if (n.kind !== 'roundabout') return corner(n, sx, sz);
      const g =
        e.axis === 'ns'
          ? mk(n.x + sx * (e.halfWidth + W), n.z + sz * (n.hz + 0.6))
          : mk(n.x + sx * (n.hx + 0.6), n.z + sz * (e.halfWidth + W));
      link(g, corner(n, sx, sz));
      return g;
    };
    for (const e of this.net.edges) {
      // no footpaths along / at the ring road and its bends
      if (e.cls === 'highway' || e.a.highway || e.b.highway || e.a.kind === 'bend' || e.b.kind === 'bend') continue;
      // two sidewalks, split by mid-block zebras
      const sides: [PNode, PNode][] =
        e.axis === 'ns'
          ? [
              [endPt(e.a, 1, 1, e), endPt(e.b, 1, -1, e)],
              [endPt(e.a, -1, 1, e), endPt(e.b, -1, -1, e)],
            ]
          : [
              [endPt(e.a, 1, -1, e), endPt(e.b, -1, -1, e)],
              [endPt(e.a, 1, 1, e), endPt(e.b, -1, 1, e)],
            ];
      if (!e.zebras.length) {
        for (const [a, b] of sides) link(a, b);
        continue;
      }
      const zs = [...e.zebras].sort((p, q) => p - q);
      const chains = sides.map(([a, b], si) => {
        const pts: PNode[] = [a];
        for (const s of zs) {
          // side 0 is the −lateral side (east of ns edges, north of ew edges)
          const lat = (si === 0 ? -1 : 1) * (e.halfWidth + W);
          const x = e.x0 + e.dx * s + e.rx * lat;
          const z = e.z0 + e.dz * s + e.rz * lat;
          pts.push(mk(x, z));
        }
        pts.push(b);
        for (let i = 0; i < pts.length - 1; i++) link(pts[i], pts[i + 1]);
        return pts;
      });
      for (let i = 0; i < zs.length; i++) link(chains[0][i + 1], chains[1][i + 1], { node: null, arm: null, edge: e });
    }
    for (const n of this.net.nodes) {
      if (n.highway || n.kind === 'bend') continue;
      const NE = corner(n, 1, -1);
      const NW = corner(n, -1, -1);
      const SE = corner(n, 1, 1);
      const SW = corner(n, -1, 1);
      const across: [Dir4, PNode, PNode][] = [
        ['N', NW, NE],
        ['S', SW, SE],
        ['E', NE, SE],
        ['W', NW, SW],
      ];
      for (const [d, a, b] of across) {
        const e = n.arms[d];
        if (!e) link(a, b); // sidewalk continues across the missing arm
        else if (n.crosswalk[d]) link(a, b, { node: n, arm: d, edge: e });
      }
    }
    // Drop isolated nodes
    this.nodes = this.nodes.filter((n) => n.links.length > 0);
  }

  private makeBody(child: boolean): { group: THREE.Group; legs: THREE.Object3D[]; arms: THREE.Object3D[] } {
    const g = new THREE.Group();
    const r = this.rng;
    const skin = this.mat(pick(r, SKIN));
    const shirt = this.mat(pick(r, SHIRT));
    const pants = this.mat(pick(r, PANTS));
    const hair = this.mat(pick(r, HAIR));
    const legs: THREE.Object3D[] = [];
    const arms: THREE.Object3D[] = [];
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(this.geo.leg, pants);
      leg.position.set(sx * 0.1, 0.82, 0);
      g.add(leg);
      legs.push(leg);
      const arm = new THREE.Mesh(this.geo.arm, shirt);
      arm.position.set(sx * 0.26, 1.4, 0);
      g.add(arm);
      arms.push(arm);
    }
    const torso = new THREE.Mesh(this.geo.torso, shirt);
    torso.position.y = 1.13;
    const head = new THREE.Mesh(this.geo.head, skin);
    head.position.y = 1.6;
    const h = new THREE.Mesh(this.geo.hair, hair);
    h.position.y = 1.62;
    g.add(torso, head, h);
    if (child) {
      // school backpack
      const bag = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.35, 0.14), this.mat(pick(r, ['#e53935', '#1e88e5', '#fdd835', '#43a047'])));
      bag.position.set(0, 1.18, -0.18);
      g.add(bag);
      g.scale.setScalar(0.68);
    } else g.scale.setScalar(0.92 + r() * 0.16);
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
    return { group: g, legs, arms };
  }

  private spawnAt(from: PNode, link: PLink, t: number): Pedestrian {
    const child = !!this.schoolZone && from.x > this.schoolZone.minX - 40 && from.x < this.schoolZone.maxX + 40 && from.z > this.schoolZone.minZ - 40 && from.z < this.schoolZone.maxZ + 40 && this.rng() < 0.6;
    const body = this.makeBody(child);
    const len = Math.hypot(link.to.x - from.x, link.to.z - from.z);
    const p: Pedestrian = {
      id: this.nextId++,
      ...body,
      from,
      link,
      t: t * len,
      len,
      speed: (child ? 1.1 : 1.2) + this.rng() * 0.45,
      phase: this.rng() * 6,
      waiting: 0,
      crossing: false,
      x: from.x,
      z: from.z,
      down: false,
      jaywalk: null,
      child,
    };
    p.group.traverse((o) => o.layers.set(this.detailLayer));
    this.group.add(p.group);
    this.peds.push(p);
    return p;
  }

  populate(px: number, pz: number, initial = false) {
    let tries = 0;
    while (this.peds.length < this.target && tries++ < (initial ? 400 : 20)) {
      const n = this.nodes[Math.floor(this.rng() * this.nodes.length)];
      const d = Math.hypot(n.x - px, n.z - pz);
      if (d > this.radius || d < (initial ? 12 : 70)) continue;
      const walk = n.links.filter((l) => !l.crossing);
      if (!walk.length) continue;
      this.spawnAt(n, pick(this.rng, walk), this.rng());
    }
  }

  clear() {
    for (const p of this.peds) this.group.remove(p.group);
    this.peds.length = 0;
  }

  /** Spawn a pedestrian who suddenly crosses the road ahead of the player. */
  spawnJaywalker(player: PlayerInfo, dist: number): Pedestrian | null {
    const near = this.net.nearestLane(player.x, player.z, player.heading, 6);
    if (!near) return null;
    const lane = near.lane;
    const s = near.s + dist;
    if (s > lane.path.length - 8) return null;
    const p = { x: 0, z: 0, h: 0 };
    lane.path.sample(s, p);
    const rx = -Math.cos(p.h);
    const rz = Math.sin(p.h);
    const e = lane.edge;
    // start from the kerb on the driver's right, walk to the other side
    const off = e.halfWidth + 0.8 - Math.abs(lane.lateral) + 0.2;
    const x0 = p.x + rx * off;
    const z0 = p.z + rz * off;
    const width = e.halfWidth * 2 + 1.6;
    const x1 = x0 - rx * width;
    const z1 = z0 - rz * width;
    const any = this.nodes[0];
    const ped = this.spawnAt(any, any.links[0], 0);
    ped.jaywalk = { x0, z0, x1, z1 };
    ped.len = width;
    ped.t = 0;
    ped.speed = 2.1;
    ped.crossing = true;
    ped.x = x0;
    ped.z = z0;
    return ped;
  }

  private roadClear(ax: number, az: number, bx: number, bz: number, cars: AICar[], player: PlayerInfo): boolean {
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    const check = (x: number, z: number, v: number, h: number) => {
      const dx = mx - x;
      const dz = mz - z;
      const d = Math.hypot(dx, dz);
      if (d < 7) return false;
      const closing = (dx * Math.sin(h) + dz * Math.cos(h)) / (d || 1);
      if (closing < 0.5) return true;
      return d > v * 4 + 9;
    };
    for (const c of cars) if (!check(c.x, c.z, c.v, c.heading)) return false;
    return check(player.x, player.z, Math.abs(player.speed), player.speed >= 0 ? player.heading : player.heading + Math.PI);
  }

  update(dt: number, player: PlayerInfo, cars: AICar[]) {
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      if (Math.hypot(p.x - player.x, p.z - player.z) > this.radius + 30 && !p.crossing) {
        this.group.remove(p.group);
        this.peds.splice(i, 1);
      }
    }
    this.populate(player.x, player.z);
    const fx = Math.sin(player.heading);
    const fz = Math.cos(player.heading);
    for (const p of this.peds) {
      if (p.down) continue;
      let moving = true;
      if (p.jaywalk) {
        p.t += p.speed * dt;
        const k = Math.min(1, p.t / p.len);
        p.x = p.jaywalk.x0 + (p.jaywalk.x1 - p.jaywalk.x0) * k;
        p.z = p.jaywalk.z0 + (p.jaywalk.z1 - p.jaywalk.z0) * k;
        p.group.rotation.y = Math.atan2(p.jaywalk.x1 - p.jaywalk.x0, p.jaywalk.z1 - p.jaywalk.z0);
        if (k >= 1) {
          p.crossing = false;
          p.jaywalk = null;
          // continue as a normal walker from the nearest node
          let best = this.nodes[0];
          let bd = Infinity;
          for (const n of this.nodes) {
            const d = Math.hypot(n.x - p.x, n.z - p.z);
            if (d < bd) {
              bd = d;
              best = n;
            }
          }
          p.from = best;
          p.link = best.links.find((l) => !l.crossing) ?? best.links[0];
          p.len = Math.hypot(p.link.to.x - best.x, p.link.to.z - best.z);
          p.t = 0;
          p.speed = 1.3;
        }
      } else {
        const L = p.link;
        // waiting at the kerb before a crossing
        if (L.crossing && p.t === 0 && !p.crossing) {
          let ok: boolean;
          if (L.crossing.node && L.crossing.node.signalized && L.crossing.arm) {
            ok = this.signals.pedestrianWalk(L.crossing.node, L.crossing.arm);
          } else {
            ok = this.roadClear(p.from.x, p.from.z, L.to.x, L.to.z, cars, player);
          }
          if (ok || p.waiting > 45) {
            p.crossing = true;
            p.waiting = 0;
          } else {
            p.waiting += dt;
            moving = false;
          }
        }
        if (moving) {
          // do not walk into the player's car
          const dx = p.x - player.x;
          const dz = p.z - player.z;
          const along = dx * fx + dz * fz;
          const lat = -dx * fz + dz * fx;
          if (Math.abs(along) < 3.2 && Math.abs(lat) < 1.9 && p.crossing) moving = false;
        }
        if (moving) {
          p.t += p.speed * (p.crossing ? 1.25 : 1) * dt;
          if (p.t >= p.len) {
            // arrived
            const at = L.to;
            p.crossing = false;
            const options = at.links.filter((l) => l.to !== p.from);
            const next = options.length ? pick(this.rng, options) : at.links[0];
            p.from = at;
            p.link = next;
            p.len = Math.hypot(next.to.x - at.x, next.to.z - at.z) || 0.01;
            p.t = 0;
          }
        }
        const k = p.len > 0 ? Math.min(1, p.t / p.len) : 0;
        p.x = p.from.x + (p.link.to.x - p.from.x) * k;
        p.z = p.from.z + (p.link.to.z - p.from.z) * k;
        p.group.rotation.y = Math.atan2(p.link.to.x - p.from.x, p.link.to.z - p.from.z);
      }
      const onRoad = p.crossing;
      p.group.position.set(p.x, onRoad ? 0 : CURB_H, p.z);
      if (moving) p.phase += dt * p.speed * 5.2;
      const sw = moving ? Math.sin(p.phase) * 0.55 : 0;
      p.legs[0].rotation.x = sw;
      p.legs[1].rotation.x = -sw;
      p.arms[0].rotation.x = -sw * 0.8;
      p.arms[1].rotation.x = sw * 0.8;
    }
  }

  /** Pedestrians currently on the carriageway (obstacles for vehicles, yield checks for the coach). */
  onRoad(): Pedestrian[] {
    return this.peds.filter((p) => p.crossing && !p.down);
  }

  knockDown(p: Pedestrian, heading: number) {
    p.down = true;
    p.crossing = false;
    p.group.rotation.set(-Math.PI / 2, heading, 0);
    p.group.position.y = 0.15;
  }
}
