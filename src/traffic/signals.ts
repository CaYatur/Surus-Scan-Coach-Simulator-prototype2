import type { RoadNetwork, RoadNode, Dir4 } from '../world/roadNetwork';
import type { SignalLights, SignalState } from '../world/cityBuilder';
import { mulberry32 } from '../core/math';

type Plan = {
  node: RoadNode;
  cycle: number;
  offset: number;
  nsGreen: number;
  ewGreen: number;
};

const YELLOW = 3;
const ALL_RED = 1.8;
const RED_YELLOW = 1.2;

/** Fixed-time two-phase signal controllers for every signalised junction. */
export class SignalController {
  private plans = new Map<number, Plan>();
  private t = 0;
  private lights: SignalLights;
  private lastState = new Map<string, SignalState>();
  /** Forced states for scripted scenarios (reaction tests). */
  private overrides = new Map<string, SignalState>();

  constructor(net: RoadNetwork, lights: SignalLights) {
    this.lights = lights;
    const rng = mulberry32(net.map.seed ^ 0x5a5a);
    for (const n of net.nodes) {
      if (!n.signalized) continue;
      const nsMajor = (n.arms.N?.spec.rank ?? 0) + (n.arms.S?.spec.rank ?? 0) >= (n.arms.E?.spec.rank ?? 0) + (n.arms.W?.spec.rank ?? 0);
      const nsGreen = nsMajor ? 22 + rng() * 8 : 14 + rng() * 6;
      const ewGreen = nsMajor ? 14 + rng() * 6 : 22 + rng() * 8;
      const cycle = nsGreen + ewGreen + 2 * (YELLOW + ALL_RED + RED_YELLOW);
      this.plans.set(n.id, { node: n, cycle, offset: rng() * cycle, nsGreen, ewGreen });
    }
    this.update(0);
  }

  /** State for traffic arriving from arm `d` at node `n`. */
  state(n: RoadNode, d: Dir4): SignalState {
    const o = this.overrides.get(`${n.id}:${d}`);
    if (o) return o;
    const p = this.plans.get(n.id);
    if (!p) return 'off';
    const ns = d === 'N' || d === 'S';
    const t = (this.t + p.offset) % p.cycle;
    // Phase layout: NS green | NS yellow | all red | EW red-yellow | EW green | EW yellow | all red | NS red-yellow
    const a = p.nsGreen;
    const b = a + YELLOW;
    const c = b + ALL_RED;
    const d2 = c + RED_YELLOW;
    const e = d2 + p.ewGreen;
    const f = e + YELLOW;
    const g = f + ALL_RED;
    if (ns) {
      if (t < a) return 'green';
      if (t < b) return 'yellow';
      if (t < g) return 'red';
      return 'redyellow';
    }
    if (t < c) return 'red';
    if (t < d2) return 'redyellow';
    if (t < e) return 'green';
    if (t < f) return 'yellow';
    return 'red';
  }

  /** Seconds until this approach turns green (0 if green now). */
  timeToGreen(n: RoadNode, d: Dir4): number {
    const p = this.plans.get(n.id);
    if (!p) return 0;
    for (let dt = 0; dt < p.cycle; dt += 0.5) {
      const saved = this.t;
      this.t += dt;
      const s = this.state(n, d);
      this.t = saved;
      if (s === 'green') return dt;
    }
    return 0;
  }

  /** Is the pedestrian crossing across arm `d` currently allowed to walk? */
  pedestrianWalk(n: RoadNode, d: Dir4): boolean {
    if (!n.signalized) return true;
    // Walking across the N/S arms means crossing the ns road: allowed while EW traffic has green.
    const cross: Dir4 = d === 'N' || d === 'S' ? 'E' : 'N';
    const other: Dir4 = cross === 'E' ? (n.arms.E ? 'E' : 'W') : n.arms.N ? 'N' : 'S';
    return this.state(n, other) === 'green';
  }

  override(n: RoadNode, d: Dir4, s: SignalState | null) {
    const k = `${n.id}:${d}`;
    if (s) this.overrides.set(k, s);
    else this.overrides.delete(k);
  }

  update(dt: number) {
    this.t += dt;
    for (const p of this.plans.values()) {
      for (const d of ['N', 'S', 'E', 'W'] as Dir4[]) {
        if (!p.node.arms[d]) continue;
        const s = this.state(p.node, d);
        const k = `${p.node.id}:${d}`;
        if (this.lastState.get(k) !== s) {
          this.lastState.set(k, s);
          this.lights.set(p.node.id, d, s);
        }
      }
    }
  }
}
