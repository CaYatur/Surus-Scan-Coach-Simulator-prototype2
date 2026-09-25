import * as THREE from 'three';
import { clamp, mulberry32, pick, angleDiff, type Rng } from '../core/math';
import { carParts, PALETTE, randomCarType, type CarType } from '../vehicle/carModels';
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
};

export type PedObstacle = { x: number; z: number };

const LOOKAHEAD = 80;

/** Lane-following traffic with IDM car-following, signals, stop/yield rules and turn signals. */
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
  target = 30;
  radius = 260;
  lightsOn = false;
  private visuals: VehicleVisual[] = [];
  private tmp = { x: 0, z: 0, h: 0 };

  constructor(world: CityWorld, signals: SignalController, seed = 1) {
    this.world = world;
    this.net = world.net;
    this.signals = signals;
    this.rng = mulberry32(seed);
    const cap: Partial<Record<CarType, number>> = { hatch: 160, sedan: 160, suv: 90, van: 70, taxi: 60, bus: 12, truck: 20 };
    this.renderer = new VehicleRenderer(cap);
    // Parked cars: fixed look + static colliders
    const prng = mulberry32(world.map.seed ^ 0x9e37);
    for (const slot of world.parking) {
      if (!slot.occupied) continue;
      const type = randomCarType(prng, false);
      const dims = carParts(type).dims;
      this.parkedColors.set(slot, { type, color: new THREE.Color(pick(prng, PALETTE)) });
      world.colliders.add({ kind: 'obb', x: slot.x, z: slot.z, hw: dims.width / 2, hl: dims.length / 2, heading: slot.heading, tag: 'parked' });
    }
  }

  // ——————————————————————————— spawning ———————————————————————————

  private randomColor(type: CarType): THREE.Color {
    if (type === 'taxi') return new THREE.Color('#f4c20d');
    if (type === 'bus') return new THREE.Color(pick(this.rng, ['#e8eef3', '#2f6fb3', '#d9534f']));
    return new THREE.Color(pick(this.rng, PALETTE));
  }

  private spawnOn(lane: Lane, s: number, v?: number): AICar | null {
    const heavy = lane.edge.cls === 'avenue' || lane.edge.cls === 'boulevard';
    const type = randomCarType(this.rng, heavy);
    const dims = carParts(type).dims;
    // spacing check
    for (const c of this.cars) {
      if (c.lane === lane && Math.abs(c.s - s) < 10 + dims.length) return null;
    }
    const car: AICar = {
      id: this.nextId++,
      type,
      color: this.randomColor(type),
      length: dims.length,
      width: dims.width,
      lane,
      conn: null,
      path: lane.path,
      s,
      v: v ?? (lane.limit / 3.6) * 0.8,
      a: 0,
      next: null,
      v0Factor: type === 'bus' || type === 'truck' ? 0.8 : 0.88 + this.rng() * 0.2,
      T: 1.2 + this.rng() * 0.6,
      s0: 2.2 + this.rng() * 0.8,
      aMax: type === 'bus' || type === 'truck' ? 1.0 : 1.4 + this.rng() * 0.8,
      bComf: 2.4,
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
    };
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

  private place(c: AICar) {
    c.path.sample(c.s, this.tmp);
    c.x = this.tmp.x;
    c.z = this.tmp.z;
    c.heading = this.tmp.h;
  }

  /** Fill the area around the player up to the target count. */
  populate(player: PlayerInfo, initial = false) {
    let attempts = 0;
    const lanes = this.net.lanes;
    while (this.cars.length < this.target && attempts < (initial ? 900 : 40)) {
      attempts++;
      const lane = lanes[Math.floor(this.rng() * lanes.length)];
      const s = 6 + this.rng() * Math.max(1, lane.path.length - 12);
      lane.path.sample(s, this.tmp);
      const d = Math.hypot(this.tmp.x - player.x, this.tmp.z - player.z);
      const minD = initial ? 28 : 140;
      if (d < minD || d > this.radius) continue;
      // never spawn in the player's own lane directly behind them
      this.spawnOn(lane, s);
    }
  }

  clear() {
    this.cars.length = 0;
  }

  /** Put a car in the player's lane ahead (used by missions / surprise events). */
  spawnAhead(player: PlayerInfo, dist: number, speedFactor = 0.7): AICar | null {
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
    const car = this.spawnOn(lane, s, (lane.limit / 3.6) * speedFactor);
    if (car) car.next = lane.outs.find((c) => c.turn === 'S') ?? car.next;
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
      if (along <= 0 || along > maxDist) continue;
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
  private leader(c: AICar, player: PlayerInfo, peds: PedObstacle[]): { gap: number; v: number } {
    let best = { gap: Infinity, v: 0 };
    const consider = (gap: number, v: number) => {
      if (gap < best.gap) best = { gap, v };
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
    if (c.conn || (c.lane && c.path.length - c.s < 12)) {
      const node = c.conn ? c.conn.node : c.lane!.endNode;
      for (const o of this.cars) {
        if (o === c || !o.conn || o.conn.node !== node) continue;
        if (c.conn && o.conn === c.conn) continue;
        const dx = o.x - c.x;
        const dz = o.z - c.z;
        const along = dx * Math.sin(c.heading) + dz * Math.cos(c.heading);
        const lat = Math.abs(-dx * Math.cos(c.heading) + dz * Math.sin(c.heading));
        if (along > 0 && along < 14 && lat < 2.6) consider(along - c.length / 2 - o.length / 2, 0);
      }
    }
    // Player
    const pf = this.projectAhead(c, chain, player.x, player.z);
    if (pf && pf.lat < 1.9 + player.width / 2) {
      const pv = player.speed * Math.cos(angleDiff(player.heading, pf.h));
      consider(pf.d - player.length / 2 - c.length / 2, Math.max(0, pv));
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
      if (this.crossTrafficNear(node, lane, player)) return dist;
      c.cleared = true;
      return Infinity;
    }
    return Infinity;
  }

  private oncomingBusy(node: RoadNode, lane: Lane, player: PlayerInfo): boolean {
    const opp = lane.arm === 'N' ? 'S' : lane.arm === 'S' ? 'N' : lane.arm === 'E' ? 'W' : 'E';
    const ins = this.net.incomingLanes(node, opp);
    for (const c of this.cars) {
      if (c.lane && ins.includes(c.lane) && c.v > 1.5 && c.lane.path.length - c.s < 45 && c.next?.turn !== 'L') return true;
      if (c.conn && c.conn.node === node && c.conn.from.arm === opp && c.conn.turn !== 'L') return true;
    }
    // player coming the other way
    for (const l of ins) {
      const pr = l.path.project(player.x, player.z);
      if (pr.dist < 2.2 && l.path.length - pr.s < 45 && Math.abs(player.speed) > 1.5) return true;
    }
    return false;
  }

  private crossTrafficNear(node: RoadNode, lane: Lane, player: PlayerInfo): boolean {
    const dx = player.x - node.x;
    const dz = player.z - node.z;
    const pd = Math.hypot(dx, dz);
    if (pd < 26 && Math.abs(player.speed) > 1 && Math.abs(angleDiff(player.heading, lane.heading)) > 0.4) return true;
    for (const c of this.cars) {
      if (c.conn && c.conn.node === node) return true;
      if (!c.lane || c.lane.endNode !== node || c.lane.arm === lane.arm) continue;
      const rem = c.lane.path.length - c.s;
      const ctl = node.control[c.lane.arm] ?? 'none';
      if (ctl === 'none' && rem < 34 && c.v > 1) return true;
    }
    return false;
  }

  update(dt: number, player: PlayerInfo, peds: PedObstacle[]) {
    // Despawn far cars
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const d = Math.hypot(c.x - player.x, c.z - player.z);
      if (d > this.radius + 60 || (c.stuck > 50 && d > 60) || (c.crashed > 0 && c.crashed < 0.01 && d > 60)) this.cars.splice(i, 1);
    }
    this.populate(player);

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
      const lim = (c.conn ? c.conn.limit : c.lane!.limit) / 3.6;
      let v0 = lim * c.v0Factor;
      // slow for upcoming turn
      if (c.lane && c.next && c.next.turn !== 'S') {
        const rem = c.path.length - c.s;
        const vt = c.next.limit / 3.6;
        v0 = Math.min(v0, Math.sqrt(vt * vt + 2 * 1.8 * Math.max(0, rem - 2)));
      }
      // approach stop / yield junctions slowly
      if (c.lane) {
        const ctl = c.lane.endNode.control[c.lane.arm];
        if ((ctl === 'stop' || ctl === 'yield') && !c.cleared && c.path.length - c.s < 30) v0 = Math.min(v0, 5.5);
      }
      const lead = this.leader(c, player, peds);
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
      // turn signals
      c.signal = 'none';
      if (c.lane && c.next && c.path.length - c.s < 45) c.signal = c.next.turn === 'L' ? 'left' : c.next.turn === 'R' ? 'right' : 'none';
      if (c.conn) c.signal = c.conn.turn === 'L' ? 'left' : c.conn.turn === 'R' ? 'right' : 'none';
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
    for (const c of this.cars) {
      const hz = c.hazard && blink;
      list.push({
        type: c.type,
        x: c.x,
        z: c.z,
        heading: c.heading,
        color: c.color,
        brake: c.brake,
        lights: this.lightsOn,
        indL: hz || (c.signal === 'left' && blink),
        indR: hz || (c.signal === 'right' && blink),
        roll: clamp(-c.v * c.v * 0.0005 * Math.sign(c.conn?.turn === 'L' ? 1 : c.conn?.turn === 'R' ? -1 : 0), -0.03, 0.03),
      });
    }
    this.renderer.draw(list);
  }

  /** Remove the parked car from a slot (e.g. to make room for a parking mission). */
  freeSlot(slot: ParkingSlot) {
    if (!this.parkedColors.has(slot)) return;
    this.parkedColors.delete(slot);
    slot.occupied = false;
    this.world.colliders.remove((c) => c.kind === 'obb' && c.tag === 'parked' && Math.abs(c.x - slot.x) < 0.01 && Math.abs(c.z - slot.z) < 0.01);
    this.parkedTimer = 0;
  }
}
