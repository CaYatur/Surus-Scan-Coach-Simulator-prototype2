import type { TimeOfDay, Weather } from '../world/environment';
import type { CityWorld } from '../world/cityBuilder';
import type { RoadNetwork } from '../world/roadNetwork';
import type { AITraffic, PlayerInfo } from '../traffic/aiTraffic';
import type { Pedestrians } from '../traffic/pedestrians';
import type { SignalController } from '../traffic/signals';
import type { DrivingMonitor } from '../coach/monitor';
import type { Navigator } from './navigator';
import type { MapDef } from '../world/mapDefs';

export type HostPlayer = PlayerInfo & { lane: number; kmh: number; gear: string; handbrake: boolean; brake: number; throttle: number; lights: boolean };

export type MarkerOpts = {
  kind?: 'beacon' | 'bay' | 'ring';
  color?: number;
  radius?: number;
  heading?: number;
  w?: number;
  l?: number;
  label?: string;
};

/** Everything a mission may touch — implemented by the game session. */
export interface MissionHost {
  readonly map: MapDef;
  readonly world: CityWorld;
  readonly net: RoadNetwork;
  readonly traffic: AITraffic;
  readonly peds: Pedestrians;
  readonly signals: SignalController;
  readonly monitor: DrivingMonitor;
  readonly nav: Navigator;
  player(): HostPlayer;
  time(): number;
  toast(text: string, kind?: 'info' | 'good' | 'warn' | 'bad'): void;
  say(text: string): void;
  stimulus(text: string | null): void;
  marker(id: string, x: number, z: number, opts?: MarkerOpts): void;
  clearMarker(id?: string): void;
  navigate(x: number, z: number, name: string): boolean;
  meter(label: string | null, value?: number): void;
}

export type StepResult = 'done' | 'fail' | null;

export type StepCtx = { t: number; data: Record<string, unknown> };

export type Step = {
  title: string;
  hint?: string;
  voice?: string;
  start?(h: MissionHost, c: StepCtx): void;
  update(h: MissionHost, dt: number, c: StepCtx): StepResult;
  end?(h: MissionHost, c: StepCtx): void;
  /** Extra result line (e.g. measured reaction). */
  result?: (c: StepCtx) => string | null;
  failText?: string;
};

export type Constraint = {
  title: string;
  /** Returns false once violated. */
  ok(h: MissionHost): boolean;
  /** Violating fails the whole mission. */
  fatal?: boolean;
};

export type MissionCategory = 'calibration' | 'skill' | 'city';

export type MissionDef = {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  map: 'training' | 'city';
  icon: string;
  difficulty: 1 | 2 | 3;
  minutes: number;
  category: MissionCategory;
  conditions?: { time?: TimeOfDay; weather?: Weather; traffic?: number; peds?: number };
  timeLimit?: number;
  /** Optional fixed start (otherwise map spawn / current position). */
  spawn?: { x: number; z: number; heading: number };
  /** Available from the in-drive mission board (starts from the current position). */
  board?: boolean;
  steps(h: MissionHost): Step[];
  constraints?(h: MissionHost): Constraint[];
  skills: string[];
};

export type ObjectiveView = { title: string; status: 'pending' | 'active' | 'done' | 'failed'; detail?: string };

/** Runs a mission definition step by step. */
export class MissionRunner {
  readonly def: MissionDef;
  private steps: Step[];
  private constraints: Constraint[];
  private cons: boolean[];
  private status: ObjectiveView['status'][];
  private ctx: StepCtx = { t: 0, data: {} };
  index = 0;
  elapsed = 0;
  state: 'running' | 'success' | 'failed' = 'running';
  failReason = '';
  results: string[] = [];
  private host: MissionHost;

  constructor(def: MissionDef, host: MissionHost) {
    this.def = def;
    this.host = host;
    this.steps = def.steps(host);
    this.constraints = def.constraints?.(host) ?? [];
    this.cons = this.constraints.map(() => true);
    this.status = this.steps.map(() => 'pending');
    this.begin(0);
  }

  private begin(i: number) {
    this.index = i;
    if (i >= this.steps.length) return;
    this.status[i] = 'active';
    this.ctx = { t: 0, data: {} };
    const s = this.steps[i];
    s.start?.(this.host, this.ctx);
    this.host.toast(s.title, 'info');
    this.host.say(s.voice ?? s.title);
  }

  update(dt: number) {
    if (this.state !== 'running') return;
    this.elapsed += dt;
    this.constraints.forEach((c, i) => {
      if (this.cons[i] && !c.ok(this.host)) {
        this.cons[i] = false;
        this.host.toast(`Koşul bozuldu: ${c.title}`, 'bad');
        if (c.fatal) this.fail(c.title);
      }
    });
    if (this.state !== 'running') return;
    if (this.def.timeLimit && this.elapsed > this.def.timeLimit) {
      this.fail('Süre doldu');
      return;
    }
    const s = this.steps[this.index];
    if (!s) return;
    this.ctx.t += dt;
    const r = s.update(this.host, dt, this.ctx);
    if (r === 'done') {
      this.status[this.index] = 'done';
      s.end?.(this.host, this.ctx);
      const line = s.result?.(this.ctx);
      if (line) this.results.push(line);
      this.host.toast(`✓ ${s.title}`, 'good');
      if (this.index + 1 >= this.steps.length) {
        this.state = 'success';
        this.host.clearMarker();
        this.host.nav.clear();
        this.host.say('Görev tamamlandı');
      } else this.begin(this.index + 1);
    } else if (r === 'fail') {
      this.status[this.index] = 'failed';
      s.end?.(this.host, this.ctx);
      this.fail(s.failText ?? s.title);
    }
  }

  fail(reason: string) {
    if (this.state !== 'running') return;
    this.state = 'failed';
    this.failReason = reason;
    if (this.status[this.index] === 'active') this.status[this.index] = 'failed';
    this.host.clearMarker();
    this.host.stimulus(null);
    this.host.meter(null);
    this.host.say('Görev başarısız');
  }

  get current(): Step | null {
    return this.steps[this.index] ?? null;
  }

  objectives(): ObjectiveView[] {
    const list: ObjectiveView[] = this.steps.map((s, i) => ({ title: s.title, status: this.status[i] }));
    this.constraints.forEach((c, i) => list.push({ title: c.title, status: this.cons[i] ? (this.state === 'success' ? 'done' : 'active') : 'failed', detail: 'koşul' }));
    return list;
  }

  counts() {
    const obs = this.objectives();
    return { total: obs.length, done: obs.filter((o) => o.status === 'done').length, failed: obs.filter((o) => o.status === 'failed').length };
  }

  get hint(): string {
    return this.current?.hint ?? '';
  }
}
