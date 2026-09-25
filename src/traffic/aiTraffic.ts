import * as THREE from 'three';
import { approach, clamp, mulberry32, pick, angleDiff, randRange, type Rng } from '../core/math';
import { PALETTE, randomCarType, vehicleFootprint, TIR_RIG, type CarType, type TrafficContext } from '../vehicle/carModels';
import type { CityWorld, ParkingSlot } from '../world/cityBuilder';
import type { Connector, Lane, RoadNetwork, RoadNode } from '../world/roadNetwork';
import type { Path } from '../world/path';
import type { SignalController } from './signals';
import { VehicleRenderer, type VehicleVisual } from './vehicleRenderer';

export type PlayerInfo = { x: number; z: number; heading: number; speed: number; length: number; width: number };

export type AICar = {
  id: number;
  type: CarType;
  color: THREE.Color;
  length: number;
  width: number;
  lane: Lane | null;
  conn: Connector | null;
  path: Path;
  s: number;
  v: number;
  a: number;
  next: Connector | null;
  v0Factor: number;
  T: number;
  s0: number;
  aMax: number;
  bComf: number;
  x: number;
  z: number;
  heading: number;
  signal: 'none' | 'left' | 'right';
  brake: boolean;
  stopTimer: number;
  cleared: boolean;
  stuck: number;
  crashed: number;
  hazard: boolean;
  scriptBrake: number;
  lightsOn: boolean;
  /** Emergency vehicle with siren / beacons active. */
  siren: boolean;
  /** Heavy vehicles keep right and have their own speed cap (km/h). */
  heavy: boolean;
  speedCap: number;
  /** Lateral visual offset (m, + = right of travel) while changing lanes / pulling over. */
  latOff: number;
  pullOver: number;
  lcTarget: Lane | null;
  lcSignalT: number;
  lcCooldown: number;
  lcCheckT: number;
  /** Signal shown for a lane change in progress. */
  lcSignal: 'none' | 'left' | 'right';
  /** Emergency vehicle currently passing an obstacle on the left. */
  passing: number;
  /** Tractor / trailer poses for articulated lorries. */
  cab: { x: number; z: number; h: number } | null;
  trailer: { x: number; z: number; h: number } | null;
  sirenT: number;
};

export type PedObstacle = { x: number; z: number };

const LOOKAHEAD = 80;

const TYPE_COLORS: Partial<Record<CarType, string[]>> = {
  taxi: ['#f4c20d'],
  bus: ['#e8eef3', '#2f6fb3', '#d9534f'],
  minibus: ['#f2f2f0', '#f4c20d', '#e8e2d0'],
  police: ['#f4f6f8'],
  ambulance: ['#f7f7f5'],
  tir: ['#c62828', '#1565c0', '#f5f5f5', '#2e7d32', '#37474f', '#ef6c00'],
  truck: ['#f5f5f5', '#1e88e5', '#e53935', '#fdd835'],
  moto: ['#e53935', '#1e88e5', '#212121', '#fb8c00', '#43a047'],
};

const TRAILER_COLORS = ['#eceff1', '#cfd8dc', '#b0bec5', '#1565c0', '#ffffff', '#c62828'];

/** Lane-following traffic: IDM car-following, zone speed limits, signals, stop/yield, roundabouts,
 *  signalled lane changes (overtake / keep right), articulated lorries and emergency vehicles. */
export class AITraffic {
  readonly cars: AICar[] = [];
  readonly renderer: VehicleRenderer;
  private net: RoadNetwork;
  private world: CityWorld;
  private signals: SignalController;
  private rng: Rng;
  private nextId = 1;
  private parkedVisible: VehicleVisual[] = [];
  private parkedTimer = 0;
  private parkedColors = new Map<ParkingSlot, { type: CarType; color: THREE.Color }>();
  private trailerColors = new Map<number, THREE.Color>();
  target = 30;
  radius = 260;
  /** Extra range used on open roads (highway) so traffic does not pop in. */
  wideRadius = 420;
  lightsOn = false;
  /** Emergency vehicle schedule (seconds until the next one; ≤ 0 disables). */
  emergencyEvery = 0;
  private emergencyTimer = 90;
  private visuals: VehicleVisual[] = [];
  private tmp = { x: 0, z: 0, h: 0 };
  private nearLanes: Lane[] = [];
  private nearTimer = 0;
  private playerFast = false;
  private time = 0;

  constructor(world: CityWorld, signals: SignalController, seed = 1) {
    this.world = world;
    this.net = world.net;
    this.signals = signals;
    this.rng = mulberry32(seed);
    const cap: Partial<Record<CarType, number>> = {
      hatch: 160,
      sedan: 160,
      suv: 90,
      van: 70,
      taxi: 60,
      bus: 14,
      truck: 24,
      wagon: 60,
      pickup: 40,
      minibus: 24,
      police: 8,
      ambulance: 6,
      tir: 20,
      trailer: 20,
      moto: 30,
    };
    this.renderer = new VehicleRenderer(cap);
    // Parked cars: fixed look + static colliders
    const prng = mulberry32(world.map.seed ^ 0x9e37);
    for (const slot of world.parking) {
      if (!slot.occupied) continue;
      const type = randomCarType(prng, 'parked');
      const fp = vehicleFootprint(type);
      this.parkedColors.set(slot, { type, color: new THREE.Color(this.colorFor(type, prng)) });
      world.colliders.add({ kind: 'obb', x: slot.x, z: slot.z, hw: fp.width / 2, hl: fp.length / 2, heading: slot.heading, tag: 'parked' });
    }
  }

  // ——————————————————————————— spawning ———————————————————————————

  private colorFor(type: CarType, rng: Rng): string {
    const list = TYPE_COLORS[type];
    return list ? pick(rng, list) : pick(rng, PALETTE);
  }

  private contextOf(lane: Lane): TrafficContext {
    const e = lane.edge;
    if (e.cls === 'highway') return 'highway';
    const d = this.world.map.district(e.cx, e.cz);
    if (d === 'industrial') return 'industrial';
    if (!this.world.inTown(e.cx, e.cz)) return 'highway';
    return e.cls === 'avenue' || e.cls === 'boulevard' ? 'arterial' : 'street';
  }

  private spawnOn(lane: Lane, s: number, v?: number, forceType?: CarType): AICar | null {
    let type = forceType ?? randomCarType(this.rng, this.contextOf(lane));
    // big vehicles only where they fit
    if ((type === 'tir' || type === 'bus') && lane.edge.spec.lanes < 2 && lane.edge.cls !== 'street') type = 'van';
    if (type === 'trailer') type = 'truck';
    const fp = vehicleFootprint(type);
    // spacing check
    for (const c of this.cars) {
      if (c.lane === lane && Math.abs(c.s - s) < 10 + (fp.length + c.length) / 2) return null;
    }
    const heavy = type === 'tir' || type === 'truck' || type === 'bus';
    const car: AICar = {
      id: this.nextId++,
      type,
      color: new THREE.Color(this.colorFor(type, this.rng)),
      length: fp.length,
      width: fp.width,
      lane,
      conn: null,
      path: lane.path,
      s,
      v: v ?? (this.net.vehicleLimit(0, 0, lane, null, s) / 3.6) * 0.8,
      a: 0,
      next: null,
      // law-abiding drivers: at or slightly below the limit
      v0Factor: heavy ? 0.9 : type === 'moto' ? 0.95 + this.rng() * 0.05 : 0.88 + this.rng() * 0.12,
      T: heavy ? 1.8 : 1.2 + this.rng() * 0.6,
      s0: heavy ? 3 : 2.2 + this.rng() * 0.8,
      aMax: type === 'tir' ? 0.7 : heavy ? 0.9 : type === 'moto' ? 2.4 : 1.4 + this.rng() * 0.8,
      bComf: heavy ? 2.0 : 2.4,
      x: 0,
      z: 0,
      heading: 0,
      signal: 'none',
      brake: false,
      stopTimer: 0,
      cleared: false,
      stuck: 0,
      crashed: 0,
      hazard: false,
      scriptBrake: 0,
      lightsOn: false,
      siren: false,
      heavy,
      speedCap: type === 'tir' || type === 'truck' ? 85 : type === 'bus' || type === 'minibus' ? 90 : 200,
      latOff: 0,
      pullOver: 0,
      lcTarget: null,
      lcSignalT: 0,
      lcCooldown: 4 + this.rng() * 8,
      lcCheckT: this.rng(),
      lcSignal: 'none',
      passing: 0,
      cab: null,
      trailer: null,
      sirenT: 0,
    };
    if (type === 'tir') this.trailerColors.set(car.id, new THREE.Color(pick(this.rng, TRAILER_COLORS)));
    car.next = this.chooseNext(lane);
    this.place(car);
    this.cars.push(car);
    return car;
  }

  private chooseNext(lane: Lane): Connector | null {
    const outs = lane.outs;
    if (!outs.length) return null;
    const w = outs.map((c) => (c.turn === 'S' ? 3 : c.turn === 'R' ? 1.4 : 1) * (c.to.outs.length ? 1 : 0.05));
    let r = this.rng() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < outs.length; i++) {
      r -= w[i];
      if (r <= 0) return outs[i];
    }
    return outs[outs.length - 1];
  }

  /** Sample the car's route (current path → next connector → next lane) at arc offset ds from s. */
  private sampleAhead(c: AICar, ds: number, out: { x: number; z: number; h: number }) {
    let s = c.s + ds;
    if (s <= c.path.length || s < 0) return c.path.sample(s, out);
    s -= c.path.length;
    const nextPath = c.lane ? c.next?.path : c.conn?.to.path;
    if (!nextPath) return c.path.sample(c.s + ds, out);
    if (s <= nextPath.length) return nextPath.sample(s, out);
    if (c.lane && c.next) return c.next.to.path.sample(s - nextPath.length, out);
    return nextPath.sample(s, out);
  }

  private place(c: AICar) {
    c.path.sample(c.s, this.tmp);
    const off = c.latOff + c.pullOver + (c.passing ? -2.6 * c.passing : 0);
    const rx = -Math.cos(this.tmp.h);
    const rz = Math.sin(this.tmp.h);
    c.x = this.tmp.x + rx * off;
    c.z = this.tmp.z + rz * off;
    c.heading = this.tmp.h;
    if (c.type === 'tir') {
      const p = { x: 0, z: 0, h: 0 };
      this.sampleAhead(c, TIR_RIG.tractorOffset, p);
      c.cab = { x: p.x + -Math.cos(p.h) * off, z: p.z + Math.sin(p.h) * off, h: p.h };
      const q = { x: 0, z: 0, h: 0 };
      // trailer heading follows the chord between kingpin and rear axle (lags in turns like a real trailer)
      this.sampleAhead(c, TIR_RIG.trailerOffset + 5.5, p);
      this.sampleAhead(c, TIR_RIG.trailerOffset - 4.5, q);
      const th = Math.atan2(p.x - q.x, p.z - q.z);
      const mx = (p.x + q.x) / 2 + -Math.cos(th) * off;
      const mz = (p.z + q.z) / 2 + Math.sin(th) * off;
      c.trailer = { x: mx - Math.sin(th) * 0.5, z: mz - Math.cos(th) * 0.5, h: th };
    }
  }

  /** Lanes within the (wide) spawn radius of the player — refreshed every couple of seconds. */
  private refreshNearLanes(player: PlayerInfo) {
    const R = this.wideRadius + 40;
    this.nearLanes = this.net.lanes.filter((l) => {
      const e = l.edge;
      const dx = Math.max(0, Math.abs(player.x - e.cx) - (e.axis === 'ew' ? e.length / 2 : e.halfWidth));
      const dz = Math.max(0, Math.abs(player.z - e.cz) - (e.axis === 'ns' ? e.length / 2 : e.halfWidth));
      return dx * dx + dz * dz < R * R;
    });
  }

  /** Fill the area around the player up to the target count. */
  populate(player: PlayerInfo, initial = false) {
    if (initial || !this.nearLanes.length) this.refreshNearLanes(player);
    const lanes = this.nearLanes.length ? this.nearLanes : this.net.lanes;
    let attempts = 0;
    const radius = this.playerFast ? this.wideRadius : this.radius;
    while (this.cars.length < this.target && attempts < (initial ? 2500 : 60)) {
      attempts++;
      const lane = lanes[Math.floor(this.rng() * lanes.length)];
      const s = 6 + this.rng() * Math.max(1, lane.path.length - 12);
      lane.path.sample(s, this.tmp);
      const d = Math.hypot(this.tmp.x - player.x, this.tmp.z - player.z);
      const minD = initial ? 25 : this.playerFast ? radius * 0.62 : Math.min(130, radius * 0.72);
      if (d < minD || d > radius) continue;
      this.spawnOn(lane, s);
    }
  }

  clear() {
    this.cars.length = 0;
    this.trailerColors.clear();
  }

  /** Put a car in the player's lane ahead (used by missions / surprise events). */
  spawnAhead(player: PlayerInfo, dist: number, speedFactor = 0.7, type?: CarType): AICar | null {
    const near = this.net.nearestLane(player.x, player.z, player.heading, 8);
    if (!near) return null;
    let lane = near.lane;
    let s = near.s + dist;
    let guard = 0;
    while (s > lane.path.length - 4 && guard++ < 4) {
      const next = lane.outs.find((c) => c.turn === 'S') ?? lane.outs[0];
      if (!next) return null;
      s -= lane.path.length + next.path.length;
      lane = next.to;
    }
    if (s < 2) return null;
    const car = this.spawnOn(lane, s, (lane.limit / 3.6) * speedFactor, type ?? 'sedan');
    if (car) car.next = lane.outs.find((c) => c.turn === 'S') ?? car.next;
    return car;
  }

  /** Spawn an emergency vehicle (siren on) behind the player in the player's lane. */
  spawnEmergency(player: PlayerInfo, dist = 110, type: 'ambulance' | 'police' = 'ambulance'): AICar | null {
    const near = this.net.nearestLane(player.x, player.z, player.heading, 8);
    if (!near) return null;
    const lane = near.lane;
    const s = near.s - dist;
    if (s < 5) return null;
    // make room
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      if (c.lane === lane && Math.abs(c.s - s) < 18) this.cars.splice(i, 1);
    }
    const car = this.spawnOn(lane, s, (this.net.vehicleLimit(0, 0, lane, null, s) / 3.6) * 1.1, type);
    if (!car) return null;
    car.siren = true;
    car.sirenT = 0;
    car.v0Factor = 1.3;
    car.aMax = 2.6;
    car.T = 0.9;
    car.next = lane.outs.find((c) => c.turn === 'S') ?? car.next;
    return car;
  }

  /** Make the car ahead of the player brake hard. Returns the car if one was found. */
  triggerLeadBrake(player: PlayerInfo, minDist = 12, maxDist = 45): AICar | null {
    const lead = this.leadOf(player, maxDist);
    if (!lead || lead.gap < minDist) return null;
    lead.car.scriptBrake = 2.6;
    return lead.car;
  }

  /** Nearest AI car ahead of the player within its travel corridor. */
  leadOf(player: PlayerInfo, maxDist = 80): { car: AICar; gap: number; relSpeed: number } | null {
    const fx = Math.sin(player.heading);
    const fz = Math.cos(player.heading);
    let best: { car: AICar; gap: number; relSpeed: number } | null = null;
    for (const c of this.cars) {
      const dx = c.x - player.x;
      const dz = c.z - player.z;
      const along = dx * fx + dz * fz;
      if (along <= 0 || along > maxDist + c.length / 2) continue;
      const lat = Math.abs(-dx * fz + dz * fx);
      if (lat > 1.7) continue;
      if (Math.abs(angleDiff(c.heading, player.heading)) > 0.6) continue;
      const gap = along - c.length / 2 - player.length / 2;
      if (!best || gap < best.gap) {
        const cv = c.v * Math.cos(angleDiff(c.heading, player.heading));
        best = { car: c, gap, relSpeed: player.speed - cv };
      }
    }
    return best;
  }

  // ——————————————————————————— simulation ———————————————————————————

  private carsOn(path: Path): AICar[] {
    const out: AICar[] = [];
    for (const c of this.cars) if (c.path === path) out.push(c);
    return out;
  }

  /** Distance to the closest obstacle ahead and its speed. */
  private leader(c: AICar, player: PlayerInfo, peds: PedObstacle[]): { gap: number; v: number; isPlayer: boolean } {
    let best = { gap: Infinity, v: 0, isPlayer: false };
    const consider = (gap: number, v: number, isPlayer = false) => {
      if (gap < best.gap) best = { gap, v, isPlayer };
    };
    // Chain of paths ahead: current → next connector → its lane
    const chain: { path: Path; offset: number }[] = [{ path: c.path, offset: -c.s }];
    if (c.lane && c.next) {
      chain.push({ path: c.next.path, offset: c.path.length - c.s });
      chain.push({ path: c.next.to.path, offset: c.path.length - c.s + c.next.path.length });
    } else if (c.conn) {
      chain.push({ path: c.conn.to.path, offset: c.path.length - c.s });
    }
    for (const { path, offset } of chain) {
      if (offset > LOOKAHEAD) break;
      for (const o of this.carsOn(path)) {
        if (o === c) continue;
        const d = offset + o.s;
        if (d <= 0) continue;
        consider(d - o.length / 2 - c.length / 2, o.v);
      }
    }
    // Other cars inside the same junction on crossing connectors (avoid driving through them)
    const node = c.conn ? c.conn.node : c.lane && c.path.length - c.s < 12 ? c.lane.endNode : null;
    if (node && node.kind !== 'bend') {
      const rb = node.kind === 'roundabout';
      for (const o of this.cars) {
        if (o === c || !o.conn || o.conn.node !== node) continue;
        if (c.conn && o.conn === c.conn) continue;
        const dx = o.x - c.x;
        const dz = o.z - c.z;
        const along = dx * Math.sin(c.heading) + dz * Math.cos(c.heading);
        const lat = Math.abs(-dx * Math.cos(c.heading) + dz * Math.sin(c.heading));
        if (along > 0 && along < 14 && lat < 2.6) {
          // in a roundabout the car ahead is travelling with us — follow it instead of treating it as a wall
          const ov = rb ? Math.max(0, o.v * Math.cos(angleDiff(o.heading, c.heading))) : 0;
          consider(along - c.length / 2 - o.length / 2, ov);
        }
      }
    }
    // Player
    const pf = this.projectAhead(c, chain, player.x, player.z);
    if (pf && pf.lat < 1.9 + player.width / 2) {
      const pv = player.speed * Math.cos(angleDiff(player.heading, pf.h));
      consider(pf.d - player.length / 2 - c.length / 2, Math.max(0, pv), true);
    }
    // Pedestrians on the road ahead
    for (const p of peds) {
      const pp = this.projectAhead(c, chain, p.x, p.z);
      if (pp && pp.lat < 2.6 && pp.d < 35) consider(pp.d - c.length / 2 - 1.5, 0);
    }
    return best;
  }

  private projectAhead(c: AICar, chain: { path: Path; offset: number }[], x: number, z: number): { d: number; lat: number; h: number } | null {
    const dist0 = Math.hypot(x - c.x, z - c.z);
    if (dist0 > LOOKAHEAD) return null;
    let best: { d: number; lat: number; h: number } | null = null;
    for (const { path, offset } of chain) {
      if (offset > LOOKAHEAD) break;
      const pr = path.project(x, z);
      const d = offset + pr.s;
      if (d <= 0.2) continue;
      if (pr.s <= 0.01 && offset > 0) continue;
      if (pr.s >= path.length - 0.01 && pr.dist > 2) continue;
      if (!best || Math.abs(pr.lateral) < best.lat) {
        path.sample(pr.s, this.tmp);
        best = { d, lat: Math.abs(pr.lateral), h: this.tmp.h };
      }
    }
    return best;
  }

  /** Should the car stop at the upcoming stop line? Returns distance to line or Infinity. */
  private stopLine(c: AICar, player: PlayerInfo): number {
    if (!c.lane) return Infinity;
    const lane = c.lane;
    const node = lane.endNode;
    const ctl = node.control[lane.arm] ?? 'none';
    const dist = lane.stopS - c.s - c.length / 2;
    if (dist < -2 || dist > 70) return Infinity;
    if (c.siren) return Infinity; // emergency vehicles proceed with caution
    if (ctl === 'signal') {
      const st = this.signals.state(node, lane.arm);
      if (st === 'red' || st === 'redyellow') return dist;
      if (st === 'yellow') {
        const need = (c.v * c.v) / (2 * 4.5);
        if (dist > need && dist > 1) return dist;
        return Infinity;
      }
      if (c.next?.turn === 'L' && this.oncomingBusy(node, lane, player)) return dist;
      return Infinity;
    }
    if (ctl === 'stop' || ctl === 'yield') {
      if (c.cleared) return Infinity;
      if (ctl === 'stop' && c.stopTimer < 1.0) return dist;
      if (dist > 8) return ctl === 'stop' ? dist : Infinity;
      const busy = node.kind === 'roundabout' ? this.roundaboutBusy(node, lane, player) : this.crossTrafficNear(node, lane, player);
      if (busy) return dist;
      c.cleared = true;
      return Infinity;
    }
    return Infinity;
  }

  private oncomingBusy(node: RoadNode, lane: Lane, player: PlayerInfo): boolean {
    const opp = lane.arm === 'N' ? 'S' : lane.arm === 'S' ? 'N' : lane.arm === 'E' ? 'W' : 'E';
    const ins = this.net.incomingLanes(node, opp);
    for (const c of this.cars) {
      if (c.lane && ins.includes(c.lane) && c.v > 1.5 && c.lane.path.length - c.s < Math.max(45, c.v * 4) && c.next?.turn !== 'L') return true;
      if (c.conn && c.conn.node === node && c.conn.from.arm === opp && c.conn.turn !== 'L') return true;
    }
    // player coming the other way
    for (const l of ins) {
      const pr = l.path.project(player.x, player.z);
      if (pr.dist < 2.2 && l.path.length - pr.s < Math.max(45, Math.abs(player.speed) * 4) && Math.abs(player.speed) > 1.5) return true;
    }
    return false;
  }

  private crossTrafficNear(node: RoadNode, lane: Lane, player: PlayerInfo): boolean {
    const dx = player.x - node.x;
    const dz = player.z - node.z;
    const pd = Math.hypot(dx, dz);
    if (pd < 26 + Math.abs(player.speed) * 2 && Math.abs(player.speed) > 1 && Math.abs(angleDiff(player.heading, lane.heading)) > 0.4) return true;
    for (const c of this.cars) {
      if (c.conn && c.conn.node === node) return true;
      if (!c.lane || c.lane.endNode !== node || c.lane.arm === lane.arm) continue;
      const rem = c.lane.path.length - c.s;
      const ctl = node.control[c.lane.arm] ?? 'none';
      // time-based gap: fast priority traffic needs a longer clear distance
      if (ctl === 'none' && rem < Math.max(34, c.v * 4.5) && c.v > 1) return true;
    }
    return false;
  }

  /** Circulating traffic (or the player) about to pass our entry point? */
  private roundaboutBusy(node: RoadNode, lane: Lane, player: PlayerInfo): boolean {
    lane.path.sample(lane.path.length, this.tmp);
    const ae = Math.atan2(this.tmp.z - node.z, this.tmp.x - node.x);
    const conflict = (x: number, z: number, v: number) => {
      const d = Math.hypot(x - node.x, z - node.z);
      if (d > node.ringOuter + 1 || d < node.radius) return false;
      let da = Math.atan2(z - node.z, x - node.x) - ae;
      while (da < 0) da += Math.PI * 2;
      while (da >= Math.PI * 2) da -= Math.PI * 2;
      if (da < 0.35 || da > Math.PI * 2 - 0.35) return true; // right at our entry
      return da < 2.3 && (da * node.ringR) / Math.max(1.5, v) < 3.2;
    };
    for (const c of this.cars) if (c.conn && c.conn.node === node && conflict(c.x, c.z, c.v)) return true;
    return conflict(player.x, player.z, Math.abs(player.speed));
  }

  // ——————————————————————————— lane changes ———————————————————————————

  private sameDirLanes(lane: Lane): Lane[] {
    return lane.dir === 1 ? lane.edge.lanesFwd : lane.edge.lanesBwd;
  }

  /** Nearest vehicle on `lane` ahead of / behind arc length s (player included). */
  private neighbour(c: AICar, lane: Lane, s: number, player: PlayerInfo): { ahead: { gap: number; v: number }; behind: { gap: number; v: number } } {
    const ahead = { gap: Infinity, v: 0 };
    const behind = { gap: Infinity, v: 0 };
    for (const o of this.cars) {
      if (o === c || o.lane !== lane) continue;
      const d = o.s - s;
      const g = Math.abs(d) - (o.length + c.length) / 2;
      if (d >= 0 && g < ahead.gap) {
        ahead.gap = g;
        ahead.v = o.v;
      } else if (d < 0 && g < behind.gap) {
        behind.gap = g;
        behind.v = o.v;
      }
    }
    const pr = lane.path.project(player.x, player.z);
    if (pr.dist < 2.2 && pr.s > 0.5 && pr.s < lane.path.length - 0.5) {
      const d = pr.s - s;
      const g = Math.abs(d) - (player.length + c.length) / 2;
      const pv = Math.max(0, player.speed * Math.cos(angleDiff(player.heading, lane.heading)));
      if (d >= 0 && g < ahead.gap) {
        ahead.gap = g;
        ahead.v = pv;
      } else if (d < 0 && g < behind.gap) {
        behind.gap = g;
        behind.v = pv;
      }
    }
    return { ahead, behind };
  }

  private safeToEnter(c: AICar, lane: Lane, player: PlayerInfo): boolean {
    const n = this.neighbour(c, lane, c.s, player);
    const needAhead = Math.max(10, c.v * 1.1 + Math.max(0, c.v - n.ahead.v) * 2.5);
    const needBehind = Math.max(10, n.behind.v * 1.3 + Math.max(0, n.behind.v - c.v) * 3);
    return n.ahead.gap > needAhead && n.behind.gap > needBehind;
  }

  private emergencyBehind(c: AICar): AICar | null {
    for (const o of this.cars) {
      if (!o.siren || o === c) continue;
      const dx = c.x - o.x;
      const dz = c.z - o.z;
      const d = Math.hypot(dx, dz);
      if (d > 75 || d < 1) continue;
      const along = dx * Math.sin(o.heading) + dz * Math.cos(o.heading);
      if (along > 0 && Math.abs(angleDiff(o.heading, c.heading)) < 0.7) return o;
    }
    return null;
  }

  private considerLaneChange(c: AICar, desired: number, lead: { gap: number; v: number }, player: PlayerInfo) {
    if (!c.lane || c.lcTarget || Math.abs(c.latOff) > 0.05 || c.lcCooldown > 0 || c.siren) return;
    const lane = c.lane;
    const e = lane.edge;
    if (e.spec.lanes < 2 || c.type === 'moto') return;
    if (c.s < 20 || c.s > lane.solidFromS - 6 || lane.path.length - c.s < 45) return;
    const lanes = this.sameDirLanes(lane);
    let target: Lane | null = null;
    const em = this.emergencyBehind(c);
    // 1) make way for an emergency vehicle
    if (em && lane.index > 0) {
      const R = lanes[lane.index - 1];
      if (this.safeToEnter(c, R, player)) target = R;
    }
    // 2) overtake a slower vehicle on the left (lorries stay in the right lanes)
    const maxIndex = c.heavy && e.cls === 'highway' ? Math.min(1, lanes.length - 1) : lanes.length - 1;
    if (!target && !em && lane.index < maxIndex && lead.gap < 60 && lead.v < desired - 2.5) {
      const L = lanes[lane.index + 1];
      const n = this.neighbour(c, L, c.s, player);
      if (n.ahead.gap > lead.gap + 15 && this.safeToEnter(c, L, player)) target = L;
    }
    // 3) keep right once the right lane is free (and lorries leave the fast lanes)
    const keepRightRoad = e.cls === 'highway' || e.cls === 'boulevard' || e.cls === 'avenue';
    if (!target && lane.index > 0 && (keepRightRoad || lane.index > maxIndex)) {
      const R = lanes[lane.index - 1];
      const n = this.neighbour(c, R, c.s, player);
      if ((n.ahead.gap > 90 || n.ahead.v >= desired - 1) && this.safeToEnter(c, R, player)) target = R;
    }
    if (!target) return;
    c.lcTarget = target;
    c.lcSignalT = 1.4 + this.rng() * 0.8; // signal first, then move
    c.lcSignal = target.index > lane.index ? 'left' : 'right';
  }

  private executeLaneChange(c: AICar, player: PlayerInfo) {
    const target = c.lcTarget!;
    c.lcTarget = null;
    if (!c.lane || target.edge !== c.lane.edge || !this.safeToEnter(c, target, player) || c.s > target.solidFromS - 2) {
      c.lcSignal = 'none';
      c.lcCooldown = 3;
      return;
    }
    c.latOff = (target.index - c.lane.index) * target.width;
    c.lane = target;
    c.path = target.path;
    c.next = this.chooseNext(target);
    c.lcCooldown = 8 + this.rng() * 10;
  }

  // ——————————————————————————— main update ———————————————————————————

  update(dt: number, player: PlayerInfo, peds: PedObstacle[]) {
    this.time += dt;
    this.playerFast = Math.abs(player.speed) > 17 || this.net.query(player.x, player.z, player.heading).edge?.cls === 'highway';
    this.nearTimer -= dt;
    if (this.nearTimer <= 0) {
      this.nearTimer = 2;
      this.refreshNearLanes(player);
    }
    const despawnR = (this.playerFast ? this.wideRadius : this.radius) + 60;
    // Despawn far cars
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const d = Math.hypot(c.x - player.x, c.z - player.z);
      const sirenDone = c.siren && (c.sirenT > 110 || d > 420);
      if (d > despawnR + (c.siren ? 250 : 0) || (c.stuck > 50 && d > 60) || (c.crashed > 0 && c.crashed < 0.01 && d > 60) || (sirenDone && d > 150)) {
        this.trailerColors.delete(c.id);
        this.cars.splice(i, 1);
      }
    }
    this.populate(player);
    // Scheduled emergency vehicle
    if (this.emergencyEvery > 0) {
      this.emergencyTimer -= dt;
      if (this.emergencyTimer <= 0) {
        this.emergencyTimer = this.emergencyEvery * (0.7 + this.rng() * 0.6);
        if (Math.abs(player.speed) > 4 && !this.cars.some((c) => c.siren)) this.spawnEmergency(player, 120, this.rng() < 0.6 ? 'ambulance' : 'police');
      }
    }

    for (const c of this.cars) {
      if (c.crashed > 0) {
        c.crashed = Math.max(0.001, c.crashed - dt);
        c.v = Math.max(0, c.v - 8 * dt);
        c.hazard = true;
        c.brake = true;
        c.s += c.v * dt;
        this.advance(c);
        continue;
      }
      if (c.siren) c.sirenT += dt;
      c.lcCooldown -= dt;
      const lim = this.net.vehicleLimit(c.x, c.z, c.lane, c.conn, c.s) / 3.6;
      let v0 = Math.min(lim * c.v0Factor, c.speedCap / 3.6);
      if (c.siren) v0 = Math.min(lim * 1.3, c.lane?.edge.cls === 'highway' ? 36 : 22);
      // slow for upcoming turn
      if (c.lane && c.next && c.next.turn !== 'S') {
        const rem = c.path.length - c.s;
        const vt = c.next.limit / 3.6;
        v0 = Math.min(v0, Math.sqrt(vt * vt + 2 * 1.8 * Math.max(0, rem - 2)));
      }
      // …and for bends / roundabouts ahead
      if (c.lane && c.next && c.next.node.kind !== 'junction') {
        const rem = c.path.length - c.s;
        const vt = c.next.limit / 3.6;
        v0 = Math.min(v0, Math.sqrt(vt * vt + 2 * 1.5 * Math.max(0, rem - 4)));
      }
      // approach stop / yield junctions slowly; emergency vehicles slow down at junctions
      if (c.lane) {
        const ctl = c.lane.endNode.control[c.lane.arm];
        const rem = c.path.length - c.s;
        if ((ctl === 'stop' || ctl === 'yield') && !c.cleared && rem < 30) v0 = Math.min(v0, 5.5);
        if (c.siren && ctl && ctl !== 'none' && rem < 35) v0 = Math.min(v0, 7);
      }
      // make way for emergency vehicles on single-lane roads: pull over and crawl
      const em = !c.siren ? this.emergencyBehind(c) : null;
      if (em && (!c.lane || c.lane.index === 0)) {
        c.pullOver = approach(c.pullOver, 1.1, 1.2 * dt);
        v0 = Math.min(v0, 3);
      } else c.pullOver = approach(c.pullOver, 0, 0.8 * dt);

      const lead = this.leader(c, player, peds);
      // Emergency vehicles pass slow obstacles on the left
      if (c.siren) {
        if (lead.gap < 16 && lead.v < 5) c.passing = approach(c.passing, 1, 0.7 * dt);
        else if (lead.gap > 25 || lead.v > 8) c.passing = approach(c.passing, 0, 0.5 * dt);
        if (c.passing > 0.6 && lead.gap < 16) {
          lead.gap = Infinity;
          lead.v = 0;
        }
      }
      const sl = this.stopLine(c, player);
      if (sl !== Infinity && sl + c.s0 - 0.6 < lead.gap) {
        // virtual stationary obstacle so the front bumper halts ~0.6 m before the line
        lead.gap = Math.max(0, sl + c.s0 - 0.6);
        lead.v = 0;
      }
      // IDM
      const vr = c.v;
      const dv = vr - lead.v;
      const sStar = c.s0 + Math.max(0, vr * c.T + (vr * dv) / (2 * Math.sqrt(c.aMax * c.bComf)));
      const gap = Math.max(0.1, lead.gap);
      let a = c.aMax * (1 - Math.pow(vr / Math.max(0.5, v0), 4) - (lead.gap === Infinity ? 0 : (sStar / gap) ** 2));
      a = clamp(a, -9, c.aMax);
      if (c.scriptBrake > 0) {
        c.scriptBrake -= dt;
        a = Math.min(a, -7.5);
      }
      c.a = a;
      c.v = Math.max(0, c.v + a * dt);
      if (lead.gap < 0.3) c.v = Math.min(c.v, 0.2);
      c.brake = a < -0.6 || (c.v < 0.3 && lead.gap < 8);
      c.s += c.v * dt;
      // stop sign bookkeeping
      if (c.lane) {
        const ctl = c.lane.endNode.control[c.lane.arm];
        if (ctl === 'stop' && c.lane.stopS - c.s - c.length / 2 < 4.5 && c.v < 0.5) c.stopTimer += dt;
      }
      c.stuck = c.v < 0.2 ? c.stuck + dt : 0;

      // Lane changes (checked a few times per second)
      c.lcCheckT -= dt;
      if (c.lcCheckT <= 0) {
        c.lcCheckT = 0.4 + this.rng() * 0.3;
        this.considerLaneChange(c, v0, lead, player);
      }
      if (c.lcTarget) {
        c.lcSignalT -= dt;
        if (c.lcSignalT <= 0) this.executeLaneChange(c, player);
      }
      if (c.latOff !== 0) {
        c.latOff = approach(c.latOff, 0, (3.4 / 3.2) * dt);
        if (Math.abs(c.latOff) < 0.25 && !c.lcTarget) c.lcSignal = 'none';
      } else if (!c.lcTarget) c.lcSignal = 'none';

      // turn signals: lane change > turn at the next junction > roundabout exit
      c.signal = c.lcSignal;
      if (c.signal === 'none') {
        if (c.lane && c.next && c.path.length - c.s < 45 && c.next.node.kind === 'junction') c.signal = c.next.turn === 'L' ? 'left' : c.next.turn === 'R' ? 'right' : 'none';
        if (c.lane && c.next && c.next.node.kind === 'roundabout' && c.path.length - c.s < 30 && c.next.turn === 'R') c.signal = 'right';
        if (c.conn && c.conn.node.kind === 'junction') c.signal = c.conn.turn === 'L' ? 'left' : c.conn.turn === 'R' ? 'right' : 'none';
        if (c.conn && c.conn.node.kind === 'roundabout') c.signal = c.conn.path.length - c.s < 14 ? 'right' : c.conn.turn === 'L' && c.s < 10 ? 'left' : 'none';
        if (em && c.pullOver > 0.3) c.signal = 'right';
      }
      this.advance(c);
    }
  }

  private advance(c: AICar) {
    while (c.s > c.path.length) {
      c.s -= c.path.length;
      if (c.lane) {
        if (!c.next) {
          c.s = c.path.length;
          c.v = 0;
          break;
        }
        c.conn = c.next;
        c.lane = null;
        c.path = c.conn.path;
        c.lcTarget = null;
        c.latOff = 0;
      } else if (c.conn) {
        c.lane = c.conn.to;
        c.conn = null;
        c.path = c.lane.path;
        c.next = this.chooseNext(c.lane);
        c.stopTimer = 0;
        c.cleared = false;
      }
    }
    this.place(c);
  }

  /** Mark a car as crashed (stops with hazards). */
  crash(c: AICar) {
    c.crashed = 25;
    c.scriptBrake = 0;
    c.siren = false;
  }

  /** Build visuals (moving + nearby parked) and push them to the GPU. */
  render(dt: number, px: number, pz: number, blink: boolean, parkedRadius: number) {
    this.parkedTimer -= dt;
    if (this.parkedTimer <= 0) {
      this.parkedTimer = 0.8;
      this.parkedVisible = [];
      for (const [slot, look] of this.parkedColors) {
        if (Math.abs(slot.x - px) > parkedRadius || Math.abs(slot.z - pz) > parkedRadius) continue;
        this.parkedVisible.push({ type: look.type, x: slot.x, z: slot.z, heading: slot.heading, color: look.color, brake: false, lights: false, indL: false, indR: false });
      }
    }
    const list = this.visuals;
    list.length = 0;
    for (const p of this.parkedVisible) list.push(p);
    const flash = Math.floor(this.time * 6) % 2 === 0 ? 1 : 2;
    for (const c of this.cars) {
      const hz = c.hazard && blink;
      const roll = c.type === 'moto' ? clamp(-(c.conn ? (c.conn.turn === 'L' ? 1 : c.conn.turn === 'R' ? -1 : 0) : 0) * c.v * 0.02, -0.35, 0.35) : clamp(-c.v * c.v * 0.0005 * Math.sign(c.conn?.turn === 'L' ? 1 : c.conn?.turn === 'R' ? -1 : 0), -0.03, 0.03);
      const base = {
        color: c.color,
        brake: c.brake,
        lights: this.lightsOn || c.siren,
        indL: hz || (c.signal === 'left' && blink),
        indR: hz || (c.signal === 'right' && blink),
        roll,
        beacon: c.siren ? flash : 0,
      };
      if (c.type === 'tir' && c.cab && c.trailer) {
        list.push({ ...base, type: 'tir', x: c.cab.x, z: c.cab.z, heading: c.cab.h });
        list.push({ ...base, type: 'trailer', x: c.trailer.x, z: c.trailer.z, heading: c.trailer.h, color: this.trailerColors.get(c.id) ?? c.color, roll: 0 });
        continue;
      }
      list.push({ ...base, type: c.type, x: c.x, z: c.z, heading: c.heading });
    }
    this.renderer.draw(list);
  }

  /** Closest emergency vehicle running its siren within `radius` of the player. */
  emergencyNear(player: PlayerInfo, radius: number): { id: number; x: number; z: number; heading: number; v: number; type: CarType } | null {
    let best: AICar | null = null;
    let bd = radius;
    for (const c of this.cars) {
      if (!c.siren) continue;
      const d = Math.hypot(c.x - player.x, c.z - player.z);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best ? { id: best.id, x: best.x, z: best.z, heading: best.heading, v: best.v, type: best.type } : null;
  }

  /** Remove the parked car from a slot (e.g. to make room for a parking mission). */
  freeSlot(slot: ParkingSlot) {
    if (!this.parkedColors.has(slot)) return;
    this.parkedColors.delete(slot);
    slot.occupied = false;
    this.world.colliders.remove((c) => c.kind === 'obb' && c.tag === 'parked' && Math.abs(c.x - slot.x) < 0.01 && Math.abs(c.z - slot.z) < 0.01);
    this.parkedTimer = 0;
  }

  /** Random helper for missions that want an occasional variation. */
  rand(lo: number, hi: number) {
    return randRange(this.rng, lo, hi);
  }
}
