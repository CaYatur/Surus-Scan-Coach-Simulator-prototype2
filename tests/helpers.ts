import { DrivingMonitor, type MonitorFrame } from '../src/coach/monitor';
import { RoadNetwork, type Lane } from '../src/world/roadNetwork';
import { MAPS } from '../src/world/mapDefs';

let cityNet: RoadNetwork | null = null;

/** The real city road network (pure data, no rendering) — built once per test file. */
export function city(): RoadNetwork {
  return (cityNet ??= new RoadNetwork(MAPS.city));
}

/** A long two-lane boulevard (both lanes in the travel direction, no junction for ~500 m). */
export function boulevard(): { lane0: Lane; lane1: Lane } {
  const e = city().edges.find((e) => e.cls === 'boulevard' && e.oneway === 0 && e.length > 500 && e.lanesFwd.length === 2);
  if (!e) throw new Error('no boulevard in the city map');
  return { lane0: e.lanesFwd[0], lane1: e.lanesFwd[1] };
}

export type Step = {
  /** 0 = centre of lane 0 (curb), 1 = centre of lane 1 (to its left). */
  lat?: number;
  signal?: MonitorFrame['signal'];
  reached?: MonitorFrame['reached'];
  lead?: MonitorFrame['lead'];
  kmh?: number;
};

/**
 * Drive along the boulevard for `seconds`, feeding every frame through the monitor.
 * `plan(t)` decides the lateral position, indicator, glance and lead vehicle at time t.
 */
export function drive(mon: DrivingMonitor, seconds: number, plan: (t: number) => Step, opts: { t0?: number; s0?: number; dt?: number } = {}) {
  const { lane0, lane1 } = boulevard();
  const net = city();
  const dt = opts.dt ?? 0.05;
  let t = opts.t0 ?? 0;
  let s = opts.s0 ?? 40;
  const a = { x: 0, z: 0, h: 0 };
  const b = { x: 0, z: 0, h: 0 };
  const end = t + seconds;
  while (t < end - 1e-9) {
    t += dt;
    const st = plan(t);
    const kmh = st.kmh ?? 50;
    const v = kmh / 3.6;
    s += v * dt;
    lane0.path.sample(s, a);
    lane1.path.sample(s, b);
    const k = st.lat ?? 0;
    const x = a.x + (b.x - a.x) * k;
    const z = a.z + (b.z - a.z) * k;
    const frame: MonitorFrame = {
      t,
      dt,
      x,
      z,
      heading: a.h,
      speed: v,
      kmh,
      accel: 0,
      latAccel: 0,
      q: net.query(x, z, a.h),
      cornerSurfaces: ['road', 'road', 'road', 'road'],
      signal: st.signal ?? 'none',
      lights: false,
      night: false,
      wet: false,
      brake: 0,
      throttle: 0.3,
      active: true,
      idleSec: 0,
      headYaw: 0,
      reached: st.reached ?? 'none',
      length: 4,
      width: 1.8,
      lead: st.lead ?? null,
      peds: [],
      cars: [],
      horn: false,
      emergency: null,
    };
    mon.update(frame);
  }
  return { t, s };
}

export function newMonitor() {
  return new DrivingMonitor(city(), null);
}

export const kinds = (mon: DrivingMonitor) => mon.events.map((e) => e.kind);

/** Lane index the road query reports at fraction `lat` between the two lanes, `s` metres along. */
export function laneIndexAt(lat: number, s = 200): number {
  const { lane0, lane1 } = boulevard();
  const a = { x: 0, z: 0, h: 0 };
  const b = { x: 0, z: 0, h: 0 };
  lane0.path.sample(s, a);
  lane1.path.sample(s, b);
  return city().query(a.x + (b.x - a.x) * lat, a.z + (b.z - a.z) * lat, a.h).laneIndex;
}
