import { angleDiff } from '../core/math';
import type { GlanceTarget } from '../input/input';
import type { RoadNetwork, RoadQuery, RoadNode, Dir4, Lane } from '../world/roadNetwork';
import type { SignalController } from '../traffic/signals';
import type { AICar } from '../traffic/aiTraffic';
import type { Pedestrian } from '../traffic/pedestrians';
import { ScanTracker } from './scan';
import { EVENT_META, type CoachEvent, type EventKind, type Severity } from './types';

export type MonitorFrame = {
  t: number;
  dt: number;
  x: number;
  z: number;
  heading: number;
  speed: number;
  kmh: number;
  accel: number;
  latAccel: number;
  q: RoadQuery;
  cornerSurfaces: string[];
  signal: 'none' | 'left' | 'right';
  lights: boolean;
  night: boolean;
  wet: boolean;
  brake: number;
  throttle: number;
  active: boolean;
  idleSec: number;
  headYaw: number;
  reached: GlanceTarget;
  length: number;
  width: number;
  lead: { gap: number; relSpeed: number } | null;
  peds: Pedestrian[];
  cars: AICar[];
};

export type ManeuverStats = { total: number; signaled: number; mirror: number; shoulder: number };

export type MonitorStats = {
  distance: number;
  movingTime: number;
  overTime: number;
  overSevereTime: number;
  overIntegral: number;
  wrongWayTime: number;
  sidewalkTime: number;
  offroadTime: number;
  followTime: number;
  headwayBelow2: number;
  headwayBelow1: number;
  minHeadway: number;
  minTTC: number;
  turns: ManeuverStats;
  laneChanges: ManeuverStats;
  stopSigns: { total: number; full: number };
  signalsPassed: number;
  redLights: number;
  junctionScans: { total: number; ok: number };
  pedConflicts: number;
  pedYielded: number;
  reactionTimes: number[];
  collisions: { vehicle: number; static: number; pedestrian: number; hard: number };
  nearMiss: number;
  hardBrake: number;
  hardAccel: number;
  harshCorner: number;
  resets: number;
  reroutes: number;
  nightNoLightsTime: number;
  idleGaps: number;
  signalOnTime: number;
};

function emptyStats(): MonitorStats {
  const m = (): ManeuverStats => ({ total: 0, signaled: 0, mirror: 0, shoulder: 0 });
  return {
    distance: 0,
    movingTime: 0,
    overTime: 0,
    overSevereTime: 0,
    overIntegral: 0,
    wrongWayTime: 0,
    sidewalkTime: 0,
    offroadTime: 0,
    followTime: 0,
    headwayBelow2: 0,
    headwayBelow1: 0,
    minHeadway: Infinity,
    minTTC: Infinity,
    turns: m(),
    laneChanges: m(),
    stopSigns: { total: 0, full: 0 },
    signalsPassed: 0,
    redLights: 0,
    junctionScans: { total: 0, ok: 0 },
    pedConflicts: 0,
    pedYielded: 0,
    reactionTimes: [],
    collisions: { vehicle: 0, static: 0, pedestrian: 0, hard: 0 },
    nearMiss: 0,
    hardBrake: 0,
    hardAccel: 0,
    harshCorner: 0,
    resets: 0,
    reroutes: 0,
    nightNoLightsTime: 0,
    idleGaps: 0,
    signalOnTime: 0,
  };
}

type Approach = {
  node: RoadNode;
  arm: Dir4;
  lane: Lane;
  minKmh: number;
  yellowShouldStop: boolean;
  passed: boolean;
};

type JunctionEntry = {
  node: RoadNode;
  arm: Dir4 | null;
  t: number;
  heading: number;
  laneIndex: number;
  lanesInDir: number;
  signalSide: 'none' | 'left' | 'right';
  signalSince: number;
  mirrorL: boolean;
  mirrorR: boolean;
};

/** Watches the drive every frame and turns it into coaching events + statistics. */
export class DrivingMonitor {
  readonly scan = new ScanTracker();
  events: CoachEvent[] = [];
  stats: MonitorStats = emptyStats();
  onEvent: ((e: CoachEvent) => void) | null = null;
  lastTurn: { side: 'left' | 'right'; t: number; signaled: boolean; mirror: boolean; node: number } | null = null;
  lastLaneChange: { side: 'left' | 'right'; t: number; signaled: boolean; mirror: boolean; shoulder: boolean } | null = null;
  lastStopLine: { t: number; control: string; minKmh: number; node: number } | null = null;
  /** Signal lead times (s) before manoeuvres — part of the style fingerprint. */
  signalLeads: number[] = [];
  private net: RoadNetwork;
  private signals: SignalController | null;
  private cool = new Map<string, number>();
  private t = 0;
  // state
  private lane: { edge: number; dir: number; index: number; since: number } | null = null;
  private laneChangeT = -99;
  /** When we entered the current edge (lane settling after a junction is not a lane change). */
  private edgeEnterT = -99;
  private signalState: { side: 'none' | 'left' | 'right'; since: number; maneuverDone: boolean; doneT: number } = { side: 'none', since: 0, maneuverDone: false, doneT: 0 };
  private lastRoadLane = { index: -1, lanes: 1, t: -99 };
  private approach: Approach | null = null;
  private junction: JunctionEntry | null = null;
  private lastQ: RoadQuery | null = null;
  private speeding: { start: number; max: number; active: boolean; below: number } = { start: 0, max: 0, active: false, below: 0 };
  private wrongWayT = 0;
  private hardBrakeT = 0;
  private hardAccelT = 0;
  private cornerT = 0;
  private tailT = 0;
  private straddleT = 0;
  private noLightsT = 0;
  private surfaceT = 0;
  private reaction: { start: number; label: string } | null = null;
  private reactionEndT = -99;
  private yieldedPeds = new Set<number>();
  private conflictPeds = new Set<number>();
  private lastImpactT = -99;
  private recentKmh: { t: number; kmh: number; x: number; z: number }[] = [];

  constructor(net: RoadNetwork, signals: SignalController | null) {
    this.net = net;
    this.signals = signals;
  }

  reset() {
    this.events = [];
    this.stats = emptyStats();
    this.scan.reset();
    this.cool.clear();
    this.t = 0;
    this.lane = null;
    this.approach = null;
    this.junction = null;
    this.lastQ = null;
    this.speeding = { start: 0, max: 0, active: false, below: 0 };
    this.signalState = { side: 'none', since: 0, maneuverDone: false, doneT: 0 };
    this.reaction = null;
    this.yieldedPeds.clear();
    this.conflictPeds.clear();
    this.recentKmh = [];
    this.lastTurn = null;
    this.lastLaneChange = null;
    this.lastStopLine = null;
    this.signalLeads = [];
  }

  emit(kind: EventKind, x: number, z: number, message?: string, value?: number, severity?: Severity, cooldownKey?: string, cooldown = 0) {
    const key = cooldownKey ?? kind;
    if (cooldown > 0) {
      const last = this.cool.get(key) ?? -999;
      if (this.t - last < cooldown) return;
      this.cool.set(key, this.t);
    }
    const meta = EVENT_META[kind];
    const ev: CoachEvent = {
      kind,
      t: this.t,
      x,
      z,
      severity: severity ?? meta.severity,
      component: meta.component,
      message: message ?? meta.label,
      value,
    };
    this.events.push(ev);
    this.onEvent?.(ev);
  }

  /** Start measuring perception–reaction time (stimulus shown now). */
  startReaction(label: string) {
    this.reaction = { start: this.t, label };
  }

  get reactionPending() {
    return !!this.reaction;
  }

  registerImpact(kind: 'vehicle' | 'static' | 'pedestrian', impactKmh: number, x: number, z: number, hard: boolean) {
    this.lastImpactT = this.t;
    if (kind === 'pedestrian') {
      this.stats.collisions.pedestrian++;
      this.emit('collision_pedestrian', x, z, `Yayaya çarpma (${Math.round(impactKmh)} km/h)`, impactKmh);
      return;
    }
    if (hard) {
      this.stats.collisions.hard++;
      this.emit('hard_crash', x, z, `Ağır kaza — ${Math.round(impactKmh)} km/h`, impactKmh);
    }
    if (kind === 'vehicle') {
      this.stats.collisions.vehicle++;
      this.emit('collision_vehicle', x, z, `Araçla çarpışma (${Math.round(impactKmh)} km/h)`, impactKmh, impactKmh > 20 ? 'critical' : 'major', 'colv', 1.2);
    } else {
      this.stats.collisions.static++;
      this.emit('collision_static', x, z, `Çarpma (${Math.round(impactKmh)} km/h)`, impactKmh, impactKmh > 25 ? 'major' : 'minor', 'cols', 1.5);
    }
  }

  registerReset(x: number, z: number) {
    this.stats.resets++;
    this.emit('reset', x, z);
  }

  registerReroute(x: number, z: number) {
    this.stats.reroutes++;
    this.emit('reroute', x, z, 'Rotadan sapıldı — yeniden hesaplandı', undefined, 'info', 'reroute', 3);
  }

  update(f: MonitorFrame) {
    this.t = f.t;
    const st = this.stats;
    const moving = f.kmh > 3;
    st.distance += Math.abs(f.speed) * f.dt;
    if (moving) st.movingTime += f.dt;
    this.scan.update(f.t, f.dt, f.reached, f.headYaw, f.kmh > 5);
    this.recentKmh.push({ t: f.t, kmh: f.kmh, x: f.x, z: f.z });
    while (this.recentKmh.length && f.t - this.recentKmh[0].t > 12) this.recentKmh.shift();

    this.trackSignal(f);
    this.trackLanes(f);
    this.trackApproachAndJunction(f);
    this.trackSpeed(f);
    this.trackSurface(f);
    this.trackDynamics(f);
    this.trackFollowing(f);
    this.trackPedestrians(f);
    this.trackAttention(f);
    this.trackReaction(f);
    this.lastQ = f.q;
  }

  // ———————————————————————— signals & lanes ————————————————————————

  private trackSignal(f: MonitorFrame) {
    const s = this.signalState;
    if (f.signal !== s.side) {
      this.signalState = { side: f.signal, since: f.t, maneuverDone: false, doneT: 0 };
      return;
    }
    if (s.side !== 'none') {
      this.stats.signalOnTime += f.dt;
      if (s.maneuverDone && f.t - s.doneT > 7 && f.kmh > 15 && !this.junction) {
        this.emit('signal_left_on', f.x, f.z, 'Sinyal açık kaldı — manevradan sonra kapatın', undefined, undefined, 'sigleft', 30);
      } else if (!s.maneuverDone && f.t - s.since > 25 && f.kmh > 25) {
        this.emit('signal_left_on', f.x, f.z, 'Sinyal uzun süredir açık', undefined, undefined, 'sigleft', 30);
      }
    }
  }

  private signalFor(side: 'left' | 'right', t: number, minLead: number): 'ok' | 'late' | 'none' | 'wrong' {
    const s = this.signalState;
    if (s.side === side) return t - s.since >= minLead ? 'ok' : 'late';
    if (s.side !== 'none') return 'wrong';
    return 'none';
  }

  private trackLanes(f: MonitorFrame) {
    const q = f.q;
    if (q.kind !== 'road' || !q.edge || q.laneIndex < 0) {
      if (q.kind !== 'parking') this.lane = null;
      return;
    }
    this.lastRoadLane = { index: q.laneIndex, lanes: q.edge.spec.lanes, t: f.t };
    const dirLanes = q.edge.oneway !== 0 ? q.edge.spec.lanes : q.edge.spec.lanes;
    const cur = { edge: q.edge.id, dir: q.travelDir, index: q.laneIndex, since: f.t };
    const prev = this.lane;
    this.lane = cur;
    if (!prev || prev.edge !== cur.edge || prev.dir !== cur.dir) {
      if (!prev || prev.edge !== cur.edge) this.edgeEnterT = f.t;
      return;
    }
    if (prev.index === cur.index) {
      this.lane.since = prev.since;
      // straddling the lane line (multi-lane only)
      if (dirLanes >= 2 && q.lane && f.kmh > 15) {
        const center = Math.abs(q.lane.lateral);
        const off = Math.abs(Math.abs(q.lateral) - center);
        if (off > q.lane.width / 2 - 0.3 && f.signal === 'none') {
          this.straddleT += f.dt;
          if (this.straddleT > 4) this.emit('lane_straddle', f.x, f.z, 'İki şerit arasında seyir — şeridinizi seçin', undefined, undefined, 'straddle', 20);
        } else this.straddleT = 0;
      }
      return;
    }
    if (q.wrongWay || f.kmh < 8) return;
    if (f.t - this.laneChangeT < 2) return; // debounce oscillation around the line
    if (f.t - this.edgeEnterT < 3.5 || q.along < 12 || q.edge.length - q.along < 8) return; // settling after a turn
    this.laneChangeT = f.t;
    const side: 'left' | 'right' = cur.index > prev.index ? 'left' : 'right';
    const lc = this.stats.laneChanges;
    lc.total++;
    const sig = this.signalFor(side, f.t, 1.0);
    const mirrorKinds = side === 'left' ? (['mirrorL', 'mirrorRear'] as const) : (['mirrorR', 'mirrorRear'] as const);
    const mirror = this.scan.checked([...mirrorKinds], f.t, 6);
    const shoulder = this.scan.checked([side === 'left' ? 'shoulderL' : 'shoulderR'], f.t, 6);
    if (sig === 'ok' || sig === 'late') lc.signaled++;
    if (mirror) lc.mirror++;
    if (shoulder) lc.shoulder++;
    const sideTr = side === 'left' ? 'sola' : 'sağa';
    if (sig === 'none') this.emit('no_signal_lane', f.x, f.z, `Sinyal vermeden ${sideTr} şerit değiştirdiniz`);
    else if (sig === 'wrong') this.emit('wrong_signal', f.x, f.z, 'Sinyal yönü ile şerit değişimi uyuşmuyor');
    else if (sig === 'late') this.emit('late_signal', f.x, f.z, 'Sinyal çok geç verildi (en az 1–3 sn önce)');
    if (!mirror) this.emit('no_mirror_lane', f.x, f.z, `Şerit değişiminden önce ${side === 'left' ? 'sol' : 'sağ'} ayna kontrolü yok`);
    if (!shoulder) this.emit('no_shoulder_lane', f.x, f.z, 'Kör nokta (omuz) kontrolü yapılmadı');
    if (sig === 'ok' && mirror) this.emit('msm_good', f.x, f.z, shoulder ? 'Mükemmel: Ayna → Sinyal → Omuz → Manevra' : 'İyi: Ayna → Sinyal → Manevra');
    if (this.signalState.side === side) this.signalLeads.push(f.t - this.signalState.since);
    this.lastLaneChange = { side, t: f.t, signaled: sig === 'ok' || sig === 'late', mirror, shoulder };
    if (this.signalState.side === side) {
      this.signalState.maneuverDone = true;
      this.signalState.doneT = f.t;
    }
  }

  // ———————————————————————— junctions ————————————————————————

  private trackApproachAndJunction(f: MonitorFrame) {
    const q = f.q;
    const st = this.stats;
    // Build / update the approach we are on
    if (q.kind === 'road' || q.kind === 'parking') {
      const e = q.edge!;
      const node = q.travelDir === 1 ? e.b : e.a;
      const arm = this.net.armOf(node, e)!;
      const lanes = this.net.incomingLanes(node, arm);
      if (!q.wrongWay && lanes.length && Math.abs(angleDiff(f.heading, lanes[0].heading)) < 1.0) {
        if (!this.approach || this.approach.node !== node || this.approach.arm !== arm) {
          this.approach = { node, arm, lane: lanes[0], minKmh: f.kmh, yellowShouldStop: false, passed: false };
        }
        const a = this.approach;
        // distance from the front bumper to the stop line (in edge coords)
        const stopEdge = q.travelDir === 1 ? a.lane.stopS : e.length - a.lane.stopS;
        const front = q.along + (q.travelDir === 1 ? f.length / 2 : -f.length / 2);
        const dist = (stopEdge - front) * q.travelDir;
        if (dist < 25 && dist > -1) a.minKmh = Math.min(a.minKmh, f.kmh);
        const ctl = node.control[arm];
        if (ctl === 'signal' && this.signals && !a.passed) {
          const s = this.signals.state(node, arm);
          const v = Math.abs(f.speed);
          if (s === 'yellow' && !a.yellowShouldStop && dist > (v * v) / (2 * 4) + v * 0.8 + 1) a.yellowShouldStop = true;
          if (s === 'green') a.yellowShouldStop = false;
        }
        if (!a.passed && dist <= 0 && dist > -4) {
          a.passed = true;
          this.onStopLine(f, a);
        }
      }
    }
    // Junction entry / exit
    if (q.kind === 'junction' && q.node) {
      if (!this.junction || this.junction.node !== q.node) {
        const prev = this.lastQ;
        const arm = prev?.edge ? this.net.armOf(q.node, prev.edge) : null;
        const fresh = f.t - this.lastRoadLane.t < 3;
        const lanesInDir = fresh ? this.lastRoadLane.lanes : 1;
        this.junction = {
          node: q.node,
          arm,
          t: f.t,
          heading: prev?.edge ? (prev.travelDir === 1 ? prev.edge.heading : prev.edge.heading + Math.PI) : f.heading,
          laneIndex: fresh ? this.lastRoadLane.index : -1,
          lanesInDir,
          signalSide: this.signalState.side,
          signalSince: this.signalState.since,
          mirrorL: this.scan.checked(['mirrorL', 'mirrorRear', 'shoulderL'], f.t, 7),
          mirrorR: this.scan.checked(['mirrorR', 'mirrorRear', 'shoulderR'], f.t, 7),
        };
      }
    } else if (this.junction && q.edge && (q.kind === 'road' || q.kind === 'parking')) {
      const j = this.junction;
      this.junction = null;
      if (!j.arm) return;
      const exitHeading = q.travelDir === 1 ? q.edge.heading : q.edge.heading + Math.PI;
      const dh = angleDiff(exitHeading, j.heading);
      if (Math.abs(dh) < 0.5 || Math.abs(dh) > 2.6) return; // straight or U-turn
      const side: 'left' | 'right' = dh > 0 ? 'left' : 'right';
      const tn = st.turns;
      tn.total++;
      const sideTr = side === 'left' ? 'Sola' : 'Sağa';
      const signaled = j.signalSide === side && j.t - j.signalSince > 1.5;
      if (j.signalSide === side) tn.signaled++;
      if (j.signalSide === 'none') this.emit('no_signal_turn', f.x, f.z, `${sideTr} dönüşte sinyal verilmedi`);
      else if (j.signalSide !== side) this.emit('wrong_signal', f.x, f.z, `${sideTr} dönüşte ters sinyal`);
      else if (!signaled) this.emit('late_signal', f.x, f.z, 'Dönüş sinyali geç verildi (kavşaktan ~30 m önce verin)');
      const mirror = side === 'left' ? j.mirrorL : j.mirrorR;
      if (mirror) tn.mirror++;
      else this.emit('no_mirror_turn', f.x, f.z, `${sideTr} dönmeden önce ${side === 'left' ? 'sol' : 'sağ'} ayna kontrolü yapılmadı`);
      if (j.lanesInDir >= 2 && j.laneIndex >= 0) {
        const correct = side === 'right' ? j.laneIndex === 0 : j.laneIndex === j.lanesInDir - 1;
        if (!correct) this.emit('wrong_lane_turn', f.x, f.z, `${sideTr} dönüş için ${side === 'right' ? 'en sağ' : 'en sol'} şeridi kullanın`);
      }
      if (j.signalSide === side) {
        this.signalState.maneuverDone = true;
        this.signalState.doneT = f.t;
        this.signalLeads.push(j.t - j.signalSince);
      }
      this.lastTurn = { side, t: f.t, signaled: j.signalSide === side, mirror, node: j.node.id };
      if (signaled && mirror) this.emit('msm_good', f.x, f.z, `${sideTr} dönüş: ayna + sinyal doğru`);
    }
  }

  private onStopLine(f: MonitorFrame, a: Approach) {
    const ctl = a.node.control[a.arm] ?? 'none';
    const st = this.stats;
    this.lastStopLine = { t: f.t, control: ctl, minKmh: a.minKmh, node: a.node.id };
    if (ctl === 'signal' && this.signals) {
      st.signalsPassed++;
      const s = this.signals.state(a.node, a.arm);
      if (s === 'red' || s === 'redyellow') {
        st.redLights++;
        this.emit('red_light', f.x, f.z, 'Kırmızı ışıkta geçtiniz!');
      } else if (s === 'yellow' && a.yellowShouldStop) {
        this.emit('yellow_risky', f.x, f.z, 'Sarı ışıkta durabilecekken geçtiniz');
      }
    }
    if (ctl === 'stop') {
      st.stopSigns.total++;
      if (a.minKmh < 3) {
        st.stopSigns.full++;
        this.emit('stop_full', f.x, f.z, 'DUR levhasında tam durdunuz');
      } else if (a.minKmh < 12) this.emit('stop_rolling', f.x, f.z, `DUR levhasında tam durmadınız (en düşük ${Math.round(a.minKmh)} km/h)`);
      else this.emit('stop_ignored', f.x, f.z, `DUR levhasını ${Math.round(a.minKmh)} km/h ile geçtiniz`);
    }
    if (ctl === 'stop' || ctl === 'yield' || ctl === 'none') {
      // Junction side scan before entering (only where cross traffic has to be judged)
      if (ctl !== 'none' || a.node.armCount >= 3) {
        const l = this.scan.sideLooked('left', f.t, 6);
        const r = this.scan.sideLooked('right', f.t, 6);
        if (ctl !== 'none') {
          st.junctionScans.total++;
          if (l || r) {
            st.junctionScans.ok++;
            this.emit('junction_scan_ok', f.x, f.z, 'Kavşağa girmeden önce yanlar kontrol edildi', undefined, undefined, 'jscan', 4);
          } else this.emit('junction_no_scan', f.x, f.z, 'Kavşağa girmeden önce sol/sağ kontrol edilmedi');
        }
      }
    }
    if (ctl === 'stop' || ctl === 'yield') {
      // right of way: priority traffic arriving within ~3 s
      for (const c of f.cars) {
        if (!c.lane || c.lane.endNode !== a.node || c.lane.arm === a.arm) continue;
        const pc = a.node.control[c.lane.arm] ?? 'none';
        if (pc !== 'none') continue;
        const rem = c.lane.path.length - c.s;
        if (c.v > 3 && rem / c.v < 3.2) {
          this.emit('yield_fail', f.x, f.z, 'Ana yoldaki araca yol vermediniz');
          break;
        }
      }
    }
  }

  // ———————————————————————— speed / surface / dynamics ————————————————————————

  private trackSpeed(f: MonitorFrame) {
    const st = this.stats;
    const lim = f.q.limit;
    const zone = !!f.q.zoneLabel;
    const tol = zone ? 3 : 6;
    const over = f.kmh - lim;
    if (over > 0) st.overIntegral += over * f.dt;
    if (over > tol) {
      st.overTime += f.dt;
      if (over > 20) st.overSevereTime += f.dt;
    }
    const sp = this.speeding;
    if (over > tol) {
      if (!sp.active) {
        sp.start = sp.start || f.t;
        if (f.t - sp.start > 1.5) {
          sp.active = true;
          sp.max = over;
        }
      } else sp.max = Math.max(sp.max, over);
      sp.below = 0;
    } else {
      if (!sp.active) sp.start = 0;
      if (sp.active) {
        sp.below += f.dt;
        if (sp.below > 1.0) {
          const sev: Severity = sp.max > 30 ? 'critical' : sp.max > 15 ? 'major' : 'minor';
          const dur = f.t - sp.start;
          this.emit('speeding', f.x, f.z, `${zone ? 'Okul bölgesinde ' : ''}hız sınırı ${Math.round(sp.max)} km/h aşıldı (${dur.toFixed(0)} sn)`, sp.max, zone && sev === 'minor' ? 'major' : sev);
          this.speeding = { start: 0, max: 0, active: false, below: 0 };
        }
      }
    }
    // wrong way
    if (f.q.wrongWay && f.kmh > 5) {
      this.wrongWayT += f.dt;
      st.wrongWayTime += f.dt;
      if (this.wrongWayT > 0.8) this.emit('wrong_way', f.x, f.z, 'Ters yöndesiniz! Hemen güvenli şekilde düzeltin', undefined, undefined, 'wrongway', 8);
    } else this.wrongWayT = 0;
    // headlights at night
    if (f.night && !f.lights && f.kmh > 5) {
      this.noLightsT += f.dt;
      st.nightNoLightsTime += f.dt;
      if (this.noLightsT > 5) this.emit('no_headlights', f.x, f.z, 'Karanlıkta farlar kapalı (L)', undefined, undefined, 'lights', 45);
    } else this.noLightsT = 0;
  }

  private trackSurface(f: MonitorFrame) {
    const st = this.stats;
    const bad = f.cornerSurfaces.find((s) => s === 'sidewalk' || s === 'median') ?? (f.q.kind === 'offroad' ? 'offroad' : null);
    if (bad && f.kmh > 1) {
      this.surfaceT += f.dt;
      if (bad === 'sidewalk' || bad === 'median') st.sidewalkTime += f.dt;
      else st.offroadTime += f.dt;
      if (this.surfaceT > 0.25) {
        if (bad === 'sidewalk') this.emit('sidewalk', f.x, f.z, 'Kaldırıma çıktınız', undefined, undefined, 'surface', 6);
        else if (bad === 'median') this.emit('median', f.x, f.z, 'Refüje çıktınız', undefined, undefined, 'surface', 6);
        else this.emit('offroad', f.x, f.z, 'Yol dışına çıktınız', undefined, undefined, 'surface', 6);
      }
    } else this.surfaceT = 0;
  }

  private trackDynamics(f: MonitorFrame) {
    const st = this.stats;
    const recentImpact = f.t - this.lastImpactT < 0.8;
    if (recentImpact) return;
    // an emergency stop requested by a reaction test is not a smoothness fault
    const inReaction = !!this.reaction || f.t - this.reactionEndT < 4;
    if (f.accel < -4.3 && f.kmh > 5 && !inReaction) {
      this.hardBrakeT += f.dt;
      if (this.hardBrakeT > 0.25 && (this.cool.get('hb') ?? -99) < f.t - 2.5) {
        st.hardBrake++;
        const severe = f.accel < -6.5;
        const mirror = this.scan.checked(['mirrorRear', 'mirrorL', 'mirrorR'], f.t, 5);
        const extra = mirror ? '' : ' — öncesinde dikiz aynası kontrolü yok';
        this.emit('hard_brake', f.x, f.z, `Sert fren (${(-f.accel / 9.81).toFixed(2)} g)${extra}`, -f.accel, severe ? 'major' : 'minor', 'hb', 2.5);
      }
    } else this.hardBrakeT = 0;
    if (f.accel > 3.3 && f.kmh > 8) {
      this.hardAccelT += f.dt;
      if (this.hardAccelT > 0.6) {
        st.hardAccel += (this.cool.get('ha') ?? -99) < f.t - 3 ? 1 : 0;
        this.emit('hard_accel', f.x, f.z, `Sert hızlanma (${(f.accel / 9.81).toFixed(2)} g)`, f.accel, undefined, 'ha', 3);
      }
    } else this.hardAccelT = 0;
    if (Math.abs(f.latAccel) > 4.5 && f.kmh > 15) {
      this.cornerT += f.dt;
      if (this.cornerT > 0.4) {
        st.harshCorner += (this.cool.get('hc') ?? -99) < f.t - 3 ? 1 : 0;
        this.emit('harsh_corner', f.x, f.z, `Virajı hızlı aldınız (${(Math.abs(f.latAccel) / 9.81).toFixed(2)} g yanal)`, Math.abs(f.latAccel), undefined, 'hc', 3);
      }
    } else this.cornerT = 0;
  }

  private trackFollowing(f: MonitorFrame) {
    const st = this.stats;
    const lead = f.lead;
    if (!lead || f.kmh < 15 || lead.gap > 60) {
      this.tailT = 0;
      return;
    }
    const v = Math.abs(f.speed);
    const headway = lead.gap / Math.max(0.1, v);
    st.followTime += f.dt;
    st.minHeadway = Math.min(st.minHeadway, headway);
    if (headway < 2) st.headwayBelow2 += f.dt;
    if (headway < 1) st.headwayBelow1 += f.dt;
    const limit = f.wet ? 2.0 : 1.2;
    if (headway < limit) {
      this.tailT += f.dt;
      if (this.tailT > 3) this.emit('tailgating', f.x, f.z, `Takip mesafesi ${headway.toFixed(1)} sn — en az ${f.wet ? 4 : 2} sn olmalı`, headway, headway < 0.7 ? 'major' : 'minor', 'tail', 12);
    } else this.tailT = 0;
    if (lead.relSpeed > 0.5) {
      const ttc = lead.gap / lead.relSpeed;
      st.minTTC = Math.min(st.minTTC, ttc);
      if (ttc < 1.6) {
        const before = (this.cool.get('ttc') ?? -99) < f.t - 6;
        if (before) st.nearMiss++;
        this.emit('near_miss', f.x, f.z, `Ramak kala! Çarpışmaya ${ttc.toFixed(1)} sn`, ttc, ttc < 0.9 ? 'critical' : 'major', 'ttc', 6);
      }
    }
  }

  private trackPedestrians(f: MonitorFrame) {
    if (!f.peds.length) return;
    const fx = Math.sin(f.heading);
    const fz = Math.cos(f.heading);
    for (const p of f.peds) {
      const dx = p.x - f.x;
      const dz = p.z - f.z;
      const along = dx * fx + dz * fz;
      const lat = -dx * fz + dz * fx;
      if (along > 0 && along < 16 && Math.abs(lat) < 3) {
        if (f.kmh < 2 && !this.yieldedPeds.has(p.id)) {
          this.yieldedPeds.add(p.id);
          this.stats.pedYielded++;
          this.emit('ped_yielded', f.x, f.z, 'Yayaya yol verdiniz');
        }
      }
      if (along > 0 && along < f.length / 2 + 2.5 && Math.abs(lat) < f.width / 2 + 1.1 && f.kmh > 4 && !this.conflictPeds.has(p.id)) {
        this.conflictPeds.add(p.id);
        this.stats.pedConflicts++;
        this.emit('ped_not_yielded', f.x, f.z, 'Karşıya geçen yayaya yol vermediniz!');
      }
    }
  }

  private trackAttention(f: MonitorFrame) {
    if (f.kmh > 20 && this.scan.secondsSinceAny(f.t) > 28 && f.t > 30) {
      this.emit('mirror_neglect', f.x, f.z, 'Uzun süredir aynalara bakmadınız (5–8 sn\'de bir dikiz)', undefined, undefined, 'neglect', 30);
    }
    if (f.kmh > 10 && f.idleSec > 5) {
      if ((this.cool.get('idle') ?? -99) < f.t - 15) this.stats.idleGaps++;
      this.emit('idle_attention', f.x, f.z, 'Uzun süre kontrollere dokunulmadı (dikkat proxy)', undefined, undefined, 'idle', 15);
    }
  }

  private trackReaction(f: MonitorFrame) {
    const r = this.reaction;
    if (!r) return;
    const dt = f.t - r.start;
    if (f.brake > 0.3) {
      this.stats.reactionTimes.push(dt);
      const verdict = dt < 0.8 ? 'çok iyi' : dt < 1.2 ? 'iyi' : dt < 1.6 ? 'orta' : 'yavaş';
      this.reactionEndT = f.t;
      this.emit('reaction', f.x, f.z, `${r.label}: tepki süresi ${dt.toFixed(2)} sn (${verdict})`, dt, dt < 1.2 ? 'positive' : dt < 1.6 ? 'info' : 'minor');
      this.reaction = null;
    } else if (dt > 4) {
      this.stats.reactionTimes.push(4);
      this.emit('reaction', f.x, f.z, `${r.label}: tepki yok (4 sn+)`, 4, 'major');
      this.reaction = null;
    }
  }

  /** Count of events of a kind. */
  count(kind: EventKind): number {
    let n = 0;
    for (const e of this.events) if (e.kind === kind) n++;
    return n;
  }
}
